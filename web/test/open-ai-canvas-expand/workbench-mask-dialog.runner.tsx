import { mock } from "bun:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { CanvasImageRegionEditPayload } from "../../src/components/canvas/canvas-node-region-edit-dialog";
import * as regionModule from "../../src/lib/canvas/image-region-edit";
import type { ImageEditRegion } from "../../src/lib/canvas/image-region-edit";

const window = new Window({ url: "http://localhost/" });
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    SVGElement: window.SVGElement, ShadowRoot: window.ShadowRoot,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    localStorage: window.localStorage,
    requestAnimationFrame: (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    IS_REACT_ACT_ENVIRONMENT: true,
});

type ModalProps = {
    children: ReactNode; title: string; confirmLoading?: boolean; keyboard?: boolean; maskClosable?: boolean;
    cancelButtonProps?: { disabled?: boolean }; okButtonProps?: { disabled?: boolean };
    onCancel(): void; onOk(): void;
};
let modalProps: ModalProps;
const exports: ImageEditRegion[][] = [];
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: (props: ModalProps) => {
        modalProps = props;
        return <section role="dialog" aria-label={props.title}>
            {props.children}
        </section>;
    },
}));
mock.module("@/services/image-storage", () => ({
    imageToDataUrl: async () => "data:image/png;base64,c291cmNl",
}));
mock.module("@/lib/image-raster", () => ({
    loadRasterImage: async () => ({ naturalWidth: 128, naturalHeight: 64 }),
}));
mock.module("@/lib/canvas/image-region-edit", () => ({
    ...regionModule,
    renderRegionThumbnail: () => "",
    renderRegionAnnotatedImage: () => "data:image/jpeg;base64,YW5ub3RhdGlvbg==",
    exportRegionMask: (_size: unknown, regions: readonly ImageEditRegion[]) => {
        const snapshot = structuredClone(regions);
        exports.push(snapshot);
        if (!snapshot.length) throw new Error("请先框选需要修改的区域");
        return `data:image/png;base64,${Buffer.from(JSON.stringify(snapshot)).toString("base64")}`;
    },
}));
mock.module("@/components/model-picker", () => ({
    ModelPicker: ({ value }: { value: string }) => <output aria-label="当前重绘模型">{value}</output>,
}));
mock.module("@/components/canvas/canvas-image-settings-popover", () => ({
    CanvasImageSettingsPopover: ({ config, onConfigChange }: { config: { quality: string }; onConfigChange(key: string, value: string): void }) => <button type="button" onClick={() => onConfigChange("quality", "high")}>画质：{config.quality}</button>,
}));
let submitFromEditor: () => void;
mock.module("@/components/canvas/canvas-resource-mention-textarea", () => ({
    CanvasResourceMentionTextarea: ({ value, onChange, onSubmit }: { value: string; onChange(value: string): void; onSubmit(): void }) => {
        submitFromEditor = onSubmit;
        return <textarea value={value} onChange={(event) => onChange(event.target.value)} />;
    },
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { App } = await import("antd");
const { CanvasNodeRegionEditDialog } = await import("../../src/components/canvas/canvas-node-region-edit-dialog");
const { defaultConfig } = await import("../../src/stores/use-config-store");
type DialogProps = Parameters<typeof CanvasNodeRegionEditDialog>[0];

async function click(element: HTMLElement | null | undefined) {
    assert.ok(element);
    await act(async () => element.click());
}

async function mount(overrides: Partial<DialogProps> = {}) {
    exports.length = 0;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const confirmations: CanvasImageRegionEditPayload[] = [];
    let closes = 0;
    let props: DialogProps = {
        open: true, image: { url: "data:image/png;base64,c291cmNl" }, config: { ...defaultConfig, model: "native-mask-model", imageModel: "native-mask-model", quality: "standard" },
        onClose: () => { closes += 1; }, onConfirm: (payload) => { confirmations.push(payload); }, ...overrides,
    };
    const render = async (next: Partial<DialogProps> = {}) => {
        props = { ...props, ...next };
        await act(async () => root.render(<App><CanvasNodeRegionEditDialog {...props} /></App>));
    };
    await render();
    const prompt = () => container.querySelector("textarea")!;
    const canvas = () => container.querySelector<HTMLDivElement>(".rgn-surface")!;
    const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label);
    const fill = async (value: string) => {
        await act(async () => {
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(prompt(), value);
            prompt().dispatchEvent(new window.Event("input", { bubbles: true }));
        });
    };
    const stroke = async () => {
        const target = canvas();
        let captured = false;
        Object.assign(target, {
            setPointerCapture: () => { captured = true; }, hasPointerCapture: () => captured,
            releasePointerCapture: () => { captured = false; },
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 128, height: 64 }),
        });
        await act(async () => {
            for (const [type, x, y] of [["pointerdown", 10, 12], ["pointermove", 30, 24], ["pointerup", 30, 24]] as const) {
                target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
            }
            const pending = [...frames.values()];
            frames.clear();
            pending.forEach((callback) => callback(0));
        });
    };
    return {
        container, confirmations, render, prompt, canvas, button, fill, stroke,
        closes: () => closes,
        close: async () => { await act(async () => root.unmount()); container.remove(); },
    };
}

