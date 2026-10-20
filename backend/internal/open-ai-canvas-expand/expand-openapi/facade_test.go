package expandopenapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestFacadeDelegatesAllowedRequestWithoutMutatingOriginal(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var upstreamRequest *http.Request
	var upstreamBody string
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamRequest = r
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		upstreamBody = string(body)
		w.Header().Set("X-Upstream", "preserved")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"delegated":true}`))
	})
	engine := newFacadeEngine(upstream)
	request := httptest.NewRequest(http.MethodPost, "/api/expand-openapi/v1/workbench/tasks?kind=image&target=https://evil.example", strings.NewReader(`{"prompt":"snow"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Expand-OpenAPI-Target", "https://evil.example")
	request.AddCookie(&http.Cookie{Name: "open_ai_canvas_session", Value: "session-value"})
	originalPath, originalRequestURI := request.URL.Path, request.RequestURI
	recorder := httptest.NewRecorder()

	engine.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusAccepted || recorder.Header().Get("X-Upstream") != "preserved" || recorder.Body.String() != `{"delegated":true}` {
		t.Fatalf("response was not preserved: status=%d headers=%v body=%q", recorder.Code, recorder.Header(), recorder.Body.String())
	}
	if upstreamRequest == nil {
		t.Fatal("upstream was not called")
	}
	if upstreamRequest.URL.Path != "/api/workbench/tasks" || upstreamRequest.URL.RawQuery != "kind=image&target=https://evil.example" {
		t.Fatalf("unexpected upstream target: %s?%s", upstreamRequest.URL.Path, upstreamRequest.URL.RawQuery)
	}
	if upstreamRequest.Host != "example.com" {
		t.Fatalf("facade selected a different target host: %q", upstreamRequest.Host)
	}
	if upstreamBody != `{"prompt":"snow"}` {
		t.Fatalf("body changed: %q", upstreamBody)
	}
	if cookie, err := upstreamRequest.Cookie("open_ai_canvas_session"); err != nil || cookie.Value != "session-value" {
		t.Fatalf("cookie was not delegated: cookie=%v err=%v", cookie, err)
	}
	if request.URL.Path != originalPath || request.RequestURI != originalRequestURI {
		t.Fatalf("original request mutated: path=%q requestURI=%q", request.URL.Path, request.RequestURI)
	}
}

func TestFacadeRejectsUnknownAdminTraversalAndEncodedSeparators(t *testing.T) {
	gin.SetMode(gin.TestMode)
	called := 0
	engine := newFacadeEngine(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called++ }))
	tests := []struct {
		name   string
		method string
		target string
		status int
	}{
		{name: "admin", method: http.MethodGet, target: "/api/expand-openapi/v1/admin/users", status: http.StatusNotFound},
		{name: "literal traversal", method: http.MethodGet, target: "/api/expand-openapi/v1/tasks/../admin", status: http.StatusNotFound},
		{name: "encoded traversal", method: http.MethodGet, target: "/api/expand-openapi/v1/tasks/%2e%2e/admin", status: http.StatusNotFound},
		{name: "encoded slash", method: http.MethodGet, target: "/api/expand-openapi/v1/tasks/task%2Fadmin", status: http.StatusNotFound},
		{name: "reserved resource route", method: http.MethodGet, target: "/api/expand-openapi/v1/resources/storage-usage", status: http.StatusNotFound},
		{name: "reserved asset route", method: http.MethodGet, target: "/api/expand-openapi/v1/assets/batch", status: http.StatusMethodNotAllowed},
		{name: "wrong method", method: http.MethodDelete, target: "/api/expand-openapi/v1/workbench/tasks", status: http.StatusMethodNotAllowed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(test.method, test.target, nil)
			engine.ServeHTTP(recorder, request)
			if recorder.Code != test.status {
				t.Fatalf("status=%d want=%d body=%s", recorder.Code, test.status, recorder.Body.String())
			}
		})
	}
	if called != 0 {
		t.Fatalf("upstream called %d times for rejected requests", called)
	}
}

