package expandopenapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

type mediaOutput struct {
	Index      int
	MediaType  string
	ResourceID string
}

const missingResourceGracePeriod = 30 * time.Second

func (m *Manager) materializeReadyTasks() {
	m.deliveryMu.Lock()
	defer m.deliveryMu.Unlock()
	records, err := m.journal.activeOperations()
	if err != nil {
		return
	}
	for index := range records {
		record := &records[index]
		task, err := m.host.Task(record.UserID, record.TaskID)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) && time.Since(record.CreatedAt) >= 30*time.Second {
				_ = m.journal.markUnknown(record.ID, record.TaskID)
				_ = m.journal.failDelivery(record.ID, "operation_task_missing")
			} else {
				_ = m.journal.deferDelivery(record.ID, 5*time.Second)
			}
			continue
		}
		if record.DeliveryState != "pending" {
			newerRun := task.RouteRun > record.DeliveryRouteRun
			newerRecoverableState := task.Status != model.TaskStatusFailed && task.Status != model.TaskStatusCancelled && task.UpdatedAt.After(record.DeliveryTaskUpdatedAt)
			if newerRun || newerRecoverableState {
				_ = m.journal.resetDeliveryRecord(record.ID)
				record.DeliveryState = "pending"
			} else {
				_ = m.journal.deferDelivery(record.ID, 30*time.Second)
				continue
			}
		}
		if task.Status == model.TaskStatusFailed || task.Status == model.TaskStatusCancelled {
			_ = m.journal.completeDeliveryForTask(record.ID, task)
			continue
		}
		if task.Status != model.TaskStatusSucceeded {
			_ = m.journal.deferDelivery(record.ID, 2*time.Second)
			continue
		}
		outputs, err := mediaOutputs(*task)
		if err != nil {
			_ = m.journal.scheduleDelivery(record.ID, 5*time.Second, task)
			continue
		}
		_ = m.journal.setExpectedOutputs(record.ID, len(outputs))
		record.ExpectedOutputs = len(outputs)
		for _, output := range outputs {
			m.materializeOutput(record, task, output)
		}
		persisted, err := m.journal.outputs(record.ID)
		if err != nil || len(persisted) < len(outputs) {
			_ = m.journal.deferDelivery(record.ID, 5*time.Second)
			continue
		}
		allBound := true
		allTerminal := true
		failureCode := ""
		for _, output := range persisted {
			switch output.State {
			case outputUnavailable:
				allBound = false
				if failureCode == "" {
					failureCode = output.ErrorCode
				}
			case outputBound:
				if _, err := m.host.UserAsset(record.UserID, output.AssetID); errors.Is(err, gorm.ErrRecordNotFound) {
					m.markOutputUnavailable(output.ID, "asset_deleted")
					allBound = false
					if failureCode == "" {
						failureCode = "asset_deleted"
					}
				} else if err != nil {
					allBound = false
					allTerminal = false
				}
			default:
				allBound = false
				allTerminal = false
			}
		}
		if failureCode == "" && !allBound && allTerminal {
			failureCode = "materialization_failed"
		}
		if failureCode != "" && allTerminal {
			_ = m.journal.failDeliveryForTask(record.ID, failureCode, task)
		} else if allBound {
			_ = m.journal.completeDeliveryForTask(record.ID, task)
		} else {
			_ = m.journal.deferDelivery(record.ID, 5*time.Second)
		}
	}
}

