package expandopenapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	"yingce/backend/internal/kernel"
	"yingce/backend/internal/model"
	"yingce/backend/internal/service"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

var errOperationConflict = errors.New("clientOperationId was already used with different content")

type hostService interface {
	SetTaskCreateObserver(func(userID, taskID, traceID string) error)
	CurrentUser(cookieValue string) (*model.User, error)
	Task(userID, id string) (*model.Task, error)
	Resource(userID, id string) (*model.Resource, error)
	UserAsset(userID, id string) (json.RawMessage, error)
	UpsertUserAsset(userID string, raw json.RawMessage) (service.UserDataSummary, error)
}

type Manager struct {
	host     hostService
	journal  *journal
	activeMu sync.RWMutex
	active   map[string]activeOperation
	cancel   context.CancelFunc
	wg       sync.WaitGroup
}

type activeOperation struct {
	owner       string
	operationID string
}

func NewManager(dataDir string, host hostService) (*Manager, error) {
	if host == nil {
		return nil, errors.New("expand-openapi: nil host service")
	}
	journal, err := openJournal(dataDir)
	if err != nil {
		return nil, err
	}
	manager := &Manager{host: host, journal: journal, active: make(map[string]activeOperation)}
	host.SetTaskCreateObserver(manager.observeTaskCreate)
	return manager, nil
}

func (m *Manager) Start(parent context.Context) {
	if m == nil || m.cancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	m.cancel = cancel
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.runMaterializer(ctx)
	}()
}

func (m *Manager) Close() error {
	if m == nil {
		return nil
	}
	if m.cancel != nil {
		m.cancel()
		m.wg.Wait()
	}
	return m.journal.close()
}

func (m *Manager) observeTaskCreate(userID, taskID, traceID string) error {
	m.activeMu.RLock()
	operation, active := m.active[traceID]
	m.activeMu.RUnlock()
	if !active {
		return nil
	}
	if operation.owner != userID {
		return errors.New("expand operation owner mismatch")
	}
	return m.journal.bindTask(operation.operationID, strings.TrimSpace(userID), strings.TrimSpace(taskID))
}

func (m *Manager) handle(c *gin.Context, upstream http.Handler, relativePath string) bool {
	if c.Request.Method == http.MethodPost && (relativePath == "/workbench/tasks" || relativePath == "/tasks") {
		m.handleIdempotentCreate(c, upstream, relativePath)
		return true
	}
	if c.Request.Method == http.MethodGet && relativePath == "/workbench/tasks" && strings.TrimSpace(c.Query("clientOperationId")) != "" {
		m.handleOperationQuery(c, upstream, relativePath)
		return true
	}
	if c.Request.Method == http.MethodGet && relativePath == "/workbench/tasks" {
		m.handleProjectedWorkbenchTasks(c, upstream, relativePath)
		return true
	}
	if c.Request.Method == http.MethodGet && strings.HasPrefix(relativePath, "/tasks/") {
		m.handleProjectedTask(c, upstream, relativePath)
		return true
	}
	if c.Request.Method == http.MethodPost && (strings.HasSuffix(relativePath, "/retry") || strings.HasSuffix(relativePath, "/recover-media")) {
		m.handleTaskRecovery(c, upstream, relativePath)
		return true
	}
	return false
}

func (m *Manager) handleIdempotentCreate(c *gin.Context, upstream http.Handler, relativePath string) {
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 16<<20))
	if err != nil {
		writeFacadeError(c, http.StatusBadRequest, "expand_openapi_invalid_body")
		return
	}
	var payload map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		writeFacadeError(c, http.StatusBadRequest, "expand_openapi_invalid_body")
		return
	}
	rawClientOperationID, _ := payload["clientOperationId"].(string)
	clientOperationID := strings.TrimSpace(rawClientOperationID)
	if rawClientOperationID != clientOperationID || !validClientOperationID(clientOperationID) {
		writeFacadeError(c, http.StatusBadRequest, "expand_openapi_client_operation_id_required")
		return
	}
	delete(payload, "clientOperationId")
	if relativePath == "/tasks" && !isSupportedDirectTask(payload) {
		writeFacadeError(c, http.StatusBadRequest, "expand_openapi_task_type_not_allowed")
		return
	}
	cleanBody, err := json.Marshal(payload)
	if err != nil {
		writeFacadeError(c, http.StatusBadRequest, "expand_openapi_invalid_body")
		return
	}
	user, err := m.currentUser(c.Request)
	if err != nil {
		if isAccessDenied(err) {
			m.dispatch(c, upstream, relativePath, body, "")
			return
		}
		writeFacadeError(c, http.StatusServiceUnavailable, "expand_openapi_auth_unavailable")
		return
	}
	fingerprintBytes := sha256.Sum256(append([]byte("expand-openapi/v1\x00"+http.MethodPost+"\x00"+relativePath+"\x00"), cleanBody...))
	fingerprint := hex.EncodeToString(fingerprintBytes[:])
	kind := taskKind(relativePath, payload)
	record, created, err := m.journal.claim(user.ID, clientOperationID, fingerprint, kind)
	if errors.Is(err, errOperationConflict) {
		writeFacadeError(c, http.StatusConflict, "expand_openapi_operation_conflict")
		return
	}
	if err != nil {
		writeFacadeError(c, http.StatusServiceUnavailable, "expand_openapi_journal_unavailable")
		return
	}
	if !created {
		m.replayOperation(c, upstream, record)
		return
	}
	recorder := m.dispatchActiveOperation(c.Request, upstream, relativePath, cleanBody, record, user.ID)
	if outerTrace := c.Writer.Header().Get("X-Canvas-Trace-ID"); outerTrace != "" {
		recorder.Header().Set("X-Canvas-Trace-ID", outerTrace)
	}
	responseBody := recorder.Body.Bytes()
	if err := m.journal.saveResponse(record.ID, recorder.Code, responseBody); err != nil {
		writeFacadeError(c, http.StatusServiceUnavailable, "expand_openapi_journal_unavailable")
		return
	}
	if current, lookupErr := m.journal.operationByKey(user.ID, clientOperationID); lookupErr == nil {
		m.projectTaskResponse(recorder, current)
	}
	copyRecordedResponse(c.Writer, recorder)
}

