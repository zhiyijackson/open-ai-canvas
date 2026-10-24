import { describe, expect, test } from "bun:test";

const pageSource = await Bun.file(new URL("../../src/pages/workbench/image-workbench-page.tsx", import.meta.url)).text();
const apiSource = await Bun.file(new URL("../../src/open-ai-canvas-expand/generation-api.ts", import.meta.url)).text();
const surfaceSource = await Bun.file(new URL("../../src/open-ai-canvas-expand/generation-workbench-surface.tsx", import.meta.url)).text();

describe("expand generation HTTP boundary", () => {
    test("routes generation and task actions through the dedicated facade adapter", () => {
        for (const call of ["runtime.createWorkbenchTask", "runtime.createGenerationTask", "runtime.getTask", "runtime.listTasks", "runtime.cancelTask", "runtime.retryTask", "runtime.recoverTaskMedia"]) {
            expect(pageSource).toContain(call);
        }
        for (const call of ["createExpandWorkbenchTask", "createExpandGenerationTask", "getExpandTask", "listExpandTasks", "cancelExpandTask", "retryExpandTask", "recoverExpandTaskMedia"]) {
            expect(apiSource).toContain(call);
        }
        expect(apiSource).toContain("createExpandOpenApi");
        expect(apiSource).toContain("clientOperationId");
    });

    test("does not restore browser-side materialization or direct host task writers", () => {
        expect(pageSource).not.toContain("materializeGenerationTaskAssets");
        expect(pageSource).not.toContain("listGenerationTasks(");
    });

    test("uploads both references and mask resources through expand-openapi", () => {
        expect(pageSource).toContain("runtime.uploadResource");
        expect(surfaceSource).toContain("controller.uploadResource(");
        expect(apiSource).toContain("client.uploadResource");
        expect(apiSource).toContain("EXPAND_OPENAPI_PREFIX");
    });

    test("workbench confirmations restore focus through the current Ant Design API", () => {
        const confirmations = [...surfaceSource.matchAll(/modal\.confirm\(\{([\s\S]*?)\}\);/g)].map((match) => match[1]);
        expect(confirmations).toHaveLength(3);
        for (const confirmation of confirmations) {
            expect(confirmation).toContain("focusable: { focusTriggerAfterClose: true }");
            expect(confirmation).not.toContain("focusTriggerAfterClose: true,\n");
        }
    });
});
