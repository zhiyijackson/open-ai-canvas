package expandopenapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"yingce/backend/internal/auth"
	"yingce/backend/internal/database"
	"yingce/backend/internal/handler"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
	"yingce/backend/internal/service"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type fakeHost struct {
	mu                  sync.Mutex
	observer            func(string, string, string) error
	rejectedObserver    func(string, string, string) error
	retryObserver       func(string, string)
	tasks               map[string]*model.Task
	resources           map[string]*model.Resource
	assets              map[string]json.RawMessage
	authErr             error
	taskLookupFailures  int
	resourceFailures    int
	assetLookupFailures int
	upsertFailures      int
	writeThenFail       int
	upserts             int
	taskReadStarted     chan struct{}
	taskReadRelease     chan struct{}
}

func TestRealHandlerCreateReplayCreatesOneTaskAndOneBillingOrder(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dataDir := t.TempDir()
	db, err := database.Open(database.Config{Driver: "sqlite", DSN: filepath.Join(dataDir, "core.db") + "?_busy_timeout=5000&_journal_mode=WAL"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(database.Models()...); err != nil {
		t.Fatal(err)
	}
	svc := service.New(repository.New(db), dataDir)
	t.Cleanup(func() { _ = svc.Close() })
	profile := service.DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceOpenAIImage), "image-test")
	capabilityJSON, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []any{
		&model.User{ID: "user-1", Username: "user-1", DisplayName: "User", Status: model.UserStatusActive},
		&model.AuthSession{ID: "session", UserID: "user-1", TokenHash: auth.HashToken("test-token"), ExpiresAt: time.Now().Add(time.Hour)},
		&model.ModelChannel{ID: "channel", Scope: model.ChannelScopeSystem, Enabled: true, Name: "Test"},
		&model.ChannelModel{ID: "image-model", ChannelID: "channel", ModelKey: "image-test", Capability: "image", Protocol: model.ChannelInterfaceOpenAIImage, CapabilityConfigJSON: string(capabilityJSON), BillingMode: "fixed_request", UnitPriceMicrocredits: 100, PriceConfigured: true, Enabled: true},
		&model.ChannelModelPriceTier{ID: "image-tier", ChannelModelID: "image-model", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 100, PriceConfigured: true, Enabled: true},
		&model.CreditAccount{UserID: "user-1", AvailableMicrocredits: 10_000},
	} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	manager, err := NewManager(dataDir, svc)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	root := gin.New()
	root.Use(handler.RequestCorrelationMiddleware())
	handler.ConfigureRuntime(svc)
	api := root.Group("/api")
	handler.RegisterTaskRoutes(api, svc)
	Register(api, root, manager)
	body := []byte(`{"clientOperationId":"real-operation","type":"canvas_image","operation":"text_to_image","prompt":"a cat","model":"image-test","input":{"mode":"image","prompt":"a cat","config":{"channelId":"channel","model":"image-test","size":"1024x1024"}}}`)
	request := func(requestBody []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/expand-openapi/v1/tasks", bytes.NewReader(requestBody))
		req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "session.test-token"})
		recorder := httptest.NewRecorder()
		root.ServeHTTP(recorder, req)
		return recorder
	}
	for attempt := 0; attempt < 2; attempt++ {
		response := request(body)
		if response.Code != http.StatusOK {
			t.Fatalf("attempt %d: status=%d body=%s", attempt+1, response.Code, response.Body.String())
		}
		if attempt == 0 {
			var operation operationRecord
			if err := manager.journal.db.Where("client_operation_id = ?", "real-operation").First(&operation).Error; err != nil {
				t.Fatal(err)
			}
			if response.Header().Get("X-Canvas-Trace-ID") == "" || response.Header().Get("X-Canvas-Trace-ID") == operation.TraceID {
				t.Fatalf("private operation trace leaked in response: %q", response.Header().Get("X-Canvas-Trace-ID"))
			}
		}
	}
	for name, table := range map[string]any{"tasks": &model.Task{}, "billing orders": &model.BillingOrder{}} {
		var count int64
		if err := db.Model(table).Count(&count).Error; err != nil || count != 1 {
			t.Fatalf("%s count=%d err=%v, want 1", name, count, err)
		}
	}
	if err := db.Model(&model.CreditAccount{}).Where("user_id = ?", "user-1").Update("available_microcredits", 0).Error; err != nil {
		t.Fatal(err)
	}
	rejectedBody := []byte(`{"clientOperationId":"real-rejected-operation","type":"canvas_image","operation":"text_to_image","prompt":"a dog","model":"image-test","input":{"mode":"image","prompt":"a dog","config":{"channelId":"channel","model":"image-test","size":"1024x1024"}}}`)
	for attempt := 0; attempt < 2; attempt++ {
		response := request(rejectedBody)
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"expandOperationState":"rejected"`) || !strings.Contains(response.Body.String(), `"reason":"invalid_argument"`) {
			t.Fatalf("rejected attempt %d: status=%d body=%s", attempt+1, response.Code, response.Body.String())
		}
	}
	for name, table := range map[string]any{"tasks": &model.Task{}, "billing orders": &model.BillingOrder{}} {
		var count int64
		if err := db.Model(table).Count(&count).Error; err != nil || count != 1 {
			t.Fatalf("after rejected create %s count=%d err=%v, want 1", name, count, err)
		}
	}
}

func TestUnboundClaimBecomesUnknownAfterRestart(t *testing.T) {
	dataDir := t.TempDir()
	journal, err := openJournal(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	record, _, err := journal.claim("user-1", "operation-1", "fingerprint", "image")
	if err != nil {
		t.Fatal(err)
	}
	if err := journal.close(); err != nil {
		t.Fatal(err)
	}
	journal, err = openJournal(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.close()
	var restarted operationRecord
	if err := journal.db.First(&restarted, "id = ?", record.ID).Error; err != nil {
		t.Fatal(err)
	}
	if restarted.State != operationUnknown || restarted.TaskID != "" {
		t.Fatalf("restarted operation state=%q task=%q, want unknown/unbound", restarted.State, restarted.TaskID)
	}
}

func newFakeHost() *fakeHost {
	return &fakeHost{tasks: map[string]*model.Task{}, resources: map[string]*model.Resource{}, assets: map[string]json.RawMessage{}}
}

func (h *fakeHost) SetTaskCreateObserver(observer func(string, string, string) error) {
	h.observer = observer
}
func (h *fakeHost) SetTaskCreateRejectedObserver(observer func(string, string, string) error) {
	h.rejectedObserver = observer
}
func (h *fakeHost) SetTaskRetryObserver(observer func(string, string)) {
	h.retryObserver = observer
}
func (h *fakeHost) CurrentUser(cookie string) (*model.User, error) {
	if h.authErr != nil {
		return nil, h.authErr
	}
	if cookie != "session" {
		return nil, errors.New("unauthorized")
	}
	return &model.User{ID: "user-1"}, nil
}
func (h *fakeHost) Task(userID, id string) (*model.Task, error) {
	h.mu.Lock()
	if h.taskLookupFailures > 0 {
		h.taskLookupFailures--
		h.mu.Unlock()
		return nil, errors.New("temporary task lookup failure")
	}
	task := h.tasks[id]
	if task == nil || task.UserID != userID {
		h.mu.Unlock()
		return nil, gorm.ErrRecordNotFound
	}
	copy := *task
	started, release := h.taskReadStarted, h.taskReadRelease
	h.mu.Unlock()
	if started != nil {
		select {
		case started <- struct{}{}:
		default:
		}
	}
	if release != nil {
		<-release
	}
	return &copy, nil
}
func (h *fakeHost) Resource(userID, id string) (*model.Resource, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.resourceFailures > 0 {
		h.resourceFailures--
		return nil, errors.New("temporary resource lookup failure")
	}
	resource := h.resources[id]
	if resource == nil || resource.UserID != userID {
		return nil, gorm.ErrRecordNotFound
	}
	copy := *resource
	return &copy, nil
}
func (h *fakeHost) UserAsset(_ string, id string) (json.RawMessage, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.assetLookupFailures > 0 {
		h.assetLookupFailures--
		return nil, errors.New("temporary asset lookup failure")
	}
	asset, ok := h.assets[id]
	if !ok {
		return nil, gorm.ErrRecordNotFound
	}
	return append(json.RawMessage(nil), asset...), nil
}
func (h *fakeHost) UpsertUserAsset(_ string, raw json.RawMessage) (service.UserDataSummary, error) {
	var payload struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return service.UserDataSummary{}, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.writeThenFail > 0 {
		h.writeThenFail--
		h.assets[payload.ID] = append(json.RawMessage(nil), raw...)
		h.upserts++
		return service.UserDataSummary{}, errors.New("asset write response lost")
	}
	if h.upsertFailures > 0 {
		h.upsertFailures--
		return service.UserDataSummary{}, errors.New("ambiguous asset write failure")
	}
	h.assets[payload.ID] = append(json.RawMessage(nil), raw...)
	h.upserts++
	return service.UserDataSummary{ID: payload.ID}, nil
}

func TestJournalClaimsOneOperationAndRejectsChangedIntent(t *testing.T) {
	journal, err := openJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer journal.close()

	const callers = 12
	var wg sync.WaitGroup
	created := 0
	var mu sync.Mutex
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, wasCreated, claimErr := journal.claim("user-1", "operation-1", "fingerprint-1", "image")
			if claimErr != nil {
				t.Errorf("claim: %v", claimErr)
				return
			}
			if wasCreated {
				mu.Lock()
				created++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if created != 1 {
		t.Fatalf("created operations = %d, want 1", created)
	}
	if _, _, err := journal.claim("user-1", "operation-1", "changed", "image"); !errors.Is(err, errOperationConflict) {
		t.Fatalf("changed intent error = %v", err)
	}
}

func TestFacadeCreateIsIdempotentAcrossManagerRestart(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dataDir := t.TempDir()
	host := newFakeHost()
	manager, err := NewManager(dataDir, host)
	if err != nil {
		t.Fatal(err)
	}
	creates := 0
	root := gin.New()
	api := root.Group("/api")
	api.POST("/workbench/tasks", func(c *gin.Context) {
		creates++
		trace := c.GetHeader("X-Canvas-Trace-ID")
		if err := host.observer("user-1", "task-1", trace); err != nil {
			c.JSON(500, gin.H{"code": 500, "data": nil, "msg": err.Error()})
			return
		}
		host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Status: model.TaskStatusQueued}
		c.JSON(200, gin.H{"code": 0, "data": host.tasks["task-1"], "msg": "ok"})
	})
	api.GET("/tasks/:id", func(c *gin.Context) {
		c.JSON(200, gin.H{"code": 0, "data": host.tasks[c.Param("id")], "msg": "ok"})
	})
	Register(api, root, manager)

	request := func() *httptest.ResponseRecorder {
		body := []byte(`{"clientOperationId":"operation-1","kind":"image","prompt":"a cat"}`)
		req := httptest.NewRequest(http.MethodPost, "/api/expand-openapi/v1/workbench/tasks", bytes.NewReader(body))
		req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "session"})
		recorder := httptest.NewRecorder()
		root.ServeHTTP(recorder, req)
		return recorder
	}
	if response := request(); response.Code != http.StatusOK {
		t.Fatalf("first create: %d %s", response.Code, response.Body.String())
	}
	var operation operationRecord
	if err := manager.journal.db.Where("client_operation_id = ?", "operation-1").First(&operation).Error; err != nil {
		t.Fatal(err)
	}
	if err := host.observer("user-1", "task-attacker", operation.TraceID); err != nil {
		t.Fatalf("historical trace should be ignored without touching journal: %v", err)
	}
	var persisted operationRecord
	if err := manager.journal.db.First(&persisted, "id = ?", operation.ID).Error; err != nil || persisted.TaskID != "task-1" {
		t.Fatalf("historical trace rebound operation: task=%q err=%v", persisted.TaskID, err)
	}
	if err := manager.Close(); err != nil {
		t.Fatal(err)
	}
	manager, err = NewManager(dataDir, host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	// Existing Gin closure points at the old manager, so directly replace the
	// runtime handler with a fresh router to model a process restart.
	root = gin.New()
	api = root.Group("/api")
	api.POST("/workbench/tasks", func(c *gin.Context) { creates++; c.Status(500) })
	api.GET("/tasks/:id", func(c *gin.Context) {
		c.JSON(200, gin.H{"code": 0, "data": host.tasks[c.Param("id")], "msg": "ok"})
	})
	Register(api, root, manager)
	if response := request(); response.Code != http.StatusOK {
		t.Fatalf("replayed create: %d %s", response.Code, response.Body.String())
	}
	if creates != 1 {
		t.Fatalf("host creates = %d, want 1", creates)
	}
}

func TestFacadeCreateFailsClosedWhenIdentityLookupIsUnavailable(t *testing.T) {
	gin.SetMode(gin.TestMode)
	host := newFakeHost()
	host.authErr = errors.New("session database unavailable")
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	creates := 0
	root := gin.New()
	api := root.Group("/api")
	api.POST("/workbench/tasks", func(c *gin.Context) {
		creates++
		c.JSON(http.StatusOK, gin.H{"code": 0})
	})
	Register(api, root, manager)
	body := []byte(`{"clientOperationId":"operation-1","kind":"image","prompt":"a cat"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/expand-openapi/v1/workbench/tasks", bytes.NewReader(body))
	request.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "session"})
	response := httptest.NewRecorder()
	root.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || creates != 0 {
		t.Fatalf("status=%d creates=%d body=%s, want 503 and no upstream create", response.Code, creates, response.Body.String())
	}
	var operations int64
	if err := manager.journal.db.Model(&operationRecord{}).Count(&operations).Error; err != nil || operations != 0 {
		t.Fatalf("operations=%d err=%v, want no journal claim", operations, err)
	}
}

