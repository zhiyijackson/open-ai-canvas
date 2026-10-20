package expandopenapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

var openAPIDocument = buildOpenAPIDocument()

func serveCapabilities(c *gin.Context) {
	if c.Request.Method != http.MethodGet {
		writeFacadeError(c, http.StatusMethodNotAllowed, "expand_openapi_method_not_allowed")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"code": 0,
		"data": gin.H{
			"contractVersion":  ContractVersion,
			"upstreamBasePath": UpstreamBasePath,
			"guarantees": gin.H{
				"authentication": "delegated-to-host",
				"authorization":  "delegated-to-host",
				"billing":        "delegated-to-host",
				"writeRetries":   "disabled",
			},
			"limitations": gin.H{
				"deployment": "single-host-process-with-local-expand-journal",
			},
			"features": gin.H{
				"clientOperationIdIdempotency":       true,
				"automaticFullAssetLibraryInsertion": true,
				"assetRegistrationVersion":           1,
			},
		},
		"msg": "ok",
	})
}

func serveOpenAPI(c *gin.Context) {
	if c.Request.Method != http.MethodGet {
		writeFacadeError(c, http.StatusMethodNotAllowed, "expand_openapi_method_not_allowed")
		return
	}
	c.Data(http.StatusOK, "application/json; charset=utf-8", openAPIDocument)
}

func buildOpenAPIDocument() []byte {
	paths := make(map[string]any)
	for _, route := range allowedRoutes {
		contractPath, parameters := openAPIPath(route.pattern)
		methods, ok := paths[contractPath].(map[string]any)
		if !ok {
			methods = make(map[string]any)
			paths[contractPath] = methods
		}
		operation := operationContract(route)
		operation["summary"] = "Delegates to the existing host API using host-owned DTOs"
		operation["security"] = []any{map[string]any{"cookieAuth": []any{}}}
		if len(parameters) > 0 {
			existing, _ := operation["parameters"].([]any)
			operation["parameters"] = append(parameters, existing...)
		}
		methods[strings.ToLower(route.method)] = operation
	}
	paths["/capabilities"] = map[string]any{
		"get": map[string]any{"summary": "Facade guarantees and baseline limitations", "responses": map[string]any{"200": map[string]any{"description": "Capabilities"}}},
	}
	paths["/openapi.json"] = map[string]any{
		"get": map[string]any{"summary": "This contract", "responses": map[string]any{"200": map[string]any{"description": "OpenAPI document"}}},
	}

	document := map[string]any{
		"openapi": "3.0.3",
		"info": map[string]any{
			"title":       "Open AI Canvas Expand Facade",
			"version":     ContractVersion,
			"description": "A fixed allowlist over existing host handlers. Stable integration fields are documented; provider-specific and asset payload extensions remain open.",
		},
		"servers": []any{map[string]any{"url": "/api" + FacadeBasePath}},
		"paths":   paths,
		"components": map[string]any{
			"securitySchemes": map[string]any{
				"cookieAuth": map[string]any{"type": "apiKey", "in": "cookie", "name": "open_ai_canvas_session"},
			},
			"schemas": contractSchemas(),
		},
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		panic(err)
	}
	return encoded
}

