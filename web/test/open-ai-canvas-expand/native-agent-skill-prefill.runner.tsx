import { mock } from "bun:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const window = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Element: window.Element, IS_REACT_ACT_ENVIRONMENT: true });
window.localStorage.setItem("yingce:active-user-scope", "user-a");
let userId = "user-a";
const events: string[] = [];
const requests: Array<{ skillIds: string[]; prompt: string; canvasId?: string }> = [];
let selectedCount = 0;
const defer = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (cause: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
};
const skill = (skillId: string) => ({ skillId, skillName: `Real ${skillId}`, isAdded: true, status: 1 });
let directory = defer<{ skills: ReturnType<typeof skill>[] }>();
const noop = () => {};
const empty = () => null;
const conversationModule = await import("@/services/cloud-agent-conversations");
const historyModule = await import("@/services/cloud-agent-history");

mock.module("file-saver", () => ({ saveAs: noop }));
const appMessage = { warning: (value: string) => events.push(value) };
mock.module("antd", () => ({ App: { useApp: () => ({ message: appMessage }) }, Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button> }));
mock.module("motion/react", () => ({ AnimatePresence: ({ children }: { children: ReactNode }) => children, useReducedMotion: () => true, motion: { aside: ({ children }: { children: ReactNode }) => <aside>{children}</aside>, div: ({ children }: { children: ReactNode }) => <div>{children}</div> } }));
mock.module("@/stores/use-user-store", () => ({ useUserStore: Object.assign((select: (value: unknown) => unknown) => select({ user: { id: userId } }), { getState: () => ({ user: { id: userId } }) }) }));
mock.module("@/stores/canvas/use-canvas-theme-store", () => ({ useActiveTheme: () => "dark" }));
mock.module("@/stores/use-config-store", () => ({
    useEffectiveConfig: () => ({ textModel: "test-model", model: "test-model" }), useConfigStore: (select: (value: unknown) => unknown) => select({ updateConfig: noop }),
    selectableModelsByCapability: () => ["test-model"], modelOptionName: (value: string) => value, logicalModelIDForConfig: () => "", resolveModelRequestConfig: () => ({}), resolveModelChannel: () => ({}),
}));
mock.module("@/lib/canvas/image-to-previs-agent", () => ({ selectImageInspectionModel: () => "test-model" }));
mock.module("@/services/api/skills", () => ({
    listAddedSkills: () => directory.promise, listSkillPresets: async () => ({ presets: [] }), listSkills: async () => ({ skills: [], categories: [], hasMore: false, page: 1 }),
    listSkillLibraryCategories: async () => ({ categories: [] }), addSkill: async (id: string) => ({ skill: skill(id) }),
    getSkillFile: noop, listSkillFiles: noop,
}));
mock.module("@/services/api/agent", () => ({
    AgentStreamError: class AgentStreamError extends Error {},
    getAgentProfile: async () => ({ revision: 1 }), getAgentCapabilities: async () => ({ skills: true, permissionModes: ["request_approval", "read_only", "auto"] }),
    createAgentRun: async (input: { skillIds: string[]; prompt: string }) => { events.push("POST"); requests.push(structuredClone(input)); return { run: { id: "mock-run", status: "completed" } }; },
    sendAgentMessage: async () => { throw new Error("Unexpected follow-up"); }, subscribeAgentEvents: () => noop,
    cancelAgentRun: noop, getAgentRun: noop, decideAgentApproval: noop, sendAgentInterjection: noop, withdrawAgentInterjection: noop, updateAgentProfile: noop, undoAgentCanvasRun: noop,
}));
mock.module("@/services/cloud-agent-conversations", () => ({
    ...conversationModule,
    loadCloudAgentConversations: async () => ({ version: 1, activeId: "existing", conversations: [{ id: "existing", messages: [], run: null, permissionMode: "request_approval", skillIds: ["native-skill"], createdAt: "now", updatedAt: "now" }] }),
    loadCloudAgentPendingSubmission: async () => null,
    saveCloudAgentPendingSubmission: async (_conversation: string, pending: unknown, scope: string) => { assert.ok(pending); assert.equal(scope, userId); events.push("pending-persisted"); },
    saveCloudAgentConversations: async () => { events.push("conversation-persisted"); }, clearCloudAgentPendingSubmission: async () => {}, cloudAgentConversationTitle: () => "test",
}));
mock.module("@/services/cloud-agent-history", () => ({
    ...historyModule,
    refreshCloudAgentConversations: async () => [], loadCloudAgentConversation: async () => { throw new Error("Unexpected cloud conversation load"); },
}));
mock.module("@/services/user-data-sync", () => ({ prepareCanvasForCloudAction: async () => {}, applyAgentCanvasPatches: noop, refreshCanvasAfterAgent: noop }));
mock.module("@/services/agent-canvas-sync", () => ({ createAgentCanvasSync: () => ({ dispose: noop, receive: noop, reconcile: noop }) }));
mock.module("@/services/canvas-edit-leases", () => ({ canvasEditLeases: { subscribe: () => noop, snapshot: () => 0, agent: () => null, agentRejected: noop } }));
mock.module("@/components/canvas/use-agent-panel-layout", () => ({ useAgentPanelLayout: () => ({ style: {}, pointerHandlers: {}, onResizeKeyDown: noop, reset: noop }) }));
mock.module("@/components/skills/skill-curation-browser", () => ({ useSkillCuration: () => ({ curation: null, error: "", retry: noop }), curationQuery: () => ({}) }));
mock.module("@/components/canvas/canvas-cloud-agent-settings", () => ({ CanvasCloudAgentSettings: empty }));
mock.module("@/components/canvas/canvas-agent-skill-library-modal", () => ({ CanvasAgentSkillLibraryModal: empty }));
mock.module("@/components/canvas/canvas-cloud-agent-connectors", () => ({ AgentConnectorsBar: empty }));
mock.module("@/components/canvas/canvas-cloud-agent-panel-parts", () => ({ AgentContextRing: empty, AgentConversation: empty, AgentHeader: empty, AgentHistory: empty, AgentLauncher: empty,
    ComposerControls: ({ selectedSkillCount }: { selectedSkillCount: number }) => { selectedCount = selectedSkillCount; return <span>{selectedSkillCount}</span>; },
}));
mock.module("@/components/canvas/canvas-cloud-agent-chat-ui", () => ({
    AGENT_SCENE_DEFS: [], AgentChatComposer: ({ left }: { left: ReactNode }) => left, parseCloudAgentFormAnswer: () => null, AgentPlanBar: empty, AgentQuestionBar: empty, AgentSceneCapsules: empty,
}));