try {
    const retained = await mount({ confirmDiscard: true });
    await retained.fill("  将选中区域改为红色  ");
    await retained.stroke();
    await click(retained.button("画质：standard"));
    assert.equal(retained.container.querySelectorAll(".rgn-box").length, 1);
    const prompt = retained.prompt();
    const promptBeforeSubmit = prompt.value;
    const canvas = retained.canvas();
    await click(retained.button("生成"));
    assert.equal(retained.confirmations.length, 1);
    assert.match(retained.confirmations[0].prompt, /将选中区域改为红色/);
    assert.deepEqual(retained.confirmations[0].regions, [{ index: 1, x: 10, y: 12, width: 20, height: 12 }]);
    assert.equal(retained.confirmations[0].generationConfig?.quality, "high");
    await retained.render({ busy: true });
    assert.equal(retained.prompt(), prompt, "busy must keep the native editor mounted");
    assert.equal(retained.canvas(), canvas, "busy must retain the stroke document's canvas");
    assert.equal(modalProps.keyboard, false);
    assert.equal(modalProps.maskClosable, false);
    assert.equal((retained.button("生成") as HTMLButtonElement).disabled, true);
    assert.ok(retained.container.querySelector("[inert]"), "busy must make editing controls inert");
    await click(retained.button("生成"));
    await click(retained.container.querySelector('[aria-label="关闭"]'));
    await act(async () => { submitFromEditor(); modalProps.onCancel(); });
    assert.equal(retained.confirmations.length, 1, "busy cannot confirm twice even through a retained callback");
    assert.equal(retained.closes(), 0, "busy cannot close the editor");
    assert.equal(exports.length, 1);
    await retained.render({ busy: false });
    assert.equal(retained.prompt().value, promptBeforeSubmit, "failed submission must preserve the exact editable prompt");
    assert.equal(retained.container.querySelector("[inert]"), null);
    await click(retained.button("生成"));
    assert.equal(retained.confirmations.length, 2);
    assert.deepEqual(retained.confirmations[1], retained.confirmations[0], "retry must preserve prompt, mask strokes and selected settings");
    assert.deepEqual(exports[1], exports[0]);
    await retained.close();

    let recoveries = 0;
    const recovery = await mount();
    await recovery.fill("待确认请求的原输入");
    await recovery.stroke();
    await recovery.render({ submissionRecovery: <button type="button" onClick={() => { recoveries += 1; }}>恢复原局部编辑</button> });
    assert.equal((recovery.button("生成") as HTMLButtonElement).disabled, true);
    assert.ok(recovery.container.querySelector("[inert]"));
    await click(recovery.button("生成"));
    await act(async () => submitFromEditor());
    await click(recovery.button("恢复原局部编辑"));
    assert.equal(recoveries, 1);
    assert.equal(recovery.confirmations.length, 0, "pending recovery must use its frozen request without a new confirm");
    assert.equal(exports.length, 0, "pending recovery must not export a new mask");
    assert.match(recovery.prompt().value, /待确认请求的原输入/);
    await recovery.close();

    const dirty = await mount({ confirmDiscard: true });
    await dirty.fill("保留未提交修改");
    await dirty.stroke();
    await click(dirty.container.querySelector('[aria-label="关闭"]'));
    assert.equal(dirty.closes(), 0);
    const discard = () => [...document.querySelectorAll<HTMLElement>(".ant-modal-confirm")].at(-1);
    assert.ok(discard()?.textContent?.includes("放弃局部编辑修改？"));
    await click([...discard()!.querySelectorAll("button")].find((item) => item.textContent === "继续编辑"));
    assert.equal(dirty.closes(), 0);
    assert.match(dirty.prompt().value, /保留未提交修改/);
    await click(dirty.button("生成"));
    assert.equal(dirty.confirmations.length, 1);
    assert.equal(exports.at(-1)?.length, 1, "discard cancellation must retain the painted selection");
    await click(dirty.container.querySelector('[aria-label="关闭"]'));
    await click([...discard()!.querySelectorAll("button")].find((item) => item.textContent === "放弃修改并关闭"));
    assert.equal(dirty.closes(), 1);
    await dirty.close();

    const native = await mount();
    await native.fill("原调用方正文");
    await native.stroke();
    await click(native.container.querySelector('[aria-label="关闭"]'));
    assert.equal(native.closes(), 1, "callers without confirmDiscard must keep their original direct close behavior");
    assert.equal(document.querySelector(".ant-modal-confirm"), null);
    await native.close();

    const clean = await mount({ confirmDiscard: true });
    await click(clean.container.querySelector('[aria-label="关闭"]'));
    assert.equal(clean.closes(), 1, "an untouched editor must close without unnecessary confirmation");
    assert.equal(document.querySelector(".ant-modal-confirm"), null);
    await clean.close();

    console.log("workbench-mask-dialog: 5 scenarios passed");
} finally {
    await window.happyDOM.close();
}