func operationContract(route allowedRoute) map[string]any {
	operation := map[string]any{
		"responses": map[string]any{
			"default": responseWithSchema("Host error envelope", "#/components/schemas/ErrorEnvelope"),
		},
	}
	responses := operation["responses"].(map[string]any)
	responses["200"] = responseWithSchema("Host success envelope", "#/components/schemas/GenericSuccessEnvelope")

	switch route.method + " " + route.pattern {
	case http.MethodGet + " /workbench/tools":
		operation["parameters"] = []any{queryParameter("kind", "string", true, []string{"image", "video"})}
		responses["200"] = responseWithSchema("Workbench tool directory", "#/components/schemas/WorkbenchToolsEnvelope")
	case http.MethodGet + " /workbench/tasks":
		operation["parameters"] = []any{
			queryParameter("kind", "string", true, []string{"image", "video"}),
			queryParameter("clientOperationId", "string", false, nil),
			queryParameter("activeOnly", "boolean", false, nil),
			boundedIntegerQuery("pageSize", 1, 100, false),
		}
		responses["200"] = responseWithSchema("Workbench task summaries", "#/components/schemas/TaskListEnvelope")
	case http.MethodPost + " /workbench/tasks":
		operation["requestBody"] = jsonRequestBody("#/components/schemas/WorkbenchTaskInput", true)
		responses["200"] = responseWithSchema("Created task detail", "#/components/schemas/TaskEnvelope")
	case http.MethodPost + " /tasks":
		operation["requestBody"] = jsonRequestBody("#/components/schemas/DirectTaskInput", true)
		responses["200"] = responseWithSchema("Created task detail", "#/components/schemas/TaskEnvelope")
	case http.MethodGet + " /tasks":
		operation["parameters"] = []any{
			queryParameter("projectId", "string", false, nil),
			queryParameter("activeOnly", "boolean", false, nil),
			boundedIntegerQuery("pageSize", 1, 100, false),
		}
		responses["200"] = responseWithSchema("Task summaries", "#/components/schemas/TaskListEnvelope")
	case http.MethodGet + " /tasks/:id",
		http.MethodPost + " /tasks/:id/cancel",
		http.MethodPost + " /tasks/:id/retry",
		http.MethodPost + " /tasks/:id/recover-media":
		responses["200"] = responseWithSchema("Task detail", "#/components/schemas/TaskEnvelope")
	case http.MethodGet + " /assets":
		operation["parameters"] = []any{
			boundedIntegerQuery("page", 1, 0, false), boundedIntegerQuery("pageSize", 1, 120, false),
			queryParameter("kind", "string", false, nil), queryParameter("category", "string", false, nil),
			queryParameter("folderId", "string", false, nil), queryParameter("uncategorized", "string", false, []string{"0", "1"}),
			queryParameter("status", "string", false, nil), queryParameter("q", "string", false, nil),
		}
		responses["200"] = responseWithSchema("Asset list or paged asset list", "#/components/schemas/AssetListEnvelope")
	case http.MethodGet + " /assets/:id":
		responses["200"] = responseWithSchema("Asset", "#/components/schemas/AssetEnvelope")
	case http.MethodPut + " /assets/:id":
		operation["requestBody"] = jsonRequestBody("#/components/schemas/AssetUpdateRequest", true)
		responses["200"] = responseWithSchema("Updated asset", "#/components/schemas/AssetEnvelope")
	case http.MethodPost + " /assets/batch":
		operation["requestBody"] = jsonRequestBody("#/components/schemas/AssetBatchRequest", true)
		responses["200"] = responseWithSchema("Assets", "#/components/schemas/AssetListEnvelope")
	case http.MethodPost + " /assets/batch-delete":
		operation["requestBody"] = map[string]any{
			"required": true,
			"content":  map[string]any{"application/json": map[string]any{"schema": arraySchema(stringSchema())}},
		}
	case http.MethodPost + " /resources":
		operation["parameters"] = []any{headerParameter("X-Idempotency-Key", false)}
		operation["requestBody"] = map[string]any{
			"required": true,
			"content": map[string]any{"multipart/form-data": map[string]any{"schema": map[string]any{
				"type": "object", "required": []string{"file"},
				"properties": map[string]any{
					"file":  map[string]any{"type": "string", "format": "binary"},
					"kind":  map[string]any{"type": "string", "description": "Optional client hint; the host infers the stored kind from detected media type"},
					"width": map[string]any{"type": "integer", "minimum": 0}, "height": map[string]any{"type": "integer", "minimum": 0},
					"durationMs": map[string]any{"type": "integer", "format": "int64", "minimum": 0},
				},
			}}},
		}
		responses["200"] = responseWithSchema("Uploaded resource", "#/components/schemas/ResourceEnvelope")
	case http.MethodGet + " /resources":
		operation["parameters"] = []any{boundedIntegerQuery("pageSize", 1, 200, false)}
		responses["200"] = responseWithSchema("Resources", "#/components/schemas/ResourceListEnvelope")
	case http.MethodGet + " /resources/:id":
		responses["200"] = responseWithSchema("Resource", "#/components/schemas/ResourceEnvelope")
	case http.MethodGet + " /resources/:id/file":
		responses["200"] = map[string]any{
			"description": "Original resource bytes; Range and content headers are preserved",
			"content":     map[string]any{"application/octet-stream": map[string]any{"schema": map[string]any{"type": "string", "format": "binary"}}},
		}
	}
	return operation
}