// Keep the original panel, its hooks, submit controller and pending-request construction under test.
const { CanvasCloudAgentPanel } = await import("../../src/components/canvas/canvas-cloud-agent-panel");
const { useGlobalAgentStore } = await import("../../src/stores/use-global-agent-store");
const settle = async () => { await act(async () => { await new Promise((done) => setTimeout(done, 5)); }); };
const mount = async (canvasId: string, prefill: { id: number; text: string; autoSubmit: boolean; skillIds?: string[] }, persisted: () => Promise<void> | void = noop) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    useGlobalAgentStore.setState({ open: true, canvas: { canvasId, nodeCount: 1, selectedNodeIds: ["focus-node"], references: [], prefillRequest: prefill, onPrefillPendingPersisted: persisted } });
    const render = () => <CanvasCloudAgentPanel />;
    await act(async () => { root.render(render()); });
    await settle();
    return { root, container, rerender: async () => { await act(async () => { root.render(render()); }); await settle(); }, close: async () => { await act(async () => root.unmount()); container.remove(); } };
};

try {
    const callback = defer<void>();
    const originalIds = ["skill-b", "skill-a"];
    const delayed = await mount("delayed", { id: 1, text: "First turn", autoSubmit: true, skillIds: originalIds }, async () => { events.push("callback-start"); await callback.promise; events.push("callback-end"); });
    assert.equal(requests.length, 0, "directory loading must pause POST");
    originalIds.splice(0, originalIds.length, "late-mutation");
    await act(async () => directory.resolve({ skills: [skill("skill-a"), skill("skill-b"), skill("native-skill")] }));
    await settle();
    assert.equal(requests.length, 0, "POST must wait for durable handoff callback");
    assert.ok(events.includes("pending-persisted"));
    assert.ok(events.includes("callback-start"));
    assert.equal(selectedCount, 2, "native UI selection follows confirmed prefill");
    await act(async () => callback.resolve());
    await settle();
    assert.deepEqual(requests[0]?.skillIds, ["skill-b", "skill-a"]);
    assert.ok(events.indexOf("pending-persisted") < events.indexOf("callback-start"));
    assert.ok(events.indexOf("callback-end") < events.indexOf("POST"));
    await delayed.close();

    directory = defer();
    const missing = await mount("missing", { id: 2, text: "Missing skill", autoSubmit: true, skillIds: ["skill-a", "skill-b"] });
    await act(async () => directory.resolve({ skills: [skill("skill-a")] }));
    await settle();
    assert.equal(requests.length, 1, "partial directory must not silently send a smaller skill set");
    assert.match(missing.container.textContent || "", /skill-b/);
    directory = defer();
    await act(async () => window.dispatchEvent(new window.Event("canvas-skills-changed")));
    assert.equal(requests.length, 1);
    await act(async () => directory.resolve({ skills: [skill("skill-a"), skill("skill-b")] }));
    await settle();
    assert.deepEqual(requests[1]?.skillIds, ["skill-a", "skill-b"]);
    await missing.close();

    directory = defer();
    const native = await mount("native", { id: 3, text: "Native prefill", autoSubmit: true });
    assert.deepEqual(requests[2]?.skillIds, ["native-skill"], "undefined preserves native conversation skill behavior");
    await native.close();

    directory = defer();
    const general = await mount("general", { id: 4, text: "General Agent", autoSubmit: true, skillIds: [] });
    assert.deepEqual(requests[3]?.skillIds, [], "explicit general does not inherit prior native skills");
    await general.close();

    directory = defer();
    const switched = await mount("switch", { id: 5, text: "Old account", autoSubmit: true, skillIds: ["skill-a"] });
    userId = "user-b";
    window.localStorage.setItem("yingce:active-user-scope", userId);
    await switched.rerender();
    await act(async () => directory.resolve({ skills: [skill("skill-a")] }));
    await settle();
    assert.equal(requests.length, 4, "previous account prefill must not POST after switching users");
    await switched.close();

    userId = "user-a";
    window.localStorage.setItem("yingce:active-user-scope", userId);
    directory = defer();
    directory.resolve({ skills: [skill("skill-a")] });
    const switchDuringCallback = defer<void>();
    const late = await mount("late-switch", { id: 6, text: "Pending persistence", autoSubmit: true, skillIds: ["skill-a"] }, () => switchDuringCallback.promise);
    assert.equal(requests.length, 4);
    userId = "user-b";
    window.localStorage.setItem("yingce:active-user-scope", userId);
    await late.rerender();
    await act(async () => switchDuringCallback.resolve());
    await settle();
    assert.equal(requests.length, 4, "switching users while pending persistence must cancel the old POST");
    userId = "user-a";
    window.localStorage.setItem("yingce:active-user-scope", userId);
    await late.rerender();
    assert.equal(requests.length, 4, "returning to the old account must not revive the canceled prefill");
    await late.close();

    directory = defer();
    const failed = await mount("failed-directory", { id: 7, text: "Recover directory", autoSubmit: true, skillIds: ["skill-a"] });
    await act(async () => directory.reject(new Error("directory unavailable")));
    await settle();
    assert.equal(requests.length, 4);
    assert.match(failed.container.textContent || "", /技能库读取失败/);
    directory = defer();
    const retry = [...failed.container.querySelectorAll("button")].find((button) => button.textContent === "重新读取技能");
    assert.ok(retry);
    await act(async () => retry.click());
    await act(async () => directory.resolve({ skills: [skill("skill-a")] }));
    await settle();
    assert.deepEqual(requests[4]?.skillIds, ["skill-a"]);
    await failed.close();

    directory = defer();
    const route = await mount("route-a", { id: 1, text: "Abandoned canvas", autoSubmit: true, skillIds: ["skill-a"] });
    await act(async () => useGlobalAgentStore.getState().setCanvas(null));
    await act(async () => useGlobalAgentStore.getState().setCanvas({ canvasId: "route-b", nodeCount: 1, selectedNodeIds: ["focus-b"], references: [], prefillRequest: { id: 1, text: "Next canvas", autoSubmit: true, skillIds: ["skill-b"] } }));
    await act(async () => directory.resolve({ skills: [skill("skill-a"), skill("skill-b")] }));
    await settle();
    assert.equal(requests.length, 6, "persistent global panel must accept the next canvas's first prefill exactly once");
    assert.equal(requests[5]?.canvasId, "route-b");
    assert.equal(requests[5]?.prompt, "Next canvas");
    assert.deepEqual(requests[5]?.skillIds, ["skill-b"]);
    await route.close();

    directory = defer();
    const removed = await mount("removed-skill", { id: 1, text: "Keep native draft", autoSubmit: false });
    assert.equal(selectedCount, 1, "a loading catalog must preserve the saved native selection");
    await act(async () => directory.reject(new Error("catalog offline")));
    await settle();
    assert.equal(selectedCount, 1, "a failed catalog must not erase the saved native selection");
    directory = defer();
    await act(async () => window.dispatchEvent(new window.Event("canvas-skills-changed")));
    await act(async () => directory.resolve({ skills: [] }));
    await settle();
    assert.equal(selectedCount, 0, "a loaded catalog removes deleted native skills");
    assert.ok(events.some((event) => event.includes("已失效的技能")));
    await act(async () => useGlobalAgentStore.getState().setCanvas({ canvasId: "removed-skill", nodeCount: 1, selectedNodeIds: [], references: [], prefillRequest: { id: 2, text: "Send after deletion", autoSubmit: true } }));
    await settle();
    assert.equal(requests.length, 7);
    assert.deepEqual(requests[6]?.skillIds, [], "normal sends exclude deleted skills without weakening director validation");
    await removed.close();
    console.log("native-agent-skill-prefill: passed");
} finally {
    await window.happyDOM.close();
}