func (m *Manager) materializeOutput(operation *operationRecord, task *model.Task, output mediaOutput) {
	if output.ResourceID == "" {
		m.recordUnavailableOutput(operation, task, output, "resource_missing")
		return
	}
	assetID := generatedAssetID(task.ID, output.Index)
	now := time.Now().UTC()
	record := outputRecord{
		ID: operation.ID + "-" + fmt.Sprint(output.Index), OperationID: operation.ID,
		OutputIndex: output.Index, MediaType: output.MediaType, ResourceID: output.ResourceID,
		AssetID: assetID, State: outputPrepared, CreatedAt: now, UpdatedAt: now,
	}
	result := m.journal.db.Where("operation_id = ? AND output_index = ?", operation.ID, output.Index).FirstOrCreate(&record)
	if result.Error != nil {
		return
	}
	if record.State == outputBound || record.State == outputUnavailable {
		return
	}
	resource, err := m.host.Resource(task.UserID, output.ResourceID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		if time.Since(record.CreatedAt) >= missingResourceGracePeriod {
			m.markOutputUnavailable(record.ID, "resource_missing")
		}
		return
	}
	if err != nil || resource.Status == model.ResourceStatusPending {
		// No host write was attempted, so a later pass may safely retry this read.
		return
	}
	if resource.Status != model.ResourceStatusReady {
		m.markOutputUnavailable(record.ID, "resource_unavailable")
		return
	}
	if existing, err := m.host.UserAsset(task.UserID, assetID); err == nil {
		if validGeneratedAsset(existing, task.ID, output) {
			m.markOutputBound(record.ID)
		} else {
			m.markOutputUnavailable(record.ID, "asset_identity_conflict")
		}
		return
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		// The read did not establish whether an asset exists, and no write was
		// attempted, so leave the prepared record eligible for a later retry.
		return
	}
	// Only an attempted write is ambiguous after a crash. A merely prepared
	// record is safe to resume because no host write has started yet.
	if record.State == outputAttempted {
		m.markOutputUnavailable(record.ID, "asset_write_unknown")
		return
	}
	payload, err := generatedAssetPayload(assetID, task, output, resource, now)
	if err != nil {
		m.markOutputUnavailable(record.ID, "asset_payload_invalid")
		return
	}
	if err := m.journal.db.Model(&outputRecord{}).Where("id = ? AND state = ?", record.ID, outputPrepared).Update("state", outputAttempted).Error; err != nil {
		return
	}
	if _, err := m.host.UpsertUserAsset(task.UserID, payload); err != nil {
		// The host may have committed the asset before the response was lost.
		// Keep the persisted write intent and reconcile by ID on the next pass.
		return
	}
	m.markOutputBound(record.ID)
}

func (m *Manager) recordUnavailableOutput(operation *operationRecord, task *model.Task, output mediaOutput, code string) {
	now := time.Now().UTC()
	record := outputRecord{
		ID: operation.ID + "-" + fmt.Sprint(output.Index), OperationID: operation.ID,
		OutputIndex: output.Index, MediaType: output.MediaType, ResourceID: output.ResourceID,
		AssetID: generatedAssetID(task.ID, output.Index), State: outputUnavailable,
		ErrorCode: code, CreatedAt: now, UpdatedAt: now,
	}
	_ = m.journal.db.Where("operation_id = ? AND output_index = ?", operation.ID, output.Index).FirstOrCreate(&record).Error
}

func (m *Manager) markOutputBound(id string) {
	_ = m.journal.db.Model(&outputRecord{}).Where("id = ?", id).Updates(map[string]any{
		"state": outputBound, "error_code": "", "updated_at": time.Now().UTC(),
	}).Error
}

func (m *Manager) markOutputUnavailable(id, code string) {
	_ = m.journal.db.Model(&outputRecord{}).Where("id = ?", id).Updates(map[string]any{
		"state": outputUnavailable, "error_code": code, "updated_at": time.Now().UTC(),
	}).Error
}

