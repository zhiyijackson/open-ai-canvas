package expandopenapi

import (
	"encoding/json"
	"testing"
)

func TestDirectTaskContractMatchesAllowedTaskTypes(t *testing.T) {
	var document map[string]any
	if err := json.Unmarshal(buildOpenAPIDocument(), &document); err != nil {
		t.Fatal(err)
	}
	schemas := objectAt(t, objectAt(t, document, "components"), "schemas")
	direct := objectAt(t, schemas, "DirectTaskInput")
	assertRequiredFields(t, direct, "clientOperationId", "type", "prompt")
	values := objectAt(t, objectAt(t, direct, "properties"), "type")["enum"].([]any)
	if len(values) != 2 {
		t.Fatalf("unexpected allowed task types: %v", values)
	}
	for _, value := range values {
		if !isSupportedDirectTask(map[string]any{"type": value}) {
			t.Fatalf("documented type %v is rejected by server", value)
		}
	}
	for _, value := range []any{nil, "image-edit", "canvas_audio"} {
		if isSupportedDirectTask(map[string]any{"type": value}) {
			t.Fatalf("unsupported type %v accepted", value)
		}
	}
}