func TestFacadePreservesHostErrorsAndAuthenticationDecision(t *testing.T) {
	gin.SetMode(gin.TestMode)
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := r.Cookie("open_ai_canvas_session"); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"code":401,"reason":"host_session_required"}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	engine := newFacadeEngine(upstream)

	unauthorized := httptest.NewRecorder()
	engine.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/api/expand-openapi/v1/auth/session", nil))
	if unauthorized.Code != http.StatusUnauthorized || unauthorized.Body.String() != `{"code":401,"reason":"host_session_required"}` {
		t.Fatalf("host error changed: status=%d body=%q", unauthorized.Code, unauthorized.Body.String())
	}

	authorizedRequest := httptest.NewRequest(http.MethodGet, "/api/expand-openapi/v1/auth/session", nil)
	authorizedRequest.AddCookie(&http.Cookie{Name: "open_ai_canvas_session", Value: "session-value"})
	authorized := httptest.NewRecorder()
	engine.ServeHTTP(authorized, authorizedRequest)
	if authorized.Code != http.StatusNoContent {
		t.Fatalf("host auth result changed: status=%d", authorized.Code)
	}
}

func TestFacadePropagatesCancellationAndStreamingFlush(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Run("cancellation", func(t *testing.T) {
		observedCancellation := false
		engine := newFacadeEngine(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			<-r.Context().Done()
			observedCancellation = true
			w.WriteHeader(499)
		}))
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		request := httptest.NewRequest(http.MethodGet, "/api/expand-openapi/v1/tasks/task_1", nil).WithContext(ctx)
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		if !observedCancellation || recorder.Code != 499 {
			t.Fatalf("cancellation not propagated: observed=%v status=%d", observedCancellation, recorder.Code)
		}
	})

	t.Run("flush", func(t *testing.T) {
		engine := newFacadeEngine(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write([]byte("first"))
			w.(http.Flusher).Flush()
			_, _ = w.Write([]byte("second"))
		}))
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/expand-openapi/v1/resources/resource_1/file", nil))
		if !recorder.Flushed || recorder.Body.String() != "firstsecond" || recorder.Header().Get("Content-Type") != "application/octet-stream" {
			t.Fatalf("stream response changed: flushed=%v type=%q body=%q", recorder.Flushed, recorder.Header().Get("Content-Type"), recorder.Body.String())
		}
	})
}

func TestFacadeContractDescribesOpaqueAllowlistAndLimitations(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := newFacadeEngine(http.NotFoundHandler())

	contractRecorder := httptest.NewRecorder()
	engine.ServeHTTP(contractRecorder, httptest.NewRequest(http.MethodGet, "/api/expand-openapi/v1/openapi.json", nil))
	if contractRecorder.Code != http.StatusOK {
		t.Fatalf("contract status=%d body=%s", contractRecorder.Code, contractRecorder.Body.String())
	}
	var contract map[string]any
	if err := json.Unmarshal(contractRecorder.Body.Bytes(), &contract); err != nil {
		t.Fatal(err)
	}
	paths := contract["paths"].(map[string]any)
	if _, exists := paths["/admin/users"]; exists {
		t.Fatal("admin path leaked into facade contract")
	}
	if _, exists := paths["/workbench/tasks"]; !exists {
		t.Fatal("workbench task path missing from facade contract")
	}
	if _, exists := paths["/tasks/{id}"]; !exists {
		t.Fatal("OpenAPI path parameters are not documented with brace syntax")
	}

	capabilitiesRecorder := httptest.NewRecorder()
	engine.ServeHTTP(capabilitiesRecorder, httptest.NewRequest(http.MethodGet, "/api/expand-openapi/v1/capabilities", nil))
	if capabilitiesRecorder.Code != http.StatusOK || !strings.Contains(capabilitiesRecorder.Body.String(), "clientOperationIdIdempotency") || !strings.Contains(capabilitiesRecorder.Body.String(), "single-host-process") {
		t.Fatalf("expand guarantees or deployment limitation missing: status=%d body=%s", capabilitiesRecorder.Code, capabilitiesRecorder.Body.String())
	}
}