func TestRejectedOperationIsExplicitOnFirstResponseReplayAndQuery(t *testing.T) {
	gin.SetMode(gin.TestMode)
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	creates := 0
	root := gin.New()
	api := root.Group("/api")
	api.POST("/workbench/tasks", func(c *gin.Context) {
		creates++
		c.JSON(http.StatusPaymentRequired, gin.H{
			"code": http.StatusPaymentRequired, "data": nil, "msg": "余额不足", "reason": "insufficient_credits",
			"details": gin.H{"balance": 0},
		})
	})
	api.GET("/workbench/tasks", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"code": 0, "data": []any{}, "msg": "ok"})
	})
	Register(api, root, manager)

	request := func(method, target string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, target, bytes.NewReader(body))
		req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "session"})
		response := httptest.NewRecorder()
		root.ServeHTTP(response, req)
		return response
	}
	body := []byte(`{"clientOperationId":"rejected-operation","kind":"image","prompt":"a cat"}`)
	responses := []struct {
		name     string
		response *httptest.ResponseRecorder
	}{
		{"first", request(http.MethodPost, "/api/expand-openapi/v1/workbench/tasks", body)},
		{"replay", request(http.MethodPost, "/api/expand-openapi/v1/workbench/tasks", body)},
		{"query", request(http.MethodGet, "/api/expand-openapi/v1/workbench/tasks?clientOperationId=rejected-operation&kind=image", nil)},
	}
	for _, item := range responses {
		name, response := item.name, item.response
		if response.Code != http.StatusPaymentRequired {
			t.Fatalf("%s status=%d body=%s", name, response.Code, response.Body.String())
		}
		var envelope struct {
			Code    int            `json:"code"`
			Reason  string         `json:"reason"`
			Details map[string]any `json:"details"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Code != http.StatusPaymentRequired || envelope.Reason != "insufficient_credits" || envelope.Details["balance"] != float64(0) || envelope.Details["expandOperationState"] != operationRejected {
			t.Fatalf("%s envelope=%+v, want preserved rejection with explicit disposition", name, envelope)
		}
	}
	if creates != 1 {
		t.Fatalf("host creates=%d, want one", creates)
	}
}

func TestPredispatchValidationErrorIsExplicitlyRejected(t *testing.T) {
	gin.SetMode(gin.TestMode)
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	root := gin.New()
	api := root.Group("/api")
	Register(api, root, manager)
	request := httptest.NewRequest(http.MethodPost, "/api/expand-openapi/v1/workbench/tasks", bytes.NewBufferString(`{"kind":"image"}`))
	response := httptest.NewRecorder()
	root.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"expandRequestState":"rejected"`) || strings.Contains(response.Body.String(), "expandOperationState") {
		t.Fatalf("status=%d body=%s, want explicit predispatch rejection", response.Code, response.Body.String())
	}
}