func contractSchemas() map[string]any {
	openObject := func(properties map[string]any, required ...string) map[string]any {
		result := map[string]any{"type": "object", "properties": properties, "additionalProperties": true}
		if len(required) > 0 {
			result["required"] = required
		}
		return result
	}
	asset := openObject(map[string]any{
		"id": stringSchema(), "kind": map[string]any{"type": "string", "enum": []string{"text", "image", "video", "audio", "model", "entity"}},
		"title": stringSchema(), "coverUrl": stringSchema(), "tags": arraySchema(stringSchema()), "folderId": stringSchema(),
		"category": stringSchema(), "status": stringSchema(), "primaryVersionId": stringSchema(), "source": stringSchema(),
		"note": stringSchema(), "createdAt": dateTimeSchema(), "updatedAt": dateTimeSchema(),
		"metadata": map[string]any{"type": "object", "additionalProperties": true},
		"data":     map[string]any{"type": "object", "additionalProperties": true},
	}, "id", "kind", "title")
	resource := openObject(map[string]any{
		"id": stringSchema(), "kind": stringSchema(), "status": stringSchema(), "provider": stringSchema(),
		"publicUrl": stringSchema(), "mimeType": stringSchema(), "size": map[string]any{"type": "integer", "format": "int64"},
		"width": map[string]any{"type": "integer"}, "height": map[string]any{"type": "integer"},
		"durationMs": map[string]any{"type": "integer", "format": "int64"}, "createdAt": dateTimeSchema(), "updatedAt": dateTimeSchema(),
	}, "id", "kind", "status")
	task := openObject(map[string]any{
		"id": stringSchema(), "projectId": stringSchema(), "type": stringSchema(),
		"status": map[string]any{"type": "string", "enum": []string{"queued", "running", "succeeded", "failed", "cancelled", "text_replay"}},
		"stage":  stringSchema(), "mediaStage": stringSchema(), "canRecoverMedia": map[string]any{"type": "boolean"},
		"progress": map[string]any{"type": "integer", "minimum": 0, "maximum": 100}, "prompt": stringSchema(),
		"operation": stringSchema(), "provider": stringSchema(), "model": stringSchema(), "providerRequestId": stringSchema(),
		"previewUrl": stringSchema(), "previewKind": stringSchema(), "previewPosterUrl": stringSchema(),
		"attempts": map[string]any{"type": "integer"}, "startedAt": nullableDateTimeSchema(), "completedAt": nullableDateTimeSchema(),
		"createdAt": dateTimeSchema(), "updatedAt": dateTimeSchema(),
		"billing":       map[string]any{"type": "object", "additionalProperties": true},
		"clientContext": map[string]any{"type": "object", "additionalProperties": true},
	}, "id", "type", "status", "stage", "progress", "prompt", "attempts", "createdAt", "updatedAt")
	taskDetail := openObject(map[string]any{
		"id": stringSchema(), "userId": stringSchema(), "projectId": stringSchema(), "type": stringSchema(),
		"status": map[string]any{"type": "string", "enum": []string{"queued", "running", "succeeded", "failed", "cancelled", "text_replay"}},
		"stage":  stringSchema(), "progress": map[string]any{"type": "integer", "minimum": 0, "maximum": 100},
		"prompt": stringSchema(), "operation": stringSchema(), "provider": stringSchema(), "model": stringSchema(),
		"logicalModelId": stringSchema(), "billingOrderId": stringSchema(), "providerRequestId": stringSchema(),
		"providerCancelStatus": stringSchema(), "providerCancelError": stringSchema(), "providerCancelAttempts": map[string]any{"type": "integer"},
		"providerCancelRequestedAt": nullableDateTimeSchema(), "providerCancelledAt": nullableDateTimeSchema(),
		"pollStage": stringSchema(), "nextPollAt": nullableDateTimeSchema(),
		"inputJson":  map[string]any{"type": "string", "description": "Sanitized host-owned JSON snapshot"},
		"resultJson": map[string]any{"type": "string", "description": "Host-owned task result JSON"},
		"mediaStage": stringSchema(), "canRecoverMedia": map[string]any{"type": "boolean"}, "textDraft": stringSchema(),
		"clientOperationId": stringSchema(), "assetRegistrationVersion": map[string]any{"type": "integer"},
		"assetRegistrationState": stringSchema(), "materializationErrorCode": stringSchema(),
		"outputCount": map[string]any{"type": "integer"}, "outputs": map[string]any{"type": "array", "items": map[string]any{"type": "object", "additionalProperties": true}},
		"error": stringSchema(), "attempts": map[string]any{"type": "integer"}, "diagnostic": map[string]any{"type": "object", "additionalProperties": true},
		"startedAt": nullableDateTimeSchema(), "completedAt": nullableDateTimeSchema(), "createdAt": dateTimeSchema(), "updatedAt": dateTimeSchema(),
	}, "id", "userId", "projectId", "type", "status", "stage", "progress", "prompt", "operation", "provider", "model", "inputJson", "resultJson", "error", "attempts", "createdAt", "updatedAt")
	workbenchTool := openObject(map[string]any{
		"id": stringSchema(), "kind": map[string]any{"type": "string", "enum": []string{"image", "video"}},
		"categoryId": stringSchema(), "name": stringSchema(), "subtitle": stringSchema(), "description": stringSchema(),
		"iconUrl": stringSchema(), "coverUrl": stringSchema(), "sortOrder": map[string]any{"type": "integer"},
		"capability":    map[string]any{"type": "object", "additionalProperties": true},
		"guide":         map[string]any{"type": "object", "additionalProperties": true},
		"inputContract": map[string]any{"type": "object", "additionalProperties": true},
		"presets":       arraySchema(map[string]any{"type": "object", "additionalProperties": true}),
	}, "id", "kind", "categoryId", "name", "presets")
	workbenchInput := closedObject(map[string]any{
		"clientOperationId": stringSchema(),
		"kind":              map[string]any{"type": "string", "enum": []string{"image", "video"}}, "toolId": stringSchema(), "presetId": stringSchema(),
		"workbench": closedObject(map[string]any{"kind": map[string]any{"type": "string", "enum": []string{"image", "video"}}, "toolId": stringSchema(), "presetId": stringSchema()}, "kind", "toolId"),
		"prompt":    stringSchema(), "model": stringSchema(), "logicalModelId": stringSchema(), "channelId": stringSchema(),
		"modelChoice": closedObject(map[string]any{"logicalModelId": stringSchema(), "userChannelId": stringSchema(), "modelName": stringSchema()}),
		"parameters":  map[string]any{"type": "object", "additionalProperties": true},
		"references": map[string]any{"type": "array", "maxItems": 20, "items": closedObject(map[string]any{
			"resourceId": stringSchema(), "kind": map[string]any{"type": "string", "enum": []string{"image", "video", "audio"}},
			"role": map[string]any{"type": "string", "enum": []string{"reference", "first_frame", "last_frame"}}, "slotKey": stringSchema(),
		}, "resourceId", "kind")},
	}, "clientOperationId", "kind", "prompt")
	directTaskInput := openObject(map[string]any{
		"clientOperationId": stringSchema(), "type": map[string]any{"type": "string", "enum": []string{"canvas_image", "canvas_video"}}, "operation": stringSchema(),
		"prompt": stringSchema(), "provider": stringSchema(), "model": stringSchema(),
		"logicalModelId": stringSchema(), "projectId": stringSchema(),
		"input": map[string]any{"type": "object", "additionalProperties": true},
	}, "clientOperationId", "type", "prompt")
	assetListData := openObject(map[string]any{
		"assets": arraySchema(asset), "kindCounts": integerMapSchema(), "categoryCounts": integerMapSchema(), "folderCounts": integerMapSchema(),
		"page": map[string]any{"type": "integer"}, "pageSize": map[string]any{"type": "integer"}, "total": map[string]any{"type": "integer", "format": "int64"}, "hasMore": map[string]any{"type": "boolean"},
	}, "assets")

	return map[string]any{
		"ErrorEnvelope": openObject(map[string]any{
			"code": map[string]any{"type": "integer"}, "data": map[string]any{"nullable": true}, "msg": stringSchema(), "reason": stringSchema(),
			"details": openObject(map[string]any{
				"expandOperationState": map[string]any{"type": "string", "enum": []string{"rejected"}, "description": "The journal confirms this operation was not accepted; its frozen submission may be released."},
				"expandRequestState":   map[string]any{"type": "string", "enum": []string{"rejected"}, "description": "This request was not dispatched; an earlier attempt with the same key remains unknown."},
			}),
		}, "code", "data", "msg"),
		"GenericSuccessEnvelope": successEnvelopeSchema(map[string]any{"type": "object", "additionalProperties": true}),
		"TaskSummary":            task, "TaskDetail": taskDetail, "WorkbenchTaskInput": workbenchInput, "DirectTaskInput": directTaskInput, "WorkbenchTool": workbenchTool,
		"TaskEnvelope":           successEnvelopeSchema(schemaRef("TaskDetail")),
		"TaskListEnvelope":       successEnvelopeSchema(arraySchema(schemaRef("TaskSummary"))),
		"WorkbenchToolsEnvelope": successEnvelopeSchema(openObject(map[string]any{"tools": arraySchema(schemaRef("WorkbenchTool"))}, "tools")),
		"Asset":                  asset, "AssetUpdateRequest": openObject(map[string]any{"asset": schemaRef("Asset")}, "asset"),
		"AssetBatchRequest": openObject(map[string]any{"ids": arraySchema(stringSchema())}, "ids"),
		"AssetListData":     assetListData, "AssetListEnvelope": successEnvelopeSchema(schemaRef("AssetListData")),
		"AssetEnvelope": successEnvelopeSchema(openObject(map[string]any{"asset": schemaRef("Asset")}, "asset")),
		"Resource":      resource, "ResourceEnvelope": successEnvelopeSchema(openObject(map[string]any{"resource": schemaRef("Resource")}, "resource")),
		"ResourceListEnvelope": successEnvelopeSchema(openObject(map[string]any{"resources": arraySchema(schemaRef("Resource"))}, "resources")),
	}
}