func (m *Manager) dispatchActiveOperation(request *http.Request, upstream http.Handler, relativePath string, body []byte, record *operationRecord, userID string) *httptest.ResponseRecorder {
	m.activeMu.Lock()
	m.active[record.TraceID] = activeOperation{owner: userID, operationID: record.ID}
	m.activeMu.Unlock()
	defer func() {
		m.activeMu.Lock()
		delete(m.active, record.TraceID)
		m.activeMu.Unlock()
	}()
	return m.dispatchToRecorder(request, upstream, relativePath, body, record.TraceID)
}

func (m *Manager) replayOperation(c *gin.Context, upstream http.Handler, record *operationRecord) {
	if record.Fingerprint == "" {
		writeFacadeError(c, http.StatusConflict, "expand_openapi_operation_unknown")
		return
	}
	if record.TaskID != "" {
		if _, err := m.host.Task(record.UserID, record.TaskID); err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				_ = m.journal.markUnknown(record.ID)
				writeFacadeError(c, http.StatusConflict, "expand_openapi_operation_unknown")
			} else {
				writeFacadeError(c, http.StatusServiceUnavailable, "expand_openapi_task_unavailable")
			}
			return
		}
		request := c.Request.Clone(c.Request.Context())
		request.Method = http.MethodGet
		recorder := m.dispatchToRecorder(request, upstream, "/tasks/"+record.TaskID, nil, "")
		m.projectTaskResponse(recorder, record)
		copyRecordedResponse(c.Writer, recorder)
		return
	}
	if record.State == operationRejected && record.ResponseStatus != 0 {
		c.Data(record.ResponseStatus, "application/json; charset=utf-8", record.ResponseBody)
		return
	}
	if record.State == operationUnknown {
		writeFacadeError(c, http.StatusConflict, "expand_openapi_operation_unknown")
		return
	}
	writeFacadeError(c, http.StatusConflict, "expand_openapi_operation_in_progress")
}

func (m *Manager) handleTaskRecovery(c *gin.Context, upstream http.Handler, relativePath string) {
	user, err := m.currentUser(c.Request)
	if err != nil {
		if isAccessDenied(err) {
			m.dispatch(c, upstream, relativePath, nil, "")
			return
		}
		writeFacadeError(c, http.StatusServiceUnavailable, "expand_openapi_auth_unavailable")
		return
	}
	parts := strings.Split(strings.Trim(relativePath, "/"), "/")
	if len(parts) >= 3 {
		_ = m.journal.resetDelivery(user.ID, parts[1])
	}
	m.dispatch(c, upstream, relativePath, nil, "")
}

func (m *Manager) handleOperationQuery(c *gin.Context, upstream http.Handler, _ string) {
	user, err := m.currentUser(c.Request)
	if err != nil {
		m.dispatch(c, upstream, "/workbench/tasks", nil, "")
		return
	}
	// Preserve the original workbench feature/kind gate before resolving the
	// operation to a task detail response.
	gate := m.dispatchToRecorder(c.Request, upstream, "/workbench/tasks", nil, "")
	if gate.Code != http.StatusOK {
		copyRecordedResponse(c.Writer, gate)
		return
	}
	var record operationRecord
	err = m.journal.db.Where("user_id = ? AND client_operation_id = ?", user.ID, strings.TrimSpace(c.Query("clientOperationId"))).First(&record).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusOK, gin.H{"code": 0, "data": []any{}, "msg": "ok"})
		return
	}
	if err != nil || record.TaskID == "" {
		writeFacadeError(c, http.StatusConflict, "expand_openapi_operation_unknown")
		return
	}
	if kind := strings.TrimSpace(c.Query("kind")); kind != "" && kind != record.Kind {
		writeFacadeError(c, http.StatusConflict, "expand_openapi_operation_kind_conflict")
		return
	}
	recorder := m.dispatchToRecorder(c.Request, upstream, "/tasks/"+record.TaskID, nil, "")
	m.projectTaskResponse(recorder, &record)
	if recorder.Code == http.StatusOK {
		wrapEnvelopeDataAsArray(recorder)
	}
	copyRecordedResponse(c.Writer, recorder)
}

