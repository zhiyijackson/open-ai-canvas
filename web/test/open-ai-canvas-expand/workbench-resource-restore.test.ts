import { afterEach, expect, test } from "bun:test";

import { getActiveUserScope } from "../../src/lib/user-scope";
import { apiClient } from "../../src/services/api/request";
import { createExpandWorkbenchRuntime, expandResourceFileURL } from "../../src/open-ai-canvas-expand/generation-api";
import { clearWorkbenchDraftsForScope } from "../../src/open-ai-canvas-expand/workbench-session";

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => { apiClient.defaults.adapter = originalAdapter; });

test("historical resource recovery verifies the authenticated resource before returning its facade URL", async () => {
    const requests: string[] = [];
    apiClient.defaults.adapter = async (config) => {
        requests.push(`${config.method} ${config.url}`);
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "ok", data: { resource: { id: "resource/one", kind: "image", status: "ready" } } } };
    };
    const runtime = createExpandWorkbenchRuntime("image", getActiveUserScope());
    expect(await runtime.resolveResourceURL("resource/one")).toBe(expandResourceFileURL("resource/one"));
    expect(requests).toEqual(["get /expand-openapi/v1/resources/resource%2Fone"]);
});

for (const status of ["deleted", "pending", "failed"] as const) {
    test(`historical ${status} resources never receive a usable recovery URL`, async () => {
        apiClient.defaults.adapter = async (config) => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "ok", data: { resource: { id: "resource-1", kind: "image", status } } } });
        const runtime = createExpandWorkbenchRuntime("image", getActiveUserScope());
        await expect(runtime.resolveResourceURL("resource-1")).rejects.toThrow(status === "deleted" ? "已删除" : "尚不可用");
    });
}

for (const status of [403, 404]) {
    test(`historical resource access ${status} preserves the API failure for the reference's error state`, async () => {
        apiClient.defaults.adapter = async (config) => ({ config, status, statusText: "Error", headers: {}, data: { code: status, msg: status === 403 ? "素材无权访问" : "素材已删除", data: null } });
        const runtime = createExpandWorkbenchRuntime("image", getActiveUserScope());
        await expect(runtime.resolveResourceURL("resource-1")).rejects.toThrow(status === 403 ? "无权访问" : "已删除");
    });
}

test("resource recovery cannot return a late URL after the owning session has expired", async () => {
    const scope = getActiveUserScope();
    let finish!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((done) => { finish = done; });
    const requested = new Promise<void>((done) => { started = done; });
    apiClient.defaults.adapter = async (config) => {
        started();
        await pending;
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "ok", data: { resource: { id: "resource-1", status: "ready" } } } };
    };
    const runtime = createExpandWorkbenchRuntime("image", scope);
    const recovery = runtime.resolveResourceURL("resource-1");
    await requested;
    clearWorkbenchDraftsForScope(scope);
    finish();
    await expect(recovery).rejects.toThrow();
});
