import { describe, expect, test } from "bun:test";

import {
    clearWorkbenchMaskPendingSubmission,
    clearWorkbenchPendingSubmission,
    clearWorkbenchDraftsForScope,
    createWorkbenchRestoreCoordinator,
    readWorkbenchDraft,
    readWorkbenchMaskPendingSubmission,
    readWorkbenchPendingSubmission,
    registerWorkbenchSessionAbort,
    sameWorkbenchDraft,
    sameWorkbenchComposerDraft,
    tryLockWorkbenchSubmission,
    unlockWorkbenchSubmission,
    writeWorkbenchDraft,
    writeWorkbenchMaskPendingSubmission,
    writeWorkbenchPendingSubmission,
    workbenchSessionEpoch,
    type WorkbenchSessionDraft,
} from "../../src/open-ai-canvas-expand/workbench-session";

const imageDraft: WorkbenchSessionDraft = {
    prompt: "让产品悬浮在白色背景中",
    toolId: "product-shot",
    presetId: "clean",
    model: "image-model",
    parameters: { ratio: "1:1", quality: "high", imageResolution: "2k", count: "2" },
    references: [{ resourceId: "resource-1", kind: "image", role: "reference", slotKey: "product" }],
};

describe("workbench session drafts", () => {
    test("keeps image and video drafts isolated by user and workbench kind", () => {
        writeWorkbenchDraft("user-a", "image", imageDraft);
        writeWorkbenchDraft("user-a", "video", { ...imageDraft, prompt: "让镜头环绕产品", references: [] });
        writeWorkbenchDraft("user-b", "image", { ...imageDraft, prompt: "另一个账号" });

        expect(readWorkbenchDraft("user-a", "image")?.prompt).toBe(imageDraft.prompt);
        expect(readWorkbenchDraft("user-a", "video")?.prompt).toBe("让镜头环绕产品");
        expect(readWorkbenchDraft("user-b", "image")?.prompt).toBe("另一个账号");
    });

    test("returns an immutable copy and clears all drafts for a logged-out user", () => {
        writeWorkbenchDraft("user-a", "image", imageDraft);
        const restored = readWorkbenchDraft("user-a", "image")!;
        restored.prompt = "本地修改";
        restored.parameters.ratio = "16:9";

        expect(readWorkbenchDraft("user-a", "image")).toEqual(imageDraft);
        clearWorkbenchDraftsForScope("user-a");
        expect(readWorkbenchDraft("user-a", "image")).toBeNull();
    });

    test("compares the complete submission draft instead of prompt text only", () => {
        expect(sameWorkbenchDraft(imageDraft, { ...imageDraft })).toBe(true);
        expect(sameWorkbenchDraft(imageDraft, { ...imageDraft, model: "other-model" })).toBe(false);
        expect(sameWorkbenchDraft(imageDraft, { ...imageDraft, references: [] })).toBe(false);
    });

    test("protects director language and settings while ignoring the internal context identity", () => {
        expect(sameWorkbenchComposerDraft(imageDraft, { ...imageDraft, directorContextId: "director-a" })).toBe(true);
        expect(sameWorkbenchComposerDraft({ ...imageDraft, directorLanguage: "zh-CN" }, { ...imageDraft, directorLanguage: "en-US" })).toBe(false);
        expect(sameWorkbenchComposerDraft(imageDraft, { ...imageDraft, model: "other-model" })).toBe(false);
        expect(sameWorkbenchComposerDraft(imageDraft, { ...imageDraft, parameters: { ...imageDraft.parameters, transparentBackground: "true" } })).toBe(false);
        expect(sameWorkbenchComposerDraft(imageDraft, { ...imageDraft, parameters: { ...imageDraft.parameters, imageParameters: '{"style":"natural"}' } })).toBe(false);
    });

    test("allows only the latest history restore while the draft revision is unchanged", () => {
        let revision = 0;
        const coordinator = createWorkbenchRestoreCoordinator(() => revision);
        const first = coordinator.start();
        const second = coordinator.start();

        expect(first.isCurrent()).toBe(false);
        expect(second.isCurrent()).toBe(true);

        revision += 1;
        expect(second.isCurrent()).toBe(false);

        const third = coordinator.start();
        expect(third.isCurrent()).toBe(true);
        coordinator.invalidate();
        expect(third.isCurrent()).toBe(false);
    });

    test("keeps a frozen pending request across same-session route remounts", () => {
        writeWorkbenchPendingSubmission("user-a", "image", {
            transport: "workbench",
            fingerprint: "draft-v1",
            clientOperationId: "operation-1",
            input: { kind: "image", prompt: "原始提示词", model: "image-model", clientOperationId: "operation-1", parameters: { transparentBackground: false } },
        });

        const restored = readWorkbenchPendingSubmission("user-a", "image")!;
        restored.input.prompt = "被外部修改";

        expect(readWorkbenchPendingSubmission("user-a", "image")).toMatchObject({
            clientOperationId: "operation-1",
            input: { prompt: "原始提示词", parameters: { transparentBackground: false } },
        });
        clearWorkbenchPendingSubmission("user-a", "image");
        expect(readWorkbenchPendingSubmission("user-a", "image")).toBeNull();
    });

    test("clears pending requests with the owning user session only", () => {
        writeWorkbenchPendingSubmission("user-a", "image", { transport: "generation", fingerprint: "a", clientOperationId: "operation-a", input: { clientOperationId: "operation-a", prompt: "A" } });
        writeWorkbenchPendingSubmission("user-b", "image", { transport: "generation", fingerprint: "b", clientOperationId: "operation-b", input: { clientOperationId: "operation-b", prompt: "B" } });

        clearWorkbenchDraftsForScope("user-a");

        expect(readWorkbenchPendingSubmission("user-a", "image")).toBeNull();
        expect(readWorkbenchPendingSubmission("user-b", "image")?.clientOperationId).toBe("operation-b");
    });

    test("keeps mask recovery separate from the editable image draft across route remounts", () => {
        writeWorkbenchMaskPendingSubmission("user-mask", {
            fingerprint: "mask-v1",
            clientOperationId: "mask-operation-1",
            input: { clientOperationId: "mask-operation-1", type: "canvas_image", prompt: "局部修改", input: { metadata: { edit: "mask" } } },
        });

        const restored = readWorkbenchMaskPendingSubmission("user-mask")!;
        restored.input.prompt = "mutated";
        writeWorkbenchDraft("user-mask", "image", { ...imageDraft, prompt: "继续编辑普通草稿" });

        expect(readWorkbenchMaskPendingSubmission("user-mask")).toMatchObject({
            clientOperationId: "mask-operation-1",
            input: { prompt: "局部修改" },
        });
        clearWorkbenchMaskPendingSubmission("user-mask");
        expect(readWorkbenchMaskPendingSubmission("user-mask")).toBeNull();
    });

    test("does not clear a newer mask recovery when an older operation completes late", () => {
        const scope = "user-mask-late";
        const writeOperation = (clientOperationId: string) => writeWorkbenchMaskPendingSubmission(scope, {
            fingerprint: clientOperationId,
            clientOperationId,
            input: { clientOperationId, type: "canvas_image", prompt: "局部修改" },
        });
        writeOperation("mask-old");
        const original = readWorkbenchMaskPendingSubmission(scope)!;
        clearWorkbenchMaskPendingSubmission(scope, original.clientOperationId);
        expect(readWorkbenchMaskPendingSubmission(scope)).toBeNull();

        writeOperation("mask-new");
        clearWorkbenchMaskPendingSubmission(scope, original.clientOperationId);
        expect(readWorkbenchMaskPendingSubmission(scope)?.clientOperationId).toBe("mask-new");

        clearWorkbenchMaskPendingSubmission(scope, "mask-new");
        expect(readWorkbenchMaskPendingSubmission(scope)).toBeNull();
        clearWorkbenchMaskPendingSubmission(scope, original.clientOperationId);
        expect(readWorkbenchMaskPendingSubmission(scope)).toBeNull();
    });

    test("rejects a double submit until the exact operation releases the session lock", () => {
        expect(tryLockWorkbenchSubmission("user-lock", "video", "operation-1")).toBe(true);
        expect(tryLockWorkbenchSubmission("user-lock", "video", "operation-2")).toBe(false);
        unlockWorkbenchSubmission("user-lock", "video", "operation-2");
        expect(tryLockWorkbenchSubmission("user-lock", "video", "operation-2")).toBe(false);
        unlockWorkbenchSubmission("user-lock", "video", "operation-1");
        expect(tryLockWorkbenchSubmission("user-lock", "video", "operation-2")).toBe(true);
        clearWorkbenchDraftsForScope("user-lock");
    });

    test("replays the frozen request when unrelated runtime config changes", () => {
        const runtimeConfig = { transparentBackground: false, channelId: "channel-a" };
        writeWorkbenchPendingSubmission("user-config", "image", {
            transport: "workbench",
            fingerprint: "same-draft",
            clientOperationId: "operation-frozen",
            input: { kind: "image", prompt: "冻结请求", model: "image-model", channelId: runtimeConfig.channelId, clientOperationId: "operation-frozen", parameters: { transparentBackground: runtimeConfig.transparentBackground } },
        });
        runtimeConfig.transparentBackground = true;
        runtimeConfig.channelId = "channel-b";

        expect(readWorkbenchPendingSubmission("user-config", "image")).toMatchObject({
            clientOperationId: "operation-frozen",
            input: { channelId: "channel-a", parameters: { transparentBackground: false } },
        });
        clearWorkbenchDraftsForScope("user-config");
    });

    test("aborts an in-flight page operation before a global logout can reuse the new cookie", async () => {
        const controller = new AbortController();
        const epoch = workbenchSessionEpoch("user-race");
        const unregister = registerWorkbenchSessionAbort("user-race", controller);
        let remoteEffects = 0;
        const deferred = Promise.resolve().then(() => {
            if (controller.signal.aborted || workbenchSessionEpoch("user-race") !== epoch) throw new DOMException("session changed", "AbortError");
            remoteEffects += 1;
        });

        clearWorkbenchDraftsForScope("user-race");
        await expect(deferred).rejects.toMatchObject({ name: "AbortError" });
        expect(controller.signal.aborted).toBe(true);
        expect(remoteEffects).toBe(0);
        unregister();
    });
});