func (m *Manager) handleProjectedWorkbenchTasks(c *gin.Context, upstream http.Handler, relativePath string) {
	recorder := m.dispatchToRecorder(c.Request, upstream, relativePath, nil, "")
	if recorder.Code == http.StatusOK {
		if user, err := m.currentUser(c.Request); err == nil {
			m.projectWorkbenchTaskList(recorder, user.ID)
		}
	}
	copyRecordedResponse(c.Writer, recorder)
}

func (m *Manager) handleProjectedTask(c *gin.Context, upstream http.Handler, relativePath string) {
	recorder := m.dispatchToRecorder(c.Request, upstream, relativePath, nil, "")
	if recorder.Code == http.StatusOK {
		user, _ := m.currentUser(c.Request)
		if user != nil {
			taskID := strings.TrimPrefix(relativePath, "/tasks/")
			if record, err := m.journal.operationByTask(user.ID, taskID); err == nil {
				m.projectTaskResponse(recorder, record)
			}
		}
	}
	copyRecordedResponse(c.Writer, recorder)
}

func (m *Manager) currentUser(request *http.Request) (*model.User, error) {
	cookie, err := request.Cookie(service.SessionCookieName)
	if err != nil {
		return nil, err
	}
	return m.host.CurrentUser(cookie.Value)
}

func isAccessDenied(err error) bool {
	if errors.Is(err, http.ErrNoCookie) {
		return true
	}
	var appErr *kernel.AppError
	return errors.As(err, &appErr) && (appErr.Status == http.StatusUnauthorized || appErr.Status == http.StatusForbidden)
}

func (m *Manager) dispatch(c *gin.Context, upstream http.Handler, relativePath string, body []byte, traceID string) {
	recorder := m.dispatchToRecorder(c.Request, upstream, relativePath, body, traceID)
	copyRecordedResponse(c.Writer, recorder)
}

func (m *Manager) dispatchToRecorder(original *http.Request, upstream http.Handler, relativePath string, body []byte, traceID string) *httptest.ResponseRecorder {
	forwarded := original.Clone(original.Context())
	forwarded.URL.Path = UpstreamBasePath + relativePath
	forwarded.URL.RawPath = ""
	if relativePath != strings.TrimPrefix(original.URL.Path, "/api"+FacadeBasePath) {
		forwarded.URL.RawQuery = ""
	}
	forwarded.RequestURI = forwarded.URL.Path
	if forwarded.URL.RawQuery != "" {
		forwarded.RequestURI += "?" + forwarded.URL.RawQuery
	}
	if body != nil {
		forwarded.Body = io.NopCloser(bytes.NewReader(body))
		forwarded.ContentLength = int64(len(body))
	}
	if traceID != "" {
		forwarded.Header.Set("X-Canvas-Trace-ID", traceID)
	}
	recorder := httptest.NewRecorder()
	upstream.ServeHTTP(recorder, forwarded)
	return recorder
}

func copyRecordedResponse(writer http.ResponseWriter, recorder *httptest.ResponseRecorder) {
	for key, values := range recorder.Header() {
		if strings.EqualFold(key, "Content-Length") {
			continue
		}
		writer.Header()[key] = append([]string(nil), values...)
	}
	writer.WriteHeader(recorder.Code)
	_, _ = writer.Write(recorder.Body.Bytes())
}

func validClientOperationID(value string) bool {
	if value == "" || len(value) > 160 {
		return false
	}
	for _, char := range value {
		if char <= 32 || char == 127 {
			return false
		}
	}
	return true
}

func isSupportedDirectTask(payload map[string]any) bool {
	taskType := strings.ToLower(strings.TrimSpace(stringValue(payload["type"])))
	return taskType == "canvas_image" || taskType == "canvas_video"
}

func taskKind(relativePath string, payload map[string]any) string {
	if relativePath == "/workbench/tasks" {
		return strings.ToLower(strings.TrimSpace(stringValue(payload["kind"])))
	}
	if strings.Contains(strings.ToLower(stringValue(payload["type"])), "video") {
		return "video"
	}
	return "image"
}

func stringValue(value any) string {
	result, _ := value.(string)
	return result
}

func (m *Manager) runMaterializer(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		m.materializeReadyTasks()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
