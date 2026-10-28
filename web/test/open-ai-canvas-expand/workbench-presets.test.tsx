import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { WorkbenchRestoredMetadata, WorkbenchRuntime, WorkbenchSurfaceController } from "../../src/open-ai-canvas-expand/workbench-contract";
import type { GenerationTask } from "../../src/services/api/task-center";
import type { WorkbenchPromptPreset, WorkbenchTool } from "../../src/services/api/workbench";

const dom = new Window({ url: "http://localhost/" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    Node: dom.Node,
    SVGElement: dom.SVGElement,
    ShadowRoot: dom.ShadowRoot,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { App } = await import("antd");
const { WorkbenchPage } = await import("../../src/pages/workbench/image-workbench-page");
const { createModelChannel, defaultConfig, useConfigStore } = await import("../../src/stores/use-config-store");
const { useCreationPreferencesStore } = await import("../../src/stores/use-creation-preferences-store");
const { useUserStore } = await import("../../src/stores/use-user-store");
const { http } = await import("../../src/services/api/request");

const initialConfig = useConfigStore.getState();
const initialPreferences = useCreationPreferencesStore.getState();
const initialUser = useUserStore.getState();
let mounted: { root: ReturnType<typeof createRoot>; container: HTMLDivElement } | undefined;
let restoreQuote: (() => void) | undefined;

const firstPreset: WorkbenchPromptPreset = { id: "preset-one", name: "白底商品模板", promptTemplate: "纯白背景，保留商品细节" };
const secondPreset: WorkbenchPromptPreset = { id: "preset-two", name: "场景模板", promptTemplate: "自然光线，生活方式场景" };
const tool: WorkbenchTool = {
    id: "tool-product", kind: "image", categoryId: "product", name: "商品展示", subtitle: "", description: "",
    enabled: true, sortOrder: 0, presets: [firstPreset, secondPreset],
};
const historyTask: GenerationTask = {
    id: "history-task", type: "image", status: "succeeded", prompt: "历史任务的正文", attempts: 1,
    createdAt: "2026-10-21T08:40:00Z", updatedAt: "2026-10-21T08:40:00Z",
    inputJson: JSON.stringify({ workbench: { kind: "image", toolId: tool.id, presetId: firstPreset.id, parameters: { size: "1:1", count: 1 }, references: [] } }),
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function createRuntime(overrides: Partial<WorkbenchRuntime> = {}) {
    let submissions = 0;
    const unexpected = async (): Promise<never> => { submissions += 1; throw new Error("模板操作不应创建任务"); };
    const runtime: WorkbenchRuntime = {
        listTools: async () => ({ tools: [tool] }),
        listTasks: async () => [],
        createWorkbenchTask: unexpected,
        createGenerationTask: unexpected,
        getTask: async () => historyTask,
        cancelTask: unexpected,
        retryTask: unexpected,
        recoverTaskMedia: unexpected,
        hasPendingSubmission: () => false,
        recoverPendingSubmission: unexpected,
        uploadResource: unexpected,
        resolveResourceURL: async () => "/history-reference.png",
        ...overrides,
    };
    return { runtime, submissions: () => submissions };
}

async function mountWorkbench(runtime: WorkbenchRuntime) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted = { container, root };
    let restore: ReturnType<WorkbenchSurfaceController["openTask"]> | undefined;
    let currentController: WorkbenchSurfaceController;
    const renderSurface = (controller: WorkbenchSurfaceController) => {
        currentController = controller;
        return (
        <section aria-label="原控制器消费视图">
            <output aria-label="当前正文">{controller.prompt}</output>
            <output aria-label="已应用模板">{controller.preset?.id || "none"}</output>
            <output aria-label="待应用模板">{controller.presetPending?.id || "none"}</output>
            <output aria-label="当前素材">{controller.references.map((reference) => reference.resourceId).join(",")}</output>
            <button type="button" onClick={() => controller.setPrompt("已有正文  ")}>填写正文</button>
            <button type="button" onClick={() => controller.choosePreset(firstPreset)}>选择白底模板</button>
            <button type="button" onClick={() => controller.choosePreset(secondPreset)}>选择场景模板</button>
            <button type="button" onClick={() => controller.restorePreset(secondPreset)}>恢复场景模板身份</button>
            <button type="button" onClick={() => controller.restorePreset(null)}>恢复无模板身份</button>
            <button type="button" onClick={() => controller.applyPreset("replace")}>替换正文</button>
            <button type="button" onClick={() => controller.applyPreset("append")}>追加正文</button>
            <button type="button" onClick={() => controller.cancelPreset()}>取消应用</button>
            <button type="button" onClick={() => { restore = controller.openTask(historyTask); }}>恢复历史</button>
        </section>
        );
    };
    await act(async () => {
        root.render(<MemoryRouter><App><WorkbenchPage kind="image" runtime={runtime} renderSurface={renderSurface} /></App></MemoryRouter>);
    });
    return {
        async click(label: string) {
            const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
            expect(button).toBeDefined();
            await act(async () => button!.click());
        },
        value(label: string) { return container.querySelector(`output[aria-label="${label}"]`)?.textContent; },
        async finishRestore() {
            let result: Awaited<typeof restore>;
            await act(async () => { result = await restore; });
            return result;
        },
        controller() { return currentController; },
        async operate(action: (controller: WorkbenchSurfaceController) => void | Promise<void>) {
            await act(async () => { await action(currentController); });
        },
    };
}

beforeEach(() => {
    useConfigStore.setState({ config: { ...defaultConfig, channels: [] } });
    useCreationPreferencesStore.setState({ hydrated: true, preferences: {} });
    useUserStore.setState({ features: { ...initialUser.features, creditsEnabled: false } });
});

afterEach(async () => {
    if (mounted) {
        await act(async () => mounted!.root.unmount());
        mounted.container.remove();
        mounted = undefined;
    }
    restoreQuote?.();
    restoreQuote = undefined;
    document.body.replaceChildren();
});

afterAll(() => {
    useConfigStore.setState(initialConfig);
    useCreationPreferencesStore.setState(initialPreferences);
    useUserStore.setState(initialUser);
    dom.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

test("native preset seam applies empty input immediately and preserves replace/append/cancel for existing text", async () => {
    const fake = createRuntime();
    const view = await mountWorkbench(fake.runtime);
    await view.click("选择白底模板");
    expect(view.value("当前正文")).toBe(firstPreset.promptTemplate);
    expect(view.value("已应用模板")).toBe(firstPreset.id);
    expect(view.value("待应用模板")).toBe("none");

    await view.click("填写正文");
    await view.click("选择场景模板");
    expect(view.value("当前正文")).toBe("已有正文  ");
    expect(view.value("已应用模板")).toBe(firstPreset.id);
    expect(view.value("待应用模板")).toBe(secondPreset.id);
    await view.click("取消应用");
    expect(view.value("当前正文")).toBe("已有正文  ");
    expect(view.value("待应用模板")).toBe("none");
    expect(view.value("已应用模板")).toBe(firstPreset.id);

    await view.click("选择场景模板");
    await view.click("追加正文");
    expect(view.value("当前正文")).toBe(`已有正文\n${secondPreset.promptTemplate}`);
    expect(view.value("已应用模板")).toBe(secondPreset.id);
    expect(view.value("待应用模板")).toBe("none");
    await view.click("选择白底模板");
    await view.click("替换正文");
    expect(view.value("当前正文")).toBe(firstPreset.promptTemplate);
    expect(view.value("已应用模板")).toBe(firstPreset.id);
    expect(view.value("待应用模板")).toBe("none");
    expect(fake.submissions()).toBe(0);
});

test("switching tools replaces an untouched preset and clears it for a tool without presets", async () => {
    const nextTool = { ...tool, id: "tool-next", presets: [secondPreset] };
    const plainTool = { ...tool, id: "tool-plain", presets: [] };
    const fake = createRuntime({ listTools: async () => ({ tools: [tool, nextTool, plainTool] }) });
    const view = await mountWorkbench(fake.runtime);
    await view.operate((controller) => controller.chooseTool(tool));
    expect(view.value("当前正文")).toBe(firstPreset.promptTemplate);
    await view.operate((controller) => controller.chooseTool(nextTool));
    expect(view.value("当前正文")).toBe(secondPreset.promptTemplate);
    expect(view.value("待应用模板")).toBe("none");
    await view.operate((controller) => controller.chooseTool(plainTool));
    expect(view.value("当前正文")).toBe("");
    expect(view.value("已应用模板")).toBe("none");
    expect(fake.submissions()).toBe(0);
});

test("switching tools retains edited text until the user cancels or confirms the new preset", async () => {
    const nextTool = { ...tool, id: "tool-next", presets: [secondPreset] };
    const fake = createRuntime({ listTools: async () => ({ tools: [tool, nextTool] }) });
    const view = await mountWorkbench(fake.runtime);
    await view.operate((controller) => controller.chooseTool(tool));
    await view.click("填写正文");
    await view.operate((controller) => controller.chooseTool(nextTool));
    expect(view.value("当前正文")).toBe("已有正文  ");
    expect(view.value("待应用模板")).toBe(secondPreset.id);
    await view.click("取消应用");
    expect(view.value("当前正文")).toBe("已有正文  ");
    expect(view.value("待应用模板")).toBe("none");
    await view.click("选择场景模板");
    await view.click("追加正文");
    expect(view.value("当前正文")).toBe(`已有正文\n${secondPreset.promptTemplate}`);
    expect(fake.submissions()).toBe(0);
});

test("applying a preset to empty text invalidates a pending historical detail response", async () => {
    const detail = deferred<GenerationTask>();
    const fake = createRuntime({ getTask: () => detail.promise });
    const view = await mountWorkbench(fake.runtime);
    await view.click("恢复历史");
    await view.click("选择场景模板");
    await act(async () => detail.resolve(historyTask));
    await view.finishRestore();
    expect(view.value("当前正文")).toBe(secondPreset.promptTemplate);
    expect(view.value("已应用模板")).toBe(secondPreset.id);
    expect(view.value("当前素材")).toBe("");
    expect(fake.submissions()).toBe(0);
});

test("session restoration can recover a non-first preset or explicit null without reapplying its body", async () => {
    const fake = createRuntime();
    const view = await mountWorkbench(fake.runtime);
    await view.click("选择白底模板");
    await view.click("填写正文");
    await view.click("选择场景模板");
    expect(view.value("待应用模板")).toBe(secondPreset.id);
    await view.click("恢复场景模板身份");
    expect(view.value("当前正文")).toBe("已有正文  ");
    expect(view.value("已应用模板")).toBe(secondPreset.id);
    expect(view.value("待应用模板")).toBe("none");
    await view.click("选择白底模板");
    await view.click("恢复无模板身份");
    expect(view.value("当前正文")).toBe("已有正文  ");
    expect(view.value("已应用模板")).toBe("none");
    expect(view.value("待应用模板")).toBe("none");
    expect(fake.submissions()).toBe(0);
});

for (const mode of ["replace", "append"] as const) {
    test(`native ${mode} preset application wins over delayed historical reference preparation`, async () => {
        const resource = deferred<string | undefined>();
        let resourceReads = 0;
        const detail = { ...historyTask, inputJson: JSON.stringify({ workbench: {
            kind: "image", toolId: tool.id, presetId: firstPreset.id, parameters: { size: "1:1" },
            references: [{ resourceId: "history-image", kind: "image", role: "reference" }],
        } }) };
        const fake = createRuntime({ getTask: async () => detail, resolveResourceURL: () => { resourceReads += 1; return resource.promise; } });
        const view = await mountWorkbench(fake.runtime);
        await view.click("填写正文");
        await view.click("选择场景模板");
        await view.click("恢复历史");
        expect(resourceReads).toBe(1);
        await view.click(mode === "replace" ? "替换正文" : "追加正文");
        await act(async () => resource.resolve("/history-image.png"));
        await view.finishRestore();
        expect(view.value("当前正文")).toBe(mode === "replace" ? secondPreset.promptTemplate : `已有正文\n${secondPreset.promptTemplate}`);
        expect(view.value("已应用模板")).toBe(secondPreset.id);
        expect(view.value("待应用模板")).toBe("none");
        expect(view.value("当前素材")).toBe("");
        expect(fake.submissions()).toBe(0);
    });
}

test("cancel only clears the pending template and does not invalidate an otherwise unchanged history restore", async () => {
    const detail = deferred<GenerationTask>();
    const fake = createRuntime({ getTask: () => detail.promise });
    const view = await mountWorkbench(fake.runtime);
    await view.click("填写正文");
    await view.click("选择场景模板");
    await view.click("恢复历史");
    await view.click("取消应用");
    expect(view.value("当前正文")).toBe("已有正文  ");
    await act(async () => detail.resolve(historyTask));
    await view.finishRestore();
    expect(view.value("当前正文")).toBe(historyTask.prompt);
    expect(view.value("已应用模板")).toBe(firstPreset.id);
    expect(view.value("待应用模板")).toBe("none");
    expect(fake.submissions()).toBe(0);
});

for (const backgroundConfirmation of [true, false]) {
    test(`${backgroundConfirmation ? "background availability confirmation preserves" : "a reference edit cancels"} an in-flight history restore`, async () => {
        const detail = deferred<GenerationTask>();
        const fake = createRuntime({ getTask: () => detail.promise });
        const view = await mountWorkbench(fake.runtime);
        await view.operate((controller) => {
            controller.setPrompt("仍在编辑的草稿");
            controller.setReferences([{
                id: "draft-reference",
                resourceId: "draft-resource",
                kind: "image",
                name: "草稿素材",
                role: "reference",
                previewUrl: "",
                progress: 0,
                uploading: true,
            }]);
        });
        await view.click("恢复历史");
        await view.operate((controller) => {
            const acknowledge = (references: typeof controller.references) => references.map((reference) => ({
                ...reference,
                previewUrl: "/draft-resource.png",
                progress: 100,
                uploading: false,
            }));
            if (backgroundConfirmation) controller.setReferences(acknowledge, false);
            else controller.setReferences(acknowledge);
        });
        expect(view.controller().references[0]?.uploading).toBe(false);
        await act(async () => detail.resolve(historyTask));
        const restored = await view.finishRestore();
        if (backgroundConfirmation) {
            expect(restored).toMatchObject({ parameters: { size: "1:1", count: 1 } });
            expect(view.value("当前正文")).toBe(historyTask.prompt);
            expect(view.value("当前素材")).toBe("");
        } else {
            expect(restored).toBeNull();
            expect(view.value("当前正文")).toBe("仍在编辑的草稿");
            expect(view.value("当前素材")).toBe("draft-resource");
        }
        expect(fake.submissions()).toBe(0);
    });
}

test("history restoration exposes original missing model, tool and preset identities to the consuming surface", async () => {
    const detail: GenerationTask = {
        ...historyTask,
        model: "removed-image-model",
        inputJson: JSON.stringify({ workbench: { kind: "image", toolId: "removed-tool", presetId: "removed-preset", parameters: { size: "1:1" }, references: [] } }),
    };
    const fake = createRuntime({ getTask: async () => detail });
    const view = await mountWorkbench(fake.runtime);
    await view.click("恢复历史");
    expect(await view.finishRestore()).toEqual({ parameters: { size: "1:1" }, model: detail.model, toolId: "removed-tool", presetId: "removed-preset" });
    expect(view.value("当前正文")).toBe(detail.prompt);
    expect(fake.submissions()).toBe(0);
});

test("task list errors remain visible, retain existing tasks and clear after an explicit successful reload", async () => {
    let listError = "";
    let delayed: ReturnType<typeof deferred<GenerationTask[]>> | undefined;
    const fake = createRuntime({ listTasks: async () => {
        if (delayed) return delayed.promise;
        if (listError) throw new Error(listError);
        return [historyTask];
    } });
    const view = await mountWorkbench(fake.runtime);
    expect(view.controller().tasks.map((task) => task.id)).toEqual([historyTask.id]);
    listError = "任务列表暂时不可读取";
    await view.operate((controller) => controller.reloadTasks());
    expect(view.controller().tasksError).toBe(listError);
    expect(view.controller().tasksLoading).toBe(false);
    expect(view.controller().tasks.map((task) => task.id)).toEqual([historyTask.id]);

    delayed = deferred<GenerationTask[]>();
    let reload: Promise<void>;
    await view.operate((controller) => { reload = controller.reloadTasks(); });
    expect(view.controller().tasksLoading).toBe(true);
    await act(async () => { delayed!.resolve([]); await reload!; });
    expect(view.controller().tasksError).toBe("");
    expect(view.controller().tasksLoading).toBe(false);
    expect(view.controller().tasks).toEqual([]);
    expect(fake.submissions()).toBe(0);
});

test("an initial task list failure remains distinct from an empty successful response", async () => {
    const fake = createRuntime({ listTasks: async () => { throw new Error("列表请求失败"); } });
    const view = await mountWorkbench(fake.runtime);
    expect(view.controller().tasks).toEqual([]);
    expect(view.controller().tasksLoading).toBe(false);
    expect(view.controller().tasksError).toBe("列表请求失败");
});

test("background terminal status updates preserve the user's current composer tab and text", async () => {
    let listedTask: GenerationTask = { ...historyTask, status: "queued" };
    const fake = createRuntime({ listTasks: async () => [listedTask], getTask: async () => listedTask });
    const view = await mountWorkbench(fake.runtime);
    await view.click("恢复历史");
    await view.finishRestore();
    await view.click("填写正文");
    expect(view.controller().mobileTab).toBe("generate");
    listedTask = { ...listedTask, status: "succeeded" };
    await act(async () => { document.dispatchEvent(new dom.Event("visibilitychange")); });
    expect(view.controller().activeTask?.status).toBe("succeeded");
    expect(view.controller().mobileTab).toBe("generate");
    expect(view.value("当前正文")).toBe("已有正文  ");
});

test("new remote quotes clear the previous amount and aborted responses cannot overwrite the current configuration", async () => {
    const requests: Array<{ url: string; input: unknown; response: ReturnType<typeof deferred<{ quote: { amountMicrocredits: number; estimated: boolean } }>> }> = [];
    const quoteSpy = spyOn(http, "post").mockImplementation(((url: string, input: unknown) => {
        const response = deferred<{ quote: { amountMicrocredits: number; estimated: boolean } }>();
        requests.push({ url, input, response });
        return response.promise;
    }) as typeof http.post);
    restoreQuote = () => quoteSpy.mockRestore();
    const channel = createModelChannel({
        id: "quote-system", scope: "system", models: ["image-a", "image-b"],
        modelCosts: ["image-a", "image-b"].map((model) => ({ model, capability: "image", billingMode: "token", unitPriceMicrocredits: 0, inputTokenPriceMicrocredits: 0, outputTokenPriceMicrocredits: 0, cachedTokenPriceMicrocredits: 0, logicalModelId: `logical-${model}` })),
    });
    useConfigStore.setState({ config: { ...defaultConfig, channels: [channel], model: "quote-system::image-a", imageModel: "quote-system::image-a" } });
    useUserStore.setState({ features: { ...initialUser.features, creditsEnabled: true } });
    const view = await mountWorkbench(createRuntime().runtime);
    expect(requests.length).toBeGreaterThan(0);
    await act(async () => { requests.at(-1)!.response.resolve({ quote: { amountMicrocredits: 8_000_000, estimated: true } }); });
    expect(view.controller().estimateLabel).toContain("8 积分");

    await view.operate((controller) => controller.selectModel("quote-system::image-b"));
    expect(view.controller().estimateLabel).toBe("正在计算积分");
    const obsolete = requests.at(-1)!;
    expect(obsolete.url).toBe("/models/logical-image-b/quote");
    await view.operate((controller) => controller.applyParameters({ ratio: "16:9" }));
    const latest = requests.at(-1)!;
    expect(latest).not.toBe(obsolete);
    expect(latest.input).toMatchObject({ options: { size: "16:9" } });
    await act(async () => { obsolete.response.resolve({ quote: { amountMicrocredits: 99_000_000, estimated: true } }); });
    expect(view.controller().estimateLabel).toBe("正在计算积分");
    await act(async () => { latest.response.resolve({ quote: { amountMicrocredits: 11_000_000, estimated: true } }); });
    expect(view.controller().estimateLabel).toContain("11 积分");
});

test("one unavailable historical reference retains the full draft and blocks a new generation", async () => {
    const channel = createModelChannel({ id: "restore-system", scope: "system", baseUrl: "/api/system-channel", apiKey: "system", models: ["image-model"], modelCosts: [{ model: "image-model", capability: "image", billingMode: "fixed_request", unitPriceMicrocredits: 0 }] });
    useConfigStore.setState({ config: { ...defaultConfig, channels: [channel], model: "restore-system::image-model", imageModel: "restore-system::image-model" } });
    const detail: GenerationTask = { ...historyTask, model: "image-model", inputJson: JSON.stringify({ workbench: {
        kind: "image", toolId: tool.id, presetId: firstPreset.id, parameters: { size: "1:1" },
        references: [{ resourceId: "ready-image", kind: "image", role: "reference", slotKey: "product" }, { resourceId: "deleted-image", kind: "image", role: "reference", slotKey: "product" }, { resourceId: "missing-url", kind: "image", role: "reference" }],
    } }) };
    const fake = createRuntime({ getTask: async () => detail, resolveResourceURL: async (id) => {
        if (id === "deleted-image") throw new Error("原图片已删除或无权读取");
        return id === "missing-url" ? undefined : "/ready-image.png";
    } });
    const view = await mountWorkbench(fake.runtime);
    await view.click("恢复历史");
    const restored = await view.finishRestore();
    expect(restored).toMatchObject({ model: "image-model", toolId: tool.id, presetId: firstPreset.id });
    expect(view.controller().selectedModel).toBe("restore-system::image-model");
    expect(view.value("当前正文")).toBe(detail.prompt);
    expect(view.value("已应用模板")).toBe(firstPreset.id);
    expect(view.controller().references).toMatchObject([
        { resourceId: "ready-image", previewUrl: "/ready-image.png", role: "reference", slotKey: "product" },
        { resourceId: "deleted-image", previewUrl: "", error: "原图片已删除或无权读取", role: "reference", slotKey: "product" },
        { resourceId: "missing-url", previewUrl: "", error: "参考素材不可用，请重新选择" },
    ]);
    await view.operate(async (controller) => { await controller.submit(); });
    expect(fake.submissions()).toBe(0);
});

for (const replacement of ["edit", "new"] as const) {
    test(`retrying the original task does not overwrite a ${replacement} draft after delayed reference preparation`, async () => {
        const resource = deferred<string | undefined>();
        const source: GenerationTask = { ...historyTask, status: "failed", inputJson: JSON.stringify({ workbench: {
            kind: "image", parameters: { size: "1:1" }, references: [{ resourceId: "old-image", kind: "image", role: "reference" }],
        } }) };
        const retried: string[] = [];
        const restored: WorkbenchRestoredMetadata[] = [];
        const fake = createRuntime({ resolveResourceURL: () => resource.promise, retryTask: async (id) => { retried.push(id); return { ...source, status: "queued" }; } });
        const view = await mountWorkbench(fake.runtime);
        let retry: Promise<void>;
        await view.operate((controller) => { retry = controller.retryTask(source, (metadata) => restored.push(metadata)); });
        if (replacement === "edit") await view.click("填写正文");
        else await view.operate((controller) => controller.resetWorkbench());
        await act(async () => { resource.resolve("/old-image.png"); await retry!; });
        expect(retried).toEqual([source.id]);
        expect(view.value("当前正文")).toBe(replacement === "edit" ? "已有正文  " : "");
        expect(view.value("当前素材")).toBe("");
        expect(view.controller().activeTask).toBeNull();
        expect(view.controller().tasks[0]?.status).toBe("queued");
        expect(restored).toEqual([]);
    });
}

test("retry restoration reports original missing identities and unmodified parameters before a backend rejection", async () => {
    const channel = createModelChannel({ id: "retry-system", scope: "system", baseUrl: "/api/system-channel", apiKey: "system", models: ["current-model"], modelCosts: [{ model: "current-model", capability: "image", billingMode: "fixed_request", unitPriceMicrocredits: 0 }] });
    useConfigStore.setState({ config: { ...defaultConfig, channels: [channel], model: "retry-system::current-model", imageModel: "retry-system::current-model" } });
    const parameters = { size: "37:13", quality: "retired-quality", imageResolution: "retired-resolution", count: 27, imageParameters: { style: "legacy-style" } };
    const source: GenerationTask = {
        ...historyTask,
        model: "removed-model",
        status: "failed",
        inputJson: JSON.stringify({ workbench: { kind: "image", toolId: "removed-tool", presetId: "removed-preset", parameters, references: [] } }),
    };
    const restored: WorkbenchRestoredMetadata[] = [];
    const events: string[] = [];
    const fake = createRuntime({ retryTask: async (id) => {
        events.push(`retry:${id}`);
        expect(restored).toEqual([{ parameters, model: source.model, toolId: "removed-tool", presetId: "removed-preset" }]);
        throw new Error("原模型已下架，重试被拒绝");
    } });
    const view = await mountWorkbench(fake.runtime);
    await view.operate((controller) => controller.retryTask(source, (metadata) => {
        events.push("restored");
        restored.push(metadata);
    }));
    expect(events).toEqual(["restored", `retry:${source.id}`]);
    expect(restored).toHaveLength(1);
    expect(view.value("当前正文")).toBe(source.prompt);
    expect(view.controller().selectedModel).toBe("retry-system::current-model");
    expect(view.controller().tool).toBeNull();
    expect(view.controller().preset).toBeNull();
    expect(view.controller().taskBusyId).toBe("");
});

test("retry response fallback reports metadata through the same protected restore callback", async () => {
    const parameters = { size: "16:9", quality: "legacy-quality", count: 3 };
    const source: GenerationTask = { ...historyTask, status: "failed", model: "fallback-model", inputJson: undefined };
    const next: GenerationTask = { ...source, status: "queued", inputJson: JSON.stringify({ workbench: { kind: "image", toolId: "fallback-tool", presetId: "fallback-preset", parameters, references: [] } }) };
    const restored: WorkbenchRestoredMetadata[] = [];
    const events: string[] = [];
    const fake = createRuntime({
        getTask: async () => { throw new Error("详情暂不可读"); },
        retryTask: async () => { events.push("retry"); return next; },
    });
    const view = await mountWorkbench(fake.runtime);
    await view.operate((controller) => controller.retryTask(source, (metadata) => {
        events.push("restored");
        restored.push(metadata);
    }));
    expect(events).toEqual(["retry", "restored"]);
    expect(restored).toEqual([{ parameters, model: source.model, toolId: "fallback-tool", presetId: "fallback-preset" }]);
    expect(view.value("当前正文")).toBe(source.prompt);
    expect(view.controller().activeTask?.status).toBe("queued");
});

test("a late retry response retains a new draft even after the original snapshot was restored", async () => {
    const response = deferred<GenerationTask>();
    const fake = createRuntime({ retryTask: () => response.promise });
    const view = await mountWorkbench(fake.runtime);
    let retry: Promise<void>;
    await view.operate((controller) => { retry = controller.retryTask({ ...historyTask, status: "failed" }); });
    expect(view.value("当前正文")).toBe(historyTask.prompt);
    await view.operate((controller) => controller.resetWorkbench());
    await view.click("填写正文");
    await act(async () => { response.resolve({ ...historyTask, status: "queued" }); await retry!; });
    expect(view.value("当前正文")).toBe("已有正文  ");
    expect(view.controller().activeTask).toBeNull();
    expect(view.controller().tasks[0]?.id).toBe(historyTask.id);
});