func TestUnauthenticatedCreateIsExplicitlyRejectedWithoutDispatch(t *testing.T) {
	gin.SetMode(gin.TestMode)
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	dispatched := 0
	root := gin.New()
	api := root.Group("/api")
	api.POST("/workbench/tasks", func(c *gin.Context) {
		dispatched++
		c.JSON(http.StatusOK, gin.H{"code": 0})
	})
	Register(api, root, manager)
	request := httptest.NewRequest(http.MethodPost, "/api/expand-openapi/v1/workbench/tasks", bytes.NewBufferString(`{"clientOperationId":"operation-1","kind":"image","prompt":"cat"}`))
	response := httptest.NewRecorder()
	root.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || dispatched != 0 || !strings.Contains(response.Body.String(), `"expandRequestState":"rejected"`) || strings.Contains(response.Body.String(), "expandOperationState") {
		t.Fatalf("status=%d dispatched=%d body=%s", response.Code, dispatched, response.Body.String())
	}
}

func TestObserverRejectsActiveTraceFromDifferentOwner(t *testing.T) {
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	record, _, err := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
	if err != nil {
		t.Fatal(err)
	}
	manager.active[record.TraceID] = activeOperation{owner: "user-1", operationID: record.ID}
	if err := manager.observeTaskCreate("user-2", "task-2", record.TraceID); err == nil {
		t.Fatal("different owner used an active internal trace")
	}
	var persisted operationRecord
	if err := manager.journal.db.First(&persisted, "id = ?", record.ID).Error; err != nil || persisted.TaskID != "" {
		t.Fatalf("owner mismatch bound task: task=%q err=%v", persisted.TaskID, err)
	}
}

