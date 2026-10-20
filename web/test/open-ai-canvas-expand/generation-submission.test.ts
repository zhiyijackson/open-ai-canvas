import { afterEach, describe, expect, test } from "bun:test";
import { apiClient } from "../../src/services/api/request";
import { getActiveUserScope } from "../../src/lib/user-scope";
import { createExpandWorkbenchRuntime, isExpandSubmissionRejected } from "../../src/open-ai-canvas-expand/generation-api";
import { clearWorkbenchPendingSubmission, readWorkbenchPendingSubmission } from "../../src/open-ai-canvas-expand/workbench-session";

const originalAdapter = apiClient.defaults.adapter;
const scope = getActiveUserScope();
const input = { kind: "image" as const, model: "model-1", prompt: "first" };
afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
    clearWorkbenchPendingSubmission(scope, "image");
});

describe("generation submission recovery", () => {
    test("a fresh pre-dispatch auth rejection releases ordinary and mask submissions", async () => {
        apiClient.defaults.adapter = async (config) => ({
            config, headers: {}, status: 403, statusText: "Forbidden",
            data: { code: 403, data: null, msg: "access denied", details: { expandRequestState: "rejected" } },
        });
        const runtime = createExpandWorkbenchRuntime("image", scope);
        let failure: unknown;
        try { await runtime.createGenerationTask({ type: "canvas_image", prompt: "mask edit", input: {} }); }
        catch (error) { failure = error; }
        expect(isExpandSubmissionRejected(failure)).toBe(true);
        expect(runtime.hasPendingSubmission()).toBe(false);
    });

    test("auth rejection of recovery cannot release a previously unknown operation", async () => {
        let posts = 0;
        apiClient.defaults.adapter = async (config) => {
            if (config.method === "post" && ++posts === 1) throw new Error("lost response");
            return { config, headers: {}, status: 403, statusText: "Forbidden",
                data: { code: 403, data: null, msg: "access denied", details: { expandRequestState: "rejected" } } };
        };
        const runtime = createExpandWorkbenchRuntime("image", scope);
        await expect(runtime.createWorkbenchTask(input)).rejects.toThrow("lost response");
        const operation = readWorkbenchPendingSubmission(scope, "image")?.clientOperationId;
        let failure: unknown;
        try { await runtime.recoverPendingSubmission!(); } catch (error) { failure = error; }
        expect(isExpandSubmissionRejected(failure)).toBe(false);
        expect(readWorkbenchPendingSubmission(scope, "image")?.clientOperationId).toBe(operation);
        expect(runtime.hasPendingSubmission()).toBe(true);
    });
    test("a confirmed rejection releases the draft and the corrected request gets a fresh operation", async () => {
        const keys: string[] = [];
        apiClient.defaults.adapter = async (config) => {
            if (config.method === "post") {
                keys.push(JSON.parse(config.data).clientOperationId);
                if (keys.length === 1) return { config, headers: {}, status: 402, statusText: "Payment Required", data: {
                    code: 402, data: null, msg: "余额不足", reason: "insufficient_credits", details: { expandOperationState: "rejected" },
                } };
                return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { id: "task-1" }, msg: "ok" } };
            }
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: [], msg: "ok" } };
        };
        const runtime = createExpandWorkbenchRuntime("image", scope);
        await expect(runtime.createWorkbenchTask(input)).rejects.toThrow("余额不足");
        expect(runtime.hasPendingSubmission()).toBe(false);
        expect(await runtime.createWorkbenchTask({ ...input, prompt: "corrected" })).toEqual({ id: "task-1" });
        expect(keys).toHaveLength(2);
        expect(keys[1]).not.toBe(keys[0]);
    });

    test("network errors and unknown conflicts keep the exact frozen request", async () => {
        const posts: string[] = [];
        apiClient.defaults.adapter = async (config) => {
            if (config.method === "post") {
                posts.push(config.data);
                if (posts.length === 1) throw new Error("connection lost");
                return { config, headers: {}, status: 409, statusText: "Conflict", data: { code: 409, data: null, msg: "unknown", reason: "expand_openapi_operation_unknown" } };
            }
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: [], msg: "ok" } };
        };
        const runtime = createExpandWorkbenchRuntime("image", scope);
        await expect(runtime.createWorkbenchTask(input)).rejects.toThrow("connection lost");
        await expect(runtime.createWorkbenchTask({ ...input, prompt: "changed" })).rejects.toThrow("已有生成提交状态待确认");
        await expect(runtime.recoverPendingSubmission!()).rejects.toThrow("unknown");
        expect(posts).toHaveLength(2);
        expect(posts[1]).toBe(posts[0]);
        expect(runtime.hasPendingSubmission()).toBe(true);
    });

    test("operation lookup can establish rejection after the original response was lost", async () => {
        apiClient.defaults.adapter = async (config) => {
            if (config.method === "post") throw new Error("connection lost");
            return { config, headers: {}, status: 400, statusText: "Bad Request", data: {
                code: 400, data: null, msg: "模型参数无效", details: { expandOperationState: "rejected" },
            } };
        };
        const runtime = createExpandWorkbenchRuntime("image", scope);
        await expect(runtime.createWorkbenchTask(input)).rejects.toThrow("模型参数无效");
        expect(runtime.hasPendingSubmission()).toBe(false);
    });

    test("an HTTP error without a confirmed disposition cannot release an unknown task", async () => {
        apiClient.defaults.adapter = async (config) => ({
            config, headers: {}, status: config.method === "post" ? 402 : 503, statusText: "Error",
            data: { code: config.method === "post" ? 402 : 503, data: null, msg: "unconfirmed rejection" },
        });
        const runtime = createExpandWorkbenchRuntime("image", scope);
        await expect(runtime.createWorkbenchTask(input)).rejects.toThrow("unconfirmed rejection");
        expect(runtime.hasPendingSubmission()).toBe(true);
        await expect(runtime.createWorkbenchTask({ ...input, prompt: "changed" })).rejects.toThrow("已有生成提交状态待确认");
    });

    test("accepted task detail failure recovers by GET without another generation POST", async () => {
        let posts = 0;
        let detailReads = 0;
        apiClient.defaults.adapter = async (config) => {
            if (config.method === "post") posts++;
            else if (++detailReads === 1) throw new Error("details unavailable");
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { id: "accepted-1" }, msg: "ok" } };
        };
        const runtime = createExpandWorkbenchRuntime("image", scope);
        await runtime.createWorkbenchTask(input);
        await expect(runtime.getTask("accepted-1")).rejects.toThrow("details unavailable");
        expect(readWorkbenchPendingSubmission(scope, "image")?.acceptedTaskId).toBe("accepted-1");
        expect(await runtime.recoverPendingSubmission!()).toEqual({ id: "accepted-1" });
        await runtime.getTask("accepted-1");
        expect(posts).toBe(1);
        expect(runtime.hasPendingSubmission()).toBe(false);
    });
});
