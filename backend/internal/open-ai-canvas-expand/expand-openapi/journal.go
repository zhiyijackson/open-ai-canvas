package expandopenapi

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"yingce/backend/internal/database"

	"gorm.io/gorm"
)

const (
	operationCreating = "creating"
	operationBound    = "bound"
	operationRejected = "rejected"
	operationUnknown  = "unknown"

	outputPrepared    = "prepared"
	outputAttempted   = "attempted"
	outputBound       = "bound"
	outputUnavailable = "unavailable"
)

type operationRecord struct {
	ID                string `gorm:"primaryKey;size:48"`
	UserID            string `gorm:"size:36;not null;uniqueIndex:idx_expand_operation_owner_key,priority:1;index"`
	ClientOperationID string `gorm:"size:160;not null;uniqueIndex:idx_expand_operation_owner_key,priority:2"`
	Fingerprint       string `gorm:"size:64;not null"`
	TraceID           string `gorm:"size:96;not null;uniqueIndex"`
	Kind              string `gorm:"size:16;not null"`
	TaskID            string `gorm:"size:36;index"`
	State             string `gorm:"size:24;not null;index"`
	ResponseStatus    int
	ResponseBody      []byte    `gorm:"type:blob"`
	ExpectedOutputs   int       `gorm:"not null;default:0"`
	DeliveryState     string    `gorm:"size:24;not null;default:pending;index"`
	DeliveryAttempts  int       `gorm:"not null;default:0"`
	DeliveryErrorCode string    `gorm:"size:80"`
	NextAttemptAt     time.Time `gorm:"index"`
	CreatedAt         time.Time `gorm:"not null"`
	UpdatedAt         time.Time `gorm:"not null"`
}

type outputRecord struct {
	ID          string    `gorm:"primaryKey;size:80"`
	OperationID string    `gorm:"size:48;not null;uniqueIndex:idx_expand_output_operation_index,priority:1;index"`
	OutputIndex int       `gorm:"not null;uniqueIndex:idx_expand_output_operation_index,priority:2"`
	MediaType   string    `gorm:"size:16;not null"`
	ResourceID  string    `gorm:"size:64;not null"`
	AssetID     string    `gorm:"size:80;not null"`
	State       string    `gorm:"size:24;not null;index"`
	ErrorCode   string    `gorm:"size:80"`
	CreatedAt   time.Time `gorm:"not null"`
	UpdatedAt   time.Time `gorm:"not null"`
}

type journal struct {
	db *gorm.DB
	mu sync.Mutex
}

func openJournal(dataDir string) (*journal, error) {
	addonDir := filepath.Join(dataDir, "open-ai-canvas-expand")
	if err := os.MkdirAll(addonDir, 0o755); err != nil {
		return nil, err
	}
	dsn := filepath.Join(addonDir, "expand.db") + "?_busy_timeout=5000&_journal_mode=WAL&_foreign_keys=on&_synchronous=NORMAL"
	db, err := database.Open(database.Config{Driver: "sqlite", DSN: dsn, DataDir: addonDir})
	if err != nil {
		return nil, err
	}
	if err := database.ConfigurePool(db); err != nil {
		return nil, err
	}
	if err := db.AutoMigrate(&operationRecord{}, &outputRecord{}); err != nil {
		return nil, fmt.Errorf("migrate expand journal: %w", err)
	}
	// Any unbound creating row predates this process. Reissuing it could create
	// a second billable host task, so recovery is deliberately fail-closed.
	if err := db.Model(&operationRecord{}).Where("state = ? AND task_id = ''", operationCreating).Updates(map[string]any{
		"state": operationUnknown, "updated_at": time.Now().UTC(),
	}).Error; err != nil {
		return nil, err
	}
	return &journal{db: db}, nil
}

