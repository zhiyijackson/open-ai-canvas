import { describe, expect, test } from "bun:test";

import { clearOpenAiCanvasExpandSession } from "../../src/open-ai-canvas-expand/session-cleanup";
import { readWorkbenchDraft, workbenchSessionEpoch, writeWorkbenchDraft } from "../../src/open-ai-canvas-expand/workbench-session";

describe("open-ai-canvas-expand session cleanup", () => {
    test("invalidates in-memory workbench state before persisted director cleanup settles", async () => {
        const scope = "session-cleanup-user";
        const previousEpoch = workbenchSessionEpoch(scope);
        writeWorkbenchDraft(scope, "image", {
            prompt: "旧账号草稿",
            model: "image-model",
            parameters: {},
            references: [],
        });

        const cleanup = clearOpenAiCanvasExpandSession(scope);

        expect(workbenchSessionEpoch(scope)).toBe(previousEpoch + 1);
        expect(readWorkbenchDraft(scope, "image")).toBeNull();
        await cleanup;
    });
});