func TestDefiniteCreateRejectionReleasesBindingAfterMissingTaskWasMarkedUnknown(t *testing.T) {
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	record, _, err := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
	if err != nil {
		t.Fatal(err)
	}
	manager.active[record.TraceID] = activeOperation{owner: "user-1", operationID: record.ID}
	if err := manager.journal.bindTask(record.ID, "user-1", "task-1"); err != nil {
		t.Fatal(err)
	}
	if err := manager.journal.markUnknown(record.ID, "task-1"); err != nil {
		t.Fatal(err)
	}
	if err := manager.observeTaskCreateRejected("user-1", "task-1", record.TraceID); err != nil {
		t.Fatal(err)
	}
	if err := manager.journal.saveResponse(record.ID, http.StatusBadRequest, []byte(`{"code":400,"data":null,"msg":"rejected"}`)); err != nil {
		t.Fatal(err)
	}
	persisted, err := manager.journal.operationByKey("user-1", "operation-1")
	if err != nil || persisted.TaskID != "" || persisted.State != operationRejected {
		t.Fatalf("operation=%+v err=%v, want unbound rejected operation", persisted, err)
	}
}

func TestStaleMissingTaskResultCannotOverwriteDefiniteRejection(t *testing.T) {
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	record, _, _ := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
	manager.active[record.TraceID] = activeOperation{owner: "user-1", operationID: record.ID}
	if err := manager.journal.bindTask(record.ID, "user-1", "task-1"); err != nil {
		t.Fatal(err)
	}
	if err := manager.observeTaskCreateRejected("user-1", "task-1", record.TraceID); err != nil {
		t.Fatal(err)
	}
	if err := manager.journal.saveResponse(record.ID, http.StatusBadRequest, []byte(`{"code":400,"data":null,"msg":"rejected"}`)); err != nil {
		t.Fatal(err)
	}
	if err := manager.journal.markUnknown(record.ID, "task-1"); err != nil {
		t.Fatal(err)
	}
	persisted, err := manager.journal.operationByKey("user-1", "operation-1")
	if err != nil || persisted.State != operationRejected || persisted.TaskID != "" {
		t.Fatalf("operation=%+v err=%v, stale missing-task result overwrote rejection", persisted, err)
	}
}