func TestFacadeContractDocumentsCriticalClientShapes(t *testing.T) {
	var contract map[string]any
	if err := json.Unmarshal(openAPIDocument, &contract); err != nil {
		t.Fatal(err)
	}
	paths := objectAt(t, contract, "paths")
	schemas := objectAt(t, objectAt(t, contract, "components"), "schemas")

	workbenchPath := objectAt(t, paths, "/workbench/tasks")
	createWorkbench := objectAt(t, workbenchPath, "post")
	requestBody := objectAt(t, createWorkbench, "requestBody")
	if requestBody["required"] != true {
		t.Fatal("workbench create body must be required")
	}
	assertSchemaRef(t, objectAt(t, objectAt(t, objectAt(t, requestBody, "content"), "application/json"), "schema"), "#/components/schemas/WorkbenchTaskInput")
	workbenchInput := objectAt(t, schemas, "WorkbenchTaskInput")
	assertRequiredFields(t, workbenchInput, "clientOperationId", "kind", "prompt")
	if workbenchInput["additionalProperties"] != false {
		t.Fatal("workbench input must match DisallowUnknownFields")
	}
	workbenchProperties := objectAt(t, workbenchInput, "properties")
	for _, field := range []string{"workbench", "modelChoice"} {
		if objectAt(t, workbenchProperties, field)["additionalProperties"] != false {
			t.Fatalf("nested workbench field %s must reject unknown properties", field)
		}
	}
	references := objectAt(t, workbenchProperties, "references")
	if objectAt(t, references, "items")["additionalProperties"] != false {
		t.Fatal("workbench references must reject unknown properties")
	}
	parametersSchema := objectAt(t, workbenchProperties, "parameters")
	if parametersSchema["additionalProperties"] != true {
		t.Fatal("provider-specific workbench parameters must remain extensible")
	}
	assertResponseRef(t, createWorkbench, "200", "#/components/schemas/TaskEnvelope")
	taskSummary := objectAt(t, schemas, "TaskSummary")
	if _, exists := objectAt(t, taskSummary, "properties")["resultJson"]; exists {
		t.Fatal("task list summary must not claim to contain resultJson")
	}
	statusSchema := objectAt(t, objectAt(t, taskSummary, "properties"), "status")
	if !containsString(statusSchema["enum"].([]any), "text_replay") {
		t.Fatal("task summary status enum omits text_replay")
	}
	taskDetail := objectAt(t, schemas, "TaskDetail")
	assertRequiredFields(t, taskDetail, "inputJson", "resultJson", "error")
	if _, exists := objectAt(t, taskDetail, "properties")["outputs"]; !exists {
		t.Fatal("expand task detail must advertise its projected outputs field")
	}

	listWorkbench := objectAt(t, workbenchPath, "get")
	assertParameter(t, listWorkbench, "query", "kind", true)
	assertParameter(t, listWorkbench, "query", "activeOnly", false)
	pageSize := assertParameter(t, listWorkbench, "query", "pageSize", false)
	if objectAt(t, pageSize, "schema")["maximum"] != float64(100) {
		t.Fatal("workbench pageSize maximum is not documented")
	}
	assertResponseRef(t, listWorkbench, "200", "#/components/schemas/TaskListEnvelope")

	tools := objectAt(t, objectAt(t, paths, "/workbench/tools"), "get")
	assertParameter(t, tools, "query", "kind", true)
	assertResponseRef(t, tools, "200", "#/components/schemas/WorkbenchToolsEnvelope")

	assets := objectAt(t, objectAt(t, paths, "/assets"), "get")
	for _, name := range []string{"page", "pageSize", "kind", "category", "folderId", "uncategorized", "status", "q"} {
		assertParameter(t, assets, "query", name, false)
	}
	assertResponseRef(t, assets, "200", "#/components/schemas/AssetListEnvelope")
	assetSchema := objectAt(t, schemas, "Asset")
	assertRequiredFields(t, assetSchema, "id", "kind", "title")
	if assetSchema["additionalProperties"] != true {
		t.Fatal("host-owned asset extensions must remain open")
	}
	updateAsset := objectAt(t, objectAt(t, paths, "/assets/{id}"), "put")
	assertParameter(t, updateAsset, "path", "id", true)
	assertSchemaRef(t, objectAt(t, objectAt(t, objectAt(t, objectAt(t, updateAsset, "requestBody"), "content"), "application/json"), "schema"), "#/components/schemas/AssetUpdateRequest")

	upload := objectAt(t, objectAt(t, paths, "/resources"), "post")
	assertParameter(t, upload, "header", "X-Idempotency-Key", false)
	multipart := objectAt(t, objectAt(t, objectAt(t, upload, "requestBody"), "content"), "multipart/form-data")
	uploadSchema := objectAt(t, multipart, "schema")
	assertRequiredFields(t, uploadSchema, "file")
	uploadProperties := objectAt(t, uploadSchema, "properties")
	fileSchema := objectAt(t, uploadProperties, "file")
	if fileSchema["format"] != "binary" {
		t.Fatal("resource file field is not documented as binary")
	}
	if _, exists := uploadProperties["kind"]; !exists {
		t.Fatal("resource upload kind hint is undocumented")
	}
	assertResponseRef(t, upload, "200", "#/components/schemas/ResourceEnvelope")

	errorEnvelope := objectAt(t, schemas, "ErrorEnvelope")
	assertRequiredFields(t, errorEnvelope, "code", "data", "msg")
	defaultResponse := objectAt(t, objectAt(t, createWorkbench, "responses"), "default")
	assertSchemaRef(t, objectAt(t, objectAt(t, objectAt(t, defaultResponse, "content"), "application/json"), "schema"), "#/components/schemas/ErrorEnvelope")
}