func mediaOutputs(task model.Task) ([]mediaOutput, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(task.ResultJSON), &payload); err != nil {
		return nil, err
	}
	mediaType := "image"
	if mode := strings.ToLower(strings.TrimSpace(stringValue(payload["mode"]))); mode == "image" || mode == "video" || mode == "audio" {
		mediaType = mode
	} else if strings.Contains(strings.ToLower(task.Type), "video") {
		mediaType = "video"
	} else if strings.Contains(strings.ToLower(task.Type), "audio") {
		mediaType = "audio"
	}
	values := mediaValues(payload, mediaType)
	if len(values) == 0 {
		return nil, errors.New("task result has no persisted media")
	}
	outputs := make([]mediaOutput, 0, len(values))
	for index, value := range values {
		resourceID := resultResourceID(value)
		outputs = append(outputs, mediaOutput{Index: index, MediaType: mediaType, ResourceID: resourceID})
	}
	return outputs, nil
}

func mediaValues(payload map[string]any, mediaType string) []any {
	plural := mediaType + "s"
	if mediaType == "image" {
		plural = "images"
	}
	if values, ok := payload[plural].([]any); ok {
		return values
	}
	if value, ok := payload[mediaType]; ok {
		if values, ok := value.([]any); ok {
			return values
		}
		return []any{value}
	}
	return nil
}

func resultResourceID(value any) string {
	item, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	for _, key := range []string{"resourceId", "storageKey", "url", "dataUrl"} {
		raw := strings.TrimSpace(stringValue(item[key]))
		if key == "resourceId" && raw != "" {
			return raw
		}
		if strings.HasPrefix(raw, "resource:") {
			return strings.TrimSpace(strings.TrimPrefix(raw, "resource:"))
		}
		parsed, err := url.Parse(raw)
		if err != nil {
			continue
		}
		parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
		for index := range parts {
			if parts[index] == "resources" && index+2 < len(parts) && parts[index+2] == "file" {
				return parts[index+1]
			}
		}
	}
	return ""
}

func generatedAssetID(taskID string, outputIndex int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("materialize:%s:%d", taskID, outputIndex)))
	return "generation_" + hex.EncodeToString(sum[:])
}

func generatedAssetPayload(assetID string, task *model.Task, output mediaOutput, resource *model.Resource, now time.Time) (json.RawMessage, error) {
	fileURL := "/api/resources/" + resource.ID + "/file"
	data := map[string]any{
		"storageKey": "resource:" + resource.ID, "mimeType": resource.MimeType,
		"bytes": resource.Size, "width": resource.Width, "height": resource.Height,
		"durationMs": resource.DurationMs,
	}
	if output.MediaType == "image" {
		data["dataUrl"] = fileURL
	} else {
		data["url"] = fileURL
	}
	title := map[string]string{"image": "生成图片", "video": "生成视频", "audio": "生成音频"}[output.MediaType]
	metadata := map[string]any{
		"source": "generation-task", "generationEffectKey": fmt.Sprintf("materialize:%s:%d", task.ID, output.Index),
		"taskId": task.ID, "outputIndex": output.Index,
	}
	if task.ProjectID != "" {
		metadata["projectIds"] = []string{task.ProjectID}
	}
	return json.Marshal(map[string]any{
		"id": assetID, "kind": output.MediaType, "category": model.AssetCategoryMaterial,
		"status": model.AssetVersionStatusConfirmed, "source": "生成任务", "title": title,
		"coverUrl": fileURL, "tags": []string{"生成"}, "revision": 1,
		"createdAt": now.Format(time.RFC3339Nano), "updatedAt": now.Format(time.RFC3339Nano),
		"data": data, "metadata": metadata,
	})
}

func validGeneratedAsset(raw json.RawMessage, taskID string, output mediaOutput) bool {
	var payload struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
		Data struct {
			StorageKey string `json:"storageKey"`
		} `json:"data"`
		Metadata struct {
			TaskID      string `json:"taskId"`
			OutputIndex int    `json:"outputIndex"`
		} `json:"metadata"`
	}
	return json.Unmarshal(raw, &payload) == nil && payload.ID == generatedAssetID(taskID, output.Index) &&
		payload.Kind == output.MediaType && payload.Data.StorageKey == "resource:"+output.ResourceID &&
		payload.Metadata.TaskID == taskID && payload.Metadata.OutputIndex == output.Index
}
