import { describe, expect, test } from "bun:test";

import { safeWorkbenchDownloadURL, taskOutputPreviews, workbenchDeliveryState, type ExpandGenerationTask } from "../../src/open-ai-canvas-expand/workbench-task-output";
import { workbenchTaskSnapshot } from "../../src/pages/workbench/image-workbench-page";

describe("expand-openapi task projection", () => {
    const registeredTask = {
        id: "task-registered",
        type: "canvas_image",
        status: "succeeded",
        prompt: "snow",
        attempts: 1,
        createdAt: "2026-10-19T10:00:00Z",
        updatedAt: "2026-10-19T10:00:00Z",
        assetRegistrationVersion: 1,
        outputCount: 2,
        outputs: [
            { outputIndex: 0, mediaType: "image", resourceId: "resource-1", materializedAssetId: "asset-1" },
            { outputIndex: 1, mediaType: "image", resourceId: "resource-2", materializationErrorCode: "asset_unavailable" },
        ],
    } satisfies ExpandGenerationTask;

    test("uses only the facade projection to expose ready and unavailable outputs", () => {
        expect(taskOutputPreviews(registeredTask, true).map((output) => output.status)).toEqual(["ready", "unavailable"]);
    });

    test("keeps projected outputs in saving state until the registration journal is visible", () => {
        expect(taskOutputPreviews(registeredTask, false)[0]).toMatchObject({ status: "saving", assetId: "asset-1" });
    });

    test("keeps sparse partial output indexes stable", () => {
        const outputs = taskOutputPreviews({
            ...registeredTask,
            status: "failed",
            outputCount: 3,
            outputs: [{ outputIndex: 2, mediaType: "image", resourceId: "resource-3", materializedAssetId: "asset-3" }],
        }, true);
        expect(outputs.map((output) => output.status)).toEqual(["failed", "failed", "ready"]);
    });

    test("keeps legacy host image and video results available without registering them again", () => {
        const image = taskOutputPreviews({ ...registeredTask, id: "legacy-image", outputs: undefined, outputCount: undefined, assetRegistrationVersion: undefined, resultJson: JSON.stringify({ mode: "image", images: [{ url: "https://legacy/image.png" }] }) });
        const video = taskOutputPreviews({ ...registeredTask, id: "legacy-video", type: "canvas_video", outputs: undefined, outputCount: undefined, assetRegistrationVersion: undefined, resultJson: JSON.stringify({ mode: "video", video: { url: "https://legacy/video.mp4" } }) });
        expect(image[0]).toMatchObject({ status: "ready", url: "https://legacy/image.png" });
        expect(video[0]).toMatchObject({ status: "ready", url: "https://legacy/video.mp4" });
    });

    test("shows a facade-level materialization failure instead of an endless saving state", () => {
        const outputs = taskOutputPreviews({ ...registeredTask, outputs: [], outputCount: 1, assetRegistrationVersion: undefined, assetRegistrationState: "failed", materializationErrorCode: "registration_failed" });
        expect(outputs[0]?.status).toBe("failed");
    });

    test("preview and queue distinguish partial delivery, deleted outputs and terminal failure", () => {
        const partial = { ...registeredTask, assetRegistrationVersion: undefined, assetRegistrationState: "partial", materializationErrorCode: "asset_write_unknown" };
        expect(taskOutputPreviews(partial).map((output) => output.status)).toEqual(["ready", "unavailable"]);
        expect(workbenchDeliveryState(partial)).toEqual({ status: "completed", label: "部分产物不可用" });
        expect(workbenchDeliveryState({ ...registeredTask, outputs: [], assetRegistrationState: "failed", materializationErrorCode: "asset_write_unknown" })).toEqual({ status: "failed", label: "保存失败" });
        expect(workbenchDeliveryState({ ...registeredTask, outputCount: 1, outputs: [{ outputIndex: 0, mediaType: "image", materializationErrorCode: "asset_deleted" }] })).toEqual({ status: "unavailable", label: "产物不可用" });
    });
});

test("download URLs reject executable and local file schemes", () => {
    expect(safeWorkbenchDownloadURL("javascript:alert(1)")).toBeNull();
    expect(safeWorkbenchDownloadURL("file:///tmp/private.png")).toBeNull();
    expect(safeWorkbenchDownloadURL("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeWorkbenchDownloadURL("data:image/png;base64,AA==")).toBe("data:image/png;base64,AA==");
    expect(safeWorkbenchDownloadURL("/api/expand-openapi/v1/resources/r-1/file")).toStartWith("https://local.invalid/api/expand-openapi/");
});

test("mask history retains source identity without extending the host Task type", () => {
    const snapshot = workbenchTaskSnapshot({
        inputJson: JSON.stringify({
            metadata: {
                workbenchKind: "image",
                edit: "mask",
                sourceTaskId: "source-task",
                sourceResourceId: "source-resource",
                workbench: { kind: "image", parameters: {}, references: [] },
            },
        }),
    } as ExpandGenerationTask);
    expect(snapshot).toMatchObject({ edit: "mask", sourceTaskId: "source-task", sourceResourceId: "source-resource" });
});
