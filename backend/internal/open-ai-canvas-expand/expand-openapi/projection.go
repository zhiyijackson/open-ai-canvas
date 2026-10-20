package expandopenapi

import (
	"encoding/json"
	"errors"
	"net/http/httptest"

	"gorm.io/gorm"
)

func (m *Manager) projectTaskResponse(recorder *httptest.ResponseRecorder, operation *operationRecord) {
	var envelope map[string]any
	if json.Unmarshal(recorder.Body.Bytes(), &envelope) != nil {
		return
	}
	data, ok := envelope["data"].(map[string]any)
	if !ok {
		return
	}
	outputs, err := m.journal.outputs(operation.ID)
	if err != nil {
		return
	}
	projectOperationFields(m, data, operation, outputs)
	encoded, err := json.Marshal(envelope)
	if err == nil {
		recorder.Body.Reset()
		_, _ = recorder.Body.Write(encoded)
	}
}

func projectOperationFields(m *Manager, data map[string]any, operation *operationRecord, outputs []outputRecord) {
	data["clientOperationId"] = operation.ClientOperationID
	projected := projectedOutputs(m, operation, outputs)
	data["outputs"] = projected
	data["outputCount"] = operation.ExpectedOutputs
	if operation.DeliveryState == "complete" && operation.ExpectedOutputs == 0 {
		data["assetRegistrationState"] = "none"
		return
	}
	if operation.ExpectedOutputs <= 0 {
		if operation.DeliveryState == "failed" {
			data["assetRegistrationState"] = "failed"
			data["materializationErrorCode"] = operation.DeliveryErrorCode
			return
		}
		data["assetRegistrationState"] = "pending"
		return
	}
	available := 0
	lookupPending := false
	for _, output := range projected {
		if _, ok := output["materializedAssetId"]; ok {
			available++
		}
		if output["materializationErrorCode"] == "asset_lookup_failed" {
			lookupPending = true
		}
	}
	if operation.DeliveryState == "failed" {
		if available > 0 {
			data["assetRegistrationState"] = "partial"
		} else {
			data["assetRegistrationState"] = "failed"
		}
		data["materializationErrorCode"] = operation.DeliveryErrorCode
		return
	}
	if operation.DeliveryState != "complete" || len(outputs) < operation.ExpectedOutputs {
		data["assetRegistrationState"] = "pending"
		return
	}
	if lookupPending {
		data["assetRegistrationState"] = "pending"
		return
	}
	if available != operation.ExpectedOutputs {
		if available > 0 {
			data["assetRegistrationState"] = "partial"
		} else {
			data["assetRegistrationState"] = "failed"
		}
		return
	}
	data["assetRegistrationVersion"] = 1
	data["assetRegistrationState"] = "complete"
}

func projectedOutputs(m *Manager, operation *operationRecord, outputs []outputRecord) []map[string]any {
	projected := make([]map[string]any, 0, len(outputs))
	for _, output := range outputs {
		item := map[string]any{"outputIndex": output.OutputIndex, "mediaType": output.MediaType, "resourceId": output.ResourceID}
		if output.State == outputBound {
			if _, err := m.host.UserAsset(operation.UserID, output.AssetID); err == nil {
				item["materializedAssetId"] = output.AssetID
			} else if errors.Is(err, gorm.ErrRecordNotFound) {
				item["materializationErrorCode"] = "asset_deleted"
			} else {
				item["materializationErrorCode"] = "asset_lookup_failed"
			}
		}
		if output.ErrorCode != "" {
			item["materializationErrorCode"] = output.ErrorCode
		}
		projected = append(projected, item)
	}
	return projected
}

func (m *Manager) projectWorkbenchTaskList(recorder *httptest.ResponseRecorder, userID string) {
	var envelope map[string]any
	if json.Unmarshal(recorder.Body.Bytes(), &envelope) != nil {
		return
	}
	items, ok := envelope["data"].([]any)
	if !ok {
		return
	}
	for _, value := range items {
		item, ok := value.(map[string]any)
		if !ok {
			continue
		}
		taskID, _ := item["id"].(string)
		operation, err := m.journal.operationByTask(userID, taskID)
		if err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return
			}
			continue
		}
		outputs, err := m.journal.outputs(operation.ID)
		if err != nil {
			return
		}
		projectOperationFields(m, item, operation, outputs)
	}
	if encoded, err := json.Marshal(envelope); err == nil {
		recorder.Body.Reset()
		_, _ = recorder.Body.Write(encoded)
	}
}

func wrapEnvelopeDataAsArray(recorder *httptest.ResponseRecorder) {
	var envelope map[string]any
	if json.Unmarshal(recorder.Body.Bytes(), &envelope) != nil {
		return
	}
	if data, exists := envelope["data"]; exists {
		envelope["data"] = []any{data}
	}
	if encoded, err := json.Marshal(envelope); err == nil {
		recorder.Body.Reset()
		_, _ = recorder.Body.Write(encoded)
	}
}