func TestMaterializationRetryExhaustionStaysTerminalUntilTaskChanges(t *testing.T) {
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	record, _, _ := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
	_ = manager.journal.bindTask(record.ID, "user-1", "task-1")
	updatedAt := time.Now().Add(-time.Minute)
	host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded, RouteRun: 1, UpdatedAt: updatedAt, ResultJSON: `{invalid`}
	for range 12 {
		manager.materializeReadyTasks()
		forceDeliveryReady(t, manager, record.ID)
	}
	operation := assertDeliveryState(t, manager, record.ID, "failed")
	if operation.DeliveryAttempts != 12 || operation.DeliveryRouteRun != 1 || !operation.DeliveryTaskUpdatedAt.Equal(updatedAt) {
		t.Fatalf("exhausted operation=%+v, want task checkpoint", operation)
	}
	forceDeliveryReady(t, manager, record.ID)
	manager.materializeReadyTasks()
	operation = assertDeliveryState(t, manager, record.ID, "failed")
	if operation.DeliveryAttempts != 12 {
		t.Fatalf("unchanged task restarted exhausted delivery: %+v", operation)
	}
	host.mu.Lock()
	host.tasks["task-1"].Status = model.TaskStatusQueued
	host.tasks["task-1"].RouteRun = 2
	host.tasks["task-1"].UpdatedAt = updatedAt.Add(time.Second)
	host.mu.Unlock()
	forceDeliveryReady(t, manager, record.ID)
	manager.materializeReadyTasks()
	operation = assertDeliveryState(t, manager, record.ID, "pending")
	if operation.DeliveryAttempts != 0 {
		t.Fatalf("changed task did not reset exhausted delivery: %+v", operation)
	}
}

func TestMaterializerPersistsAllOutputsAndDoesNotResurrectDeletion(t *testing.T) {
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	record, _, err := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.journal.bindTask(record.ID, "user-1", "task-1"); err != nil {
		t.Fatal(err)
	}
	host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded, ResultJSON: `{"mode":"image","images":[{"resourceId":"resource-1"},{"storageKey":"resource:resource-2"}]}`}
	for _, id := range []string{"resource-1", "resource-2"} {
		host.resources[id] = &model.Resource{ID: id, UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png", Width: 64, Height: 64}
	}
	manager.materializeReadyTasks()
	if host.upserts != 2 || len(host.assets) != 2 {
		t.Fatalf("upserts=%d assets=%d, want 2/2", host.upserts, len(host.assets))
	}
	operation := assertDeliveryState(t, manager, record.ID, "complete")
	outputs, err := manager.journal.outputs(record.ID)
	if err != nil {
		t.Fatal(err)
	}
	data := map[string]any{}
	projectOperationFields(manager, data, operation, outputs)
	if data["assetRegistrationState"] != "complete" || data["assetRegistrationVersion"] != 1 {
		t.Fatalf("projection=%+v, want versioned complete state", data)
	}
	deletedID := generatedAssetID("task-1", 0)
	delete(host.assets, deletedID)
	manager.materializeReadyTasks()
	if host.upserts != 2 {
		t.Fatalf("deleted generated asset was resurrected; upserts=%d", host.upserts)
	}
	outputs, err = manager.journal.outputs(record.ID)
	if err != nil || len(outputs) != 2 || outputs[0].State != outputBound || outputs[1].State != outputBound {
		t.Fatalf("outputs=%+v err=%v", outputs, err)
	}
	data = map[string]any{}
	projectOperationFields(manager, data, operation, outputs)
	if data["assetRegistrationState"] != "partial" || data["assetRegistrationVersion"] != nil {
		t.Fatalf("deleted asset projection=%+v, want unversioned partial state", data)
	}
}

func TestAttemptedWriteWithoutAssetBecomesUnavailableAfterRestart(t *testing.T) {
	dataDir := t.TempDir()
	host := newFakeHost()
	manager, err := NewManager(dataDir, host)
	if err != nil {
		t.Fatal(err)
	}
	record, _, _ := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
	_ = manager.journal.bindTask(record.ID, "user-1", "task-1")
	host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded, ResultJSON: `{"images":[{"resourceId":"resource-1"}]}`}
	host.resources["resource-1"] = &model.Resource{ID: "resource-1", UserID: "user-1", Status: model.ResourceStatusReady, MimeType: "image/png"}
	now := time.Now().UTC()
	prepared := outputRecord{ID: record.ID + "-0", OperationID: record.ID, OutputIndex: 0, MediaType: "image", ResourceID: "resource-1", AssetID: generatedAssetID("task-1", 0), State: outputAttempted, CreatedAt: now, UpdatedAt: now}
	if err := manager.journal.db.Create(&prepared).Error; err != nil {
		t.Fatal(err)
	}
	if err := manager.Close(); err != nil {
		t.Fatal(err)
	}
	manager, err = NewManager(filepath.Dir(filepath.Join(dataDir, "unused")), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	manager.materializeReadyTasks()
	outputs, _ := manager.journal.outputs(record.ID)
	if len(outputs) != 1 || outputs[0].State != outputUnavailable || outputs[0].ErrorCode != "asset_write_unknown" || host.upserts != 0 {
		t.Fatalf("outputs=%+v upserts=%d", outputs, host.upserts)
	}
}