func TestFacadeCanDispatchThroughSameGinRootWithoutRecursion(t *testing.T) {
	gin.SetMode(gin.TestMode)
	root := gin.New()
	middlewarePasses := 0
	root.Use(func(c *gin.Context) {
		middlewarePasses++
		if middlewarePasses > 10 {
			panic("facade request recursed")
		}
		c.Next()
	})
	api := root.Group("/api")
	api.GET("/auth/session", func(c *gin.Context) {
		cookie, err := c.Cookie("open_ai_canvas_session")
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "data": nil, "msg": "Unauthorized", "reason": "host_session_required"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"code": 0, "data": gin.H{"session": cookie}, "msg": "ok"})
	})
	Register(api, root)

	unauthorized := httptest.NewRecorder()
	root.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/api/expand-openapi/v1/auth/session", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("host error status changed: %d body=%s", unauthorized.Code, unauthorized.Body.String())
	}
	var unauthorizedBody map[string]any
	if err := json.Unmarshal(unauthorized.Body.Bytes(), &unauthorizedBody); err != nil || unauthorizedBody["reason"] != "host_session_required" {
		t.Fatalf("host error body changed: err=%v body=%s", err, unauthorized.Body.String())
	}

	authorizedRequest := httptest.NewRequest(http.MethodGet, "/api/expand-openapi/v1/auth/session", nil)
	authorizedRequest.AddCookie(&http.Cookie{Name: "open_ai_canvas_session", Value: "same-root-session"})
	authorized := httptest.NewRecorder()
	root.ServeHTTP(authorized, authorizedRequest)
	if authorized.Code != http.StatusOK || !strings.Contains(authorized.Body.String(), "same-root-session") {
		t.Fatalf("same-root cookie delegation failed: status=%d body=%s", authorized.Code, authorized.Body.String())
	}
	if middlewarePasses != 4 {
		t.Fatalf("expected outer and delegated root middleware passes for two requests, got %d", middlewarePasses)
	}
}