func (j *journal) close() error {
	if j == nil || j.db == nil {
		return nil
	}
	sqlDB, err := j.db.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

func (j *journal) claim(userID, clientOperationID, fingerprint, kind string) (*operationRecord, bool, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	var existing operationRecord
	err := j.db.Where("user_id = ? AND client_operation_id = ?", userID, clientOperationID).First(&existing).Error
	if err == nil {
		if existing.Fingerprint != fingerprint {
			return nil, false, errOperationConflict
		}
		return &existing, false, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, err
	}
	operationID, err := randomIdentifier("op")
	if err != nil {
		return nil, false, err
	}
	traceID, err := randomIdentifier("expand")
	if err != nil {
		return nil, false, err
	}
	now := time.Now().UTC()
	record := operationRecord{
		ID: operationID, UserID: userID, ClientOperationID: clientOperationID,
		Fingerprint: fingerprint, TraceID: traceID, Kind: kind,
		State: operationCreating, CreatedAt: now, UpdatedAt: now,
		DeliveryState: "pending", NextAttemptAt: now,
	}
	if err := j.db.Create(&record).Error; err != nil {
		return nil, false, err
	}
	return &record, true, nil
}

func (j *journal) bindTask(operationID, userID, taskID string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.db.Transaction(func(tx *gorm.DB) error {
		var record operationRecord
		if err := tx.Where("id = ? AND user_id = ?", operationID, userID).First(&record).Error; err != nil {
			return err
		}
		if record.TaskID != "" && record.TaskID != taskID {
			return errors.New("expand operation is already bound to another task")
		}
		return tx.Model(&operationRecord{}).Where("id = ?", record.ID).Updates(map[string]any{
			"task_id": taskID, "state": operationBound, "updated_at": time.Now().UTC(),
		}).Error
	})
}

func (j *journal) saveResponse(id string, status int, body []byte) error {
	state := operationRejected
	if status >= 200 && status < 300 {
		state = operationBound
		body = nil
	}
	return j.db.Model(&operationRecord{}).Where("id = ?", id).Updates(map[string]any{
		"response_status": status, "response_body": body, "state": gorm.Expr("CASE WHEN task_id <> '' THEN ? ELSE ? END", operationBound, state), "updated_at": time.Now().UTC(),
	}).Error
}

func (j *journal) resetDelivery(userID, taskID string) error {
	return j.db.Model(&operationRecord{}).Where("user_id = ? AND task_id = ?", userID, taskID).Updates(map[string]any{
		"delivery_state": "pending", "delivery_attempts": 0, "delivery_error_code": "",
		"next_attempt_at": time.Now().UTC(), "updated_at": time.Now().UTC(),
	}).Error
}

func (j *journal) markUnknown(id string) error {
	return j.db.Model(&operationRecord{}).Where("id = ?", id).Updates(map[string]any{"state": operationUnknown, "updated_at": time.Now().UTC()}).Error
}

func (j *journal) operationByTask(userID, taskID string) (*operationRecord, error) {
	var record operationRecord
	if err := j.db.Where("user_id = ? AND task_id = ?", userID, taskID).Order("created_at DESC").First(&record).Error; err != nil {
		return nil, err
	}
	return &record, nil
}

func (j *journal) operationByKey(userID, clientOperationID string) (*operationRecord, error) {
	var record operationRecord
	if err := j.db.Where("user_id = ? AND client_operation_id = ?", userID, clientOperationID).First(&record).Error; err != nil {
		return nil, err
	}
	return &record, nil
}

func (j *journal) activeOperations() ([]operationRecord, error) {
	var records []operationRecord
	err := j.db.Where("task_id <> '' AND delivery_state = ? AND next_attempt_at <= ?", "pending", time.Now().UTC()).Order("next_attempt_at ASC, id ASC").Limit(100).Find(&records).Error
	return records, err
}

func (j *journal) scheduleDelivery(id string, delay time.Duration) error {
	return j.db.Transaction(func(tx *gorm.DB) error {
		var record operationRecord
		if err := tx.First(&record, "id = ?", id).Error; err != nil {
			return err
		}
		updates := map[string]any{"delivery_attempts": record.DeliveryAttempts + 1, "next_attempt_at": time.Now().UTC().Add(delay), "updated_at": time.Now().UTC()}
		if record.DeliveryAttempts+1 >= 12 {
			updates["delivery_state"] = "failed"
			updates["delivery_error_code"] = "materialization_retry_exhausted"
		}
		return tx.Model(&operationRecord{}).Where("id = ?", id).Updates(updates).Error
	})
}

func (j *journal) deferDelivery(id string, delay time.Duration) error {
	return j.db.Model(&operationRecord{}).Where("id = ?", id).Updates(map[string]any{
		"next_attempt_at": time.Now().UTC().Add(delay), "updated_at": time.Now().UTC(),
	}).Error
}

func (j *journal) completeDelivery(id string) error {
	return j.db.Model(&operationRecord{}).Where("id = ?", id).Updates(map[string]any{
		"delivery_state": "complete", "delivery_error_code": "", "updated_at": time.Now().UTC(),
	}).Error
}

func (j *journal) failDelivery(id, code string) error {
	return j.db.Model(&operationRecord{}).Where("id = ?", id).Updates(map[string]any{
		"delivery_state": "failed", "delivery_error_code": code, "updated_at": time.Now().UTC(),
	}).Error
}

func (j *journal) outputs(operationID string) ([]outputRecord, error) {
	var records []outputRecord
	err := j.db.Where("operation_id = ?", operationID).Order("output_index ASC").Find(&records).Error
	return records, err
}

func (j *journal) setExpectedOutputs(operationID string, count int) error {
	return j.db.Model(&operationRecord{}).Where("id = ?", operationID).Updates(map[string]any{
		"expected_outputs": count, "updated_at": time.Now().UTC(),
	}).Error
}

func randomIdentifier(prefix string) (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return prefix + "-" + hex.EncodeToString(raw[:]), nil
}