func TestMaterializerRetriesTransientTaskAndAssetReads(t *testing.T) {
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	record, _, _ := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
	if err := manager.journal.bindTask(record.ID, "user-1", "task-1"); err != nil {
		t.Fatal(err)
	}
	host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded, ResultJSON: `{"images":[{"resourceId":"resource-1"}]}`}
	host.resources["resource-1"] = &model.Resource{ID: "resource-1", UserID: "user-1", Status: model.ResourceStatusReady, MimeType: "image/png"}
	host.taskLookupFailures = 1
	if err := manager.journal.db.Model(&operationRecord{}).Where("id = ?", record.ID).Update("created_at", time.Now().Add(-time.Minute)).Error; err != nil {
		t.Fatal(err)
	}

	manager.materializeReadyTasks()
	operation := assertDeliveryState(t, manager, record.ID, "pending")
	forceDeliveryReady(t, manager, record.ID)
	host.resourceFailures = 1
	manager.materializeReadyTasks()
	assertDeliveryState(t, manager, record.ID, "pending")
	if outputs, err := manager.journal.outputs(record.ID); err != nil || len(outputs) != 1 || outputs[0].State != outputPrepared {
		t.Fatalf("outputs=%+v err=%v, want prepared output before a resource is readable", outputs, err)
	}
	forceDeliveryReady(t, manager, record.ID)
	if active, err := manager.journal.activeOperations(); err != nil || len(active) != 1 {
		t.Fatalf("active operations=%+v operation=%+v err=%v, want one", active, operation, err)
	}
	host.assetLookupFailures = 1
	manager.materializeReadyTasks()
	assertDeliveryState(t, manager, record.ID, "pending")
	outputs, err := manager.journal.outputs(record.ID)
	if err != nil || len(outputs) != 1 || outputs[0].State != outputPrepared {
		t.Fatalf("outputs=%+v err=%v, want one prepared output", outputs, err)
	}

	forceDeliveryReady(t, manager, record.ID)
	manager.materializeReadyTasks()
	assertDeliveryState(t, manager, record.ID, "complete")
}

func TestQueuedTaskDoesNotExhaustMaterializationRetries(t *testing.T) {
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	record, _, _ := manager.journal.claim("user-1", "operation-1", "fingerprint", "video")
	_ = manager.journal.bindTask(record.ID, "user-1", "task-1")
	host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Type: "canvas_video", Status: model.TaskStatusQueued}
	for range 15 {
		manager.materializeReadyTasks()
		forceDeliveryReady(t, manager, record.ID)
	}
	operation := assertDeliveryState(t, manager, record.ID, "pending")
	if operation.DeliveryAttempts != 0 {
		t.Fatalf("queued task consumed %d materialization attempts, want 0", operation.DeliveryAttempts)
	}
	host.tasks["task-1"].Status = model.TaskStatusSucceeded
	host.tasks["task-1"].ResultJSON = `{"mode":"video","videos":[{"resourceId":"resource-1"}]}`
	host.resources["resource-1"] = &model.Resource{ID: "resource-1", UserID: "user-1", Status: model.ResourceStatusReady, MimeType: "video/mp4"}
	manager.materializeReadyTasks()
	assertDeliveryState(t, manager, record.ID, "complete")
	if host.upserts != 1 {
		t.Fatalf("upserts=%d, want completed video materialized once", host.upserts)
	}
}

func TestMaterializerReconcilesAmbiguousWriteBeforeBinding(t *testing.T) {
	host := newFakeHost()
	dataDir := t.TempDir()
	manager, err := NewManager(dataDir, host)
	if err != nil {
		t.Fatal(err)
	}
	record, _, _ := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
	_ = manager.journal.bindTask(record.ID, "user-1", "task-1")
	host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded, ResultJSON: `{"images":[{"resourceId":"resource-1"}]}`}
	host.resources["resource-1"] = &model.Resource{ID: "resource-1", UserID: "user-1", Status: model.ResourceStatusReady, MimeType: "image/png"}
	host.writeThenFail = 1

	manager.materializeReadyTasks()
	assertDeliveryState(t, manager, record.ID, "pending")
	outputs, _ := manager.journal.outputs(record.ID)
	if len(outputs) != 1 || outputs[0].State != outputAttempted {
		t.Fatalf("outputs=%+v, want attempted until read-only reconciliation", outputs)
	}
	if err := manager.Close(); err != nil {
		t.Fatal(err)
	}
	manager, err = NewManager(dataDir, host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	forceDeliveryReady(t, manager, record.ID)
	manager.materializeReadyTasks()
	operation := assertDeliveryState(t, manager, record.ID, "complete")
	data := map[string]any{}
	outputs, _ = manager.journal.outputs(record.ID)
	projectOperationFields(manager, data, operation, outputs)
	if data["assetRegistrationState"] != "complete" || data["assetRegistrationVersion"] != 1 || host.upserts != 1 {
		t.Fatalf("projection=%+v upserts=%d, want reconciled single write", data, host.upserts)
	}
}

