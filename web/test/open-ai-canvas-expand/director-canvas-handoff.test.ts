import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    clearDirectorHandoffSession,
    directorAgentPrompt,
    directorHandoffNodeIds,
    markDirectorHandoffPrepared,
    startOrResumeDirectorHandoff as startHandoff,
    uninsertedDirectorHandoffPayloads,
    type StoredDirectorHandoff,
    type StartDirectorHandoffInput,
} from "../../src/open-ai-canvas-expand/director-canvas-handoff";
import { apiClient } from "../../src/services/api/request";
import { useCanvasStore } from "../../src/stores/canvas/use-canvas-store";
import * as canvasStoreModule from "../../src/stores/canvas/use-canvas-store";
import { useAssetStore } from "../../src/stores/use-asset-store";

const startOrResumeDirectorHandoff = (input: StartDirectorHandoffInput) => startHandoff({
    skillSelection: { mode: "custom", skillIds: ["director-skill"] },
    skillSnapshots: [{ skillId: "director-skill", skillName: "视频导演", versionId: "v1", version: "1" }],
    ...input,
});

const record: StoredDirectorHandoff = {
    version: 1,
    contextId: "director-context-1",
    canvasId: "canvas-1",
    prompt: "为新品制作一支可信的门店口播短片",
    language: "普通话",
    durationSeconds: 25,
    assetIds: ["asset-image"],
    resourcePayloads: [
        { kind: "audio", url: "/api/resources/audio/file", storageKey: "resource:audio", title: "参考声音", bytes: 12, mimeType: "audio/wav" },
    ],
    createdAt: "2026-10-19T00:00:00.000Z",
};

const originalAdapter = apiClient.defaults.adapter;
const originalProjects = useCanvasStore.getState().projects;
const originalAssets = useAssetStore.getState().assets;
const readyImage = (id: string) => ({
    id,
    userId: "guest",
    kind: "image",
    status: "ready",
    provider: "local",
    endpoint: "",
    bucket: "",
    objectKey: `${id}.png`,
    publicUrl: "",
    mimeType: "image/png",
    size: 12,
    width: 32,
    height: 32,
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
});
beforeEach(() => {
    useCanvasStore.setState({ hydrated: true, projects: [] });
    useAssetStore.setState({ hydrated: true, assets: [] });
});

afterEach(async () => {
    apiClient.defaults.adapter = originalAdapter;
    await clearDirectorHandoffSession("guest");
    useCanvasStore.setState({ projects: originalProjects });
    useAssetStore.setState({ assets: originalAssets });
});