func successEnvelopeSchema(data map[string]any) map[string]any {
	return map[string]any{
		"type": "object", "additionalProperties": false, "required": []string{"code", "data", "msg"},
		"properties": map[string]any{"code": map[string]any{"type": "integer", "enum": []int{0}}, "data": data, "msg": stringSchema()},
	}
}

func closedObject(properties map[string]any, required ...string) map[string]any {
	result := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		result["required"] = required
	}
	return result
}

func responseWithSchema(description string, ref string) map[string]any {
	return map[string]any{"description": description, "content": map[string]any{"application/json": map[string]any{"schema": map[string]any{"$ref": ref}}}}
}

func jsonRequestBody(ref string, required bool) map[string]any {
	return map[string]any{"required": required, "content": map[string]any{"application/json": map[string]any{"schema": map[string]any{"$ref": ref}}}}
}

func queryParameter(name string, schemaType string, required bool, values []string) map[string]any {
	schema := map[string]any{"type": schemaType}
	if len(values) > 0 {
		schema["enum"] = values
	}
	return map[string]any{"name": name, "in": "query", "required": required, "schema": schema}
}

func boundedIntegerQuery(name string, minimum int, maximum int, required bool) map[string]any {
	schema := map[string]any{"type": "integer", "minimum": minimum}
	if maximum > 0 {
		schema["maximum"] = maximum
	}
	return map[string]any{"name": name, "in": "query", "required": required, "schema": schema}
}

func headerParameter(name string, required bool) map[string]any {
	return map[string]any{"name": name, "in": "header", "required": required, "schema": stringSchema()}
}

func schemaRef(name string) map[string]any {
	return map[string]any{"$ref": "#/components/schemas/" + name}
}
func stringSchema() map[string]any   { return map[string]any{"type": "string"} }
func dateTimeSchema() map[string]any { return map[string]any{"type": "string", "format": "date-time"} }
func nullableDateTimeSchema() map[string]any {
	return map[string]any{"type": "string", "format": "date-time", "nullable": true}
}
func arraySchema(items map[string]any) map[string]any {
	return map[string]any{"type": "array", "items": items}
}
func integerMapSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "integer", "format": "int64"}}
}

func openAPIPath(pattern string) (string, []any) {
	parts := strings.Split(pattern, "/")
	parameters := make([]any, 0)
	for index, part := range parts {
		if !strings.HasPrefix(part, ":") {
			continue
		}
		name := strings.TrimPrefix(part, ":")
		parts[index] = "{" + name + "}"
		parameters = append(parameters, map[string]any{
			"name":     name,
			"in":       "path",
			"required": true,
			"schema":   map[string]any{"type": "string"},
		})
	}
	return strings.Join(parts, "/"), parameters
}