func TestMissingResourceBecomesUnavailableAfterGracePeriod(t *testing.T) {
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	record, _, _ := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
	_ = manager.journal.bindTask(record.ID, "user-1", "task-1")
	host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded, ResultJSON: `{"images":[{"resourceId":"resource-missing"}]}`}

	manager.materializeReadyTasks()
	assertDeliveryState(t, manager, record.ID, "pending")
	outputs, _ := manager.journal.outputs(record.ID)
	if len(outputs) != 1 || outputs[0].State != outputPrepared {
		t.Fatalf("outputs=%+v, want prepared during missing-resource grace period", outputs)
	}
	if err := manager.journal.db.Model(&outputRecord{}).Where("id = ?", outputs[0].ID).Update("created_at", time.Now().Add(-time.Minute)).Error; err != nil {
		t.Fatal(err)
	}
	forceDeliveryReady(t, manager, record.ID)
	manager.materializeReadyTasks()
	operation := assertDeliveryState(t, manager, record.ID, "failed")
	outputs, _ = manager.journal.outputs(record.ID)
	if len(outputs) != 1 || outputs[0].State != outputUnavailable || outputs[0].ErrorCode != "resource_missing" || operation.DeliveryErrorCode != "resource_missing" {
		t.Fatalf("operation=%+v outputs=%+v, want terminal resource_missing", operation, outputs)
	}
}

func TestRetryObserverReopensDeliveryAfterHostTaskIsQueued(t *testing.T) {
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	record, _, _ := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
	_ = manager.journal.bindTask(record.ID, "user-1", "task-1")
	if err := manager.journal.completeDelivery(record.ID); err != nil {
		t.Fatal(err)
	}
	tombstone := outputRecord{ID: record.ID + "-0", OperationID: record.ID, OutputIndex: 0, MediaType: "image", ResourceID: "deleted-resource", AssetID: generatedAssetID("task-1", 0), State: outputUnavailable, ErrorCode: "asset_deleted", CreatedAt: time.Now(), UpdatedAt: time.Now()}
	attempted := outputRecord{ID: record.ID + "-1", OperationID: record.ID, OutputIndex: 1, MediaType: "image", ResourceID: "unknown-resource", AssetID: generatedAssetID("task-1", 1), State: outputAttempted, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := manager.journal.db.Create([]outputRecord{tombstone, attempted}).Error; err != nil {
		t.Fatal(err)
	}
	host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Status: model.TaskStatusQueued}

	host.retryObserver("user-1", "task-1")
	assertDeliveryState(t, manager, record.ID, "pending")
	if outputs, err := manager.journal.outputs(record.ID); err != nil || len(outputs) != 2 || outputs[0].State != outputUnavailable || outputs[1].State != outputAttempted {
		t.Fatalf("retry erased output tombstone: outputs=%+v err=%v", outputs, err)
	}
	manager.materializeReadyTasks()
	assertDeliveryState(t, manager, record.ID, "pending")
}

func TestTerminalDeliveryDiscoversMissedTaskRequeue(t *testing.T) {
	for _, tc := range []struct {
		name             string
		initialRouteRun  int
		requeuedRouteRun int
	}{
		{name: "generation retry", initialRouteRun: 1, requeuedRouteRun: 2},
		{name: "media recovery", initialRouteRun: 1, requeuedRouteRun: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host := newFakeHost()
			manager, err := NewManager(t.TempDir(), host)
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Close()
			record, _, _ := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
			_ = manager.journal.bindTask(record.ID, "user-1", "task-1")
			terminalAt := time.Now().Add(-time.Minute)
			host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Status: model.TaskStatusFailed, RouteRun: tc.initialRouteRun, UpdatedAt: terminalAt}
			manager.materializeReadyTasks()
			assertDeliveryState(t, manager, record.ID, "complete")

			host.mu.Lock()
			host.tasks["task-1"].Status = model.TaskStatusQueued
			host.tasks["task-1"].RouteRun = tc.requeuedRouteRun
			host.tasks["task-1"].UpdatedAt = terminalAt.Add(time.Second)
			host.mu.Unlock()
			forceDeliveryReady(t, manager, record.ID)
			manager.materializeReadyTasks()
			assertDeliveryState(t, manager, record.ID, "pending")
		})
	}
}