describe("director canvas handoff", () => {
    test("rejects invalid requests before creating a canvas", async () => {
        await expect(startOrResumeDirectorHandoff({ contextId: "draft-1", prompt: "" })).rejects.toThrow("请先填写创作需求");
        await expect(
            startOrResumeDirectorHandoff({
                contextId: "draft-1",
                prompt: "生成短片",
                assetIds: Array.from({ length: 9 }, (_, index) => `asset-${index}`),
            }),
        ).rejects.toThrow("最多引用 8 个焦点素材");
        await expect(
            startOrResumeDirectorHandoff({ contextId: "draft-1", prompt: "生成短片", resources: [{ resourceId: "audio-1", kind: "audio" }] }),
        ).rejects.toThrow("至少需要一张参考图片");
        useAssetStore.setState({
            assets: [
                {
                    id: "audio-asset",
                    kind: "audio",
                    title: "旁白",
                    coverUrl: "",
                    tags: [],
                    createdAt: "2026-10-19T00:00:00.000Z",
                    updatedAt: "2026-10-19T00:00:00.000Z",
                    data: { url: "/audio.wav", durationMs: 1000, bytes: 12, mimeType: "audio/wav" },
                },
            ],
        });
        await expect(startOrResumeDirectorHandoff({ contextId: "draft-audio", prompt: "生成短片", assetIds: ["audio-asset"] })).rejects.toThrow("至少需要一张参考图片");
    });

    test("builds the Agent request with the original director constraints", () => {
        expect(directorAgentPrompt(record)).toBe(
            [
                "请作为本项目的超级编导，先分析已选焦点素材和创作需求，再提出可执行的脚本、镜头与制作步骤。",
                "创作需求：为新品制作一支可信的门店口播短片",
                "成片语言：普通话",
                "目标时长：25 秒",
                "涉及模型生成或付费操作时，继续使用当前 Agent 的审批与费用确认流程。",
            ].join("\n"),
        );
    });

    test("reuses previously inserted asset and Resource nodes", () => {
        const nodes = [
            { id: "asset-node", metadata: { assetId: "asset-image" } },
            { id: "audio-node", metadata: { storageKey: "resource:audio" } },
        ];
        const payloads = [
            { kind: "image" as const, dataUrl: "/image.png", title: "主图", assetId: "asset-image" },
            ...record.resourcePayloads,
        ];
        expect(uninsertedDirectorHandoffPayloads(nodes, payloads)).toEqual([]);
        expect(directorHandoffNodeIds(nodes, record)).toEqual(["asset-node", "audio-node"]);
    });

    test("consumes the director route only after the Agent pending request is durable", () => {
        const panel = readFileSync(resolve(import.meta.dir, "../../src/components/canvas/canvas-cloud-agent-panel.tsx"), "utf8");
        const hook = readFileSync(resolve(import.meta.dir, "../../src/open-ai-canvas-expand/use-director-canvas-handoff.ts"), "utf8");
        expect(panel.indexOf("saveCloudAgentPendingSubmission(canvasId, activeConversationId, next)")).toBeLessThan(panel.indexOf("onPrefillPendingPersisted?.(options.id)"));
        expect(panel.indexOf("onPrefillPendingPersisted?.(options.id)")).toBeLessThan(panel.indexOf("createAgentRun(request)"));
        expect(panel).toContain("appendAgentPromptPrefill(current, prefillRequest.displayText || prefillRequest.text)");
        expect(panel).not.toContain("current.trim() === display.trim()");
        expect(hook).toContain("await markDirectorHandoffPrepared(contextId, projectId)");
        expect(hook).toContain('next.delete("mode")');
        expect(hook).toContain('next.delete("director")');
    });

    test("session cleanup invalidates a pending handoff before it can create a canvas", async () => {
        let releaseRequest!: () => void;
        let requestStarted!: () => void;
        const started = new Promise<void>((resolve) => (requestStarted = resolve));
        const released = new Promise<void>((resolve) => (releaseRequest = resolve));
        apiClient.defaults.adapter = async (config) => {
            requestStarted();
            await released;
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: { resource: readyImage("director-race-image") }, msg: "ok" } };
        };

        const pending = startOrResumeDirectorHandoff({
            contextId: "director-race",
            prompt: "生成一支短片",
            resources: [{ resourceId: "director-race-image", kind: "image" }],
        });
        await started;
        await clearDirectorHandoffSession("guest");
        releaseRequest();

        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(useCanvasStore.getState().projects).toHaveLength(0);
    });

    test("retries the same canvas when post-create local persistence fails", async () => {
        apiClient.defaults.adapter = async (config) => ({
            config,
            status: 200,
            statusText: "OK",
            headers: {},
            data: { code: 0, data: { resource: readyImage("director-persist-image") }, msg: "ok" },
        });
        const flush = spyOn(canvasStoreModule, "flushCanvasStorePersistence").mockRejectedValueOnce(new Error("local persistence unavailable"));
        const input = {
            contextId: "director-persist-retry",
            prompt: "制作一支新品短片",
            resources: [{ resourceId: "director-persist-image", kind: "image" as const }],
        };

        try {
            await expect(startOrResumeDirectorHandoff(input)).rejects.toThrow("local persistence unavailable");
            expect(useCanvasStore.getState().projects).toHaveLength(1);
            const canvasId = useCanvasStore.getState().projects[0]!.id;

            const resumed = await startOrResumeDirectorHandoff(input);
            expect(resumed).toMatchObject({ canvasId, resumed: true });
            expect(useCanvasStore.getState().projects).toHaveLength(1);
            expect(flush).toHaveBeenCalledTimes(2);
        } finally {
            flush.mockRestore();
        }
    });

    test("prepared handoff rejects changed input and directs the user to the original Agent", async () => {
        apiClient.defaults.adapter = async (config) => ({
            config,
            status: 200,
            statusText: "OK",
            headers: {},
            data: { code: 0, data: { resource: readyImage("director-prepared-image") }, msg: "ok" },
        });
        const input = {
            contextId: "director-prepared",
            prompt: "制作门店介绍",
            resources: [{ resourceId: "director-prepared-image", kind: "image" as const }],
        };
        const created = await startOrResumeDirectorHandoff(input);
        await markDirectorHandoffPrepared(input.contextId, created.canvasId);

        await expect(startOrResumeDirectorHandoff({ ...input, prompt: "改成新品口播" })).rejects.toThrow(`请前往画布 ${created.canvasId} 的 Agent 继续对话`);
        expect(useCanvasStore.getState().projects).toHaveLength(1);

        await clearDirectorHandoffSession("guest");
        const restarted = await startOrResumeDirectorHandoff(input);
        expect(restarted.resumed).toBe(false);
        expect(restarted.canvasId).not.toBe(created.canvasId);
    });
});