func TestFacadeDoesNotConfuseReservedStaticRouteWithResourceID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	root := gin.New()
	api := root.Group("/api")
	staticCalled := false
	detailID := ""
	api.GET("/resources/storage-usage", func(c *gin.Context) {
		staticCalled = true
		c.Status(http.StatusTeapot)
	})
	api.GET("/resources/:id", func(c *gin.Context) {
		detailID = c.Param("id")
		c.JSON(http.StatusOK, gin.H{"code": 0, "data": gin.H{"resource": gin.H{"id": detailID}}, "msg": "ok"})
	})
	Register(api, root)

	rejected := httptest.NewRecorder()
	root.ServeHTTP(rejected, httptest.NewRequest(http.MethodGet, "/api/expand-openapi/v1/resources/storage-usage", nil))
	if rejected.Code != http.StatusNotFound || staticCalled {
		t.Fatalf("reserved static route escaped facade: status=%d staticCalled=%v", rejected.Code, staticCalled)
	}

	allowed := httptest.NewRecorder()
	root.ServeHTTP(allowed, httptest.NewRequest(http.MethodGet, "/api/expand-openapi/v1/resources/resource_1", nil))
	if allowed.Code != http.StatusOK || detailID != "resource_1" {
		t.Fatalf("resource detail did not delegate: status=%d id=%q body=%s", allowed.Code, detailID, allowed.Body.String())
	}
}

func objectAt(t *testing.T, object map[string]any, key string) map[string]any {
	t.Helper()
	value, ok := object[key].(map[string]any)
	if !ok {
		t.Fatalf("%q is not an object: %#v", key, object[key])
	}
	return value
}

func assertRequiredFields(t *testing.T, schema map[string]any, fields ...string) {
	t.Helper()
	values, ok := schema["required"].([]any)
	if !ok {
		t.Fatalf("schema has no required field list: %#v", schema)
	}
	present := make(map[string]bool, len(values))
	for _, value := range values {
		present[value.(string)] = true
	}
	for _, field := range fields {
		if !present[field] {
			t.Fatalf("required field %q is missing", field)
		}
	}
}

func assertParameter(t *testing.T, operation map[string]any, location string, name string, required bool) map[string]any {
	t.Helper()
	parameters, ok := operation["parameters"].([]any)
	if !ok {
		t.Fatalf("operation has no parameters: %#v", operation)
	}
	for _, value := range parameters {
		parameter := value.(map[string]any)
		if parameter["in"] == location && parameter["name"] == name {
			if parameter["required"] != required {
				t.Fatalf("parameter %s required=%v want=%v", name, parameter["required"], required)
			}
			return parameter
		}
	}
	t.Fatalf("parameter %s in %s is missing", name, location)
	return nil
}

func assertResponseRef(t *testing.T, operation map[string]any, status string, ref string) {
	t.Helper()
	response := objectAt(t, objectAt(t, operation, "responses"), status)
	schema := objectAt(t, objectAt(t, objectAt(t, response, "content"), "application/json"), "schema")
	assertSchemaRef(t, schema, ref)
}

func assertSchemaRef(t *testing.T, schema map[string]any, ref string) {
	t.Helper()
	if schema["$ref"] != ref {
		t.Fatalf("schema ref=%#v want=%s", schema["$ref"], ref)
	}
}

func containsString(values []any, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func newFacadeEngine(upstream http.Handler) *gin.Engine {
	engine := gin.New()
	Register(engine.Group("/api"), upstream)
	return engine
}