func TestTerminalDeliveryDiscoversCompletedMediaRecoveryAndRetriesOnlyPrewriteOutput(t *testing.T) {
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	record, _, _ := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
	_ = manager.journal.bindTask(record.ID, "user-1", "task-1")
	terminalAt := time.Now().Add(-time.Minute)
	host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusFailed, RouteRun: 1, UpdatedAt: terminalAt}
	manager.materializeReadyTasks()
	assertDeliveryState(t, manager, record.ID, "complete")
	prewriteFailure := outputRecord{ID: record.ID + "-0", OperationID: record.ID, OutputIndex: 0, MediaType: "image", ResourceID: "old-missing", AssetID: generatedAssetID("task-1", 0), State: outputUnavailable, ErrorCode: "resource_missing", CreatedAt: terminalAt, UpdatedAt: terminalAt}
	if err := manager.journal.db.Create(&prewriteFailure).Error; err != nil {
		t.Fatal(err)
	}
	host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded, RouteRun: 1, UpdatedAt: terminalAt.Add(time.Second), ResultJSON: `{"images":[{"resourceId":"recovered-resource"}]}`}
	host.resources["recovered-resource"] = &model.Resource{ID: "recovered-resource", UserID: "user-1", Status: model.ResourceStatusReady, MimeType: "image/png"}
	forceDeliveryReady(t, manager, record.ID)

	manager.materializeReadyTasks()
	assertDeliveryState(t, manager, record.ID, "complete")
	outputs, err := manager.journal.outputs(record.ID)
	if err != nil || len(outputs) != 1 || outputs[0].ResourceID != "recovered-resource" || outputs[0].State != outputBound || host.upserts != 1 {
		t.Fatalf("outputs=%+v upserts=%d err=%v, want recovered prewrite output", outputs, host.upserts, err)
	}
}

func TestRetryObserverWinsAgainstStaleFailedMaterializerRead(t *testing.T) {
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	record, _, _ := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
	_ = manager.journal.bindTask(record.ID, "user-1", "task-1")
	host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Status: model.TaskStatusFailed}
	host.taskReadStarted = make(chan struct{}, 1)
	host.taskReadRelease = make(chan struct{})

	materialized := make(chan struct{})
	go func() {
		manager.materializeReadyTasks()
		close(materialized)
	}()
	<-host.taskReadStarted
	host.mu.Lock()
	host.tasks["task-1"].Status = model.TaskStatusQueued
	host.mu.Unlock()
	retried := make(chan struct{})
	go func() {
		host.retryObserver("user-1", "task-1")
		close(retried)
	}()
	close(host.taskReadRelease)
	<-materialized
	<-retried
	assertDeliveryState(t, manager, record.ID, "pending")
}

func TestMaterializerContinuesOtherOutputsAfterOneBecomesUnavailable(t *testing.T) {
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	record, _, _ := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
	_ = manager.journal.bindTask(record.ID, "user-1", "task-1")
	host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded, ResultJSON: `{"images":[{"resourceId":"resource-1"},{"resourceId":"resource-2"}]}`}
	for _, id := range []string{"resource-1", "resource-2"} {
		host.resources[id] = &model.Resource{ID: id, UserID: "user-1", Status: model.ResourceStatusReady, MimeType: "image/png"}
	}
	// The first output remains safely retryable after a lookup failure. The
	// second reaches an ambiguous write failure and becomes terminal.
	host.assetLookupFailures = 1
	host.upsertFailures = 1
	manager.materializeReadyTasks()
	assertDeliveryState(t, manager, record.ID, "pending")
	outputs, _ := manager.journal.outputs(record.ID)
	if len(outputs) != 2 || outputs[0].State != outputPrepared || outputs[1].State != outputAttempted {
		t.Fatalf("outputs=%+v, want prepared plus attempted before reconciliation", outputs)
	}

	forceDeliveryReady(t, manager, record.ID)
	manager.materializeReadyTasks()
	operation := assertDeliveryState(t, manager, record.ID, "failed")
	if host.upserts != 1 {
		t.Fatalf("successful independent outputs=%d, want 1", host.upserts)
	}
	outputs, _ = manager.journal.outputs(record.ID)
	data := map[string]any{}
	projectOperationFields(manager, data, operation, outputs)
	if data["assetRegistrationState"] != "partial" || data["assetRegistrationVersion"] != nil {
		t.Fatalf("projection=%+v, want unversioned partial state", data)
	}
}

func TestFailedTaskProjectsNoMaterializationNeeded(t *testing.T) {
	host := newFakeHost()
	manager, err := NewManager(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	record, _, _ := manager.journal.claim("user-1", "operation-1", "fingerprint", "image")
	_ = manager.journal.bindTask(record.ID, "user-1", "task-1")
	host.tasks["task-1"] = &model.Task{ID: "task-1", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusFailed}

	manager.materializeReadyTasks()
	operation := assertDeliveryState(t, manager, record.ID, "complete")
	data := map[string]any{}
	projectOperationFields(manager, data, operation, nil)
	if data["assetRegistrationState"] != "none" || data["outputCount"] != 0 {
		t.Fatalf("projection=%+v, want terminal none with zero outputs", data)
	}
}

func forceDeliveryReady(t *testing.T, manager *Manager, operationID string) {
	t.Helper()
	if err := manager.journal.db.Model(&operationRecord{}).Where("id = ?", operationID).Update("next_attempt_at", time.Now().UTC().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
}

func assertDeliveryState(t *testing.T, manager *Manager, operationID, expected string) *operationRecord {
	t.Helper()
	var operation operationRecord
	if err := manager.journal.db.First(&operation, "id = ?", operationID).Error; err != nil {
		t.Fatal(err)
	}
	if operation.DeliveryState != expected {
		t.Fatalf("delivery state=%q error=%q, want %q", operation.DeliveryState, operation.DeliveryErrorCode, expected)
	}
	return &operation
}
