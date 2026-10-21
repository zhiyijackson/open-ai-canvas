import { mock } from "bun:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

const window = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
const defer = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (cause: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
};
type Record = { contextId: string; canvasId: string; preparedAt?: string };
type Navigation = { path: string; canvasId: string };
const records = new Map<string, Record>();
const reads: string[] = [];
const calls: Array<{ contextId: string; userId: string; pending: ReturnType<typeof defer<Navigation>> }> = [];
const paths: string[] = [];
let userId = "user-a";
const query = { data: { presets: [] }, isPending: false, isError: false, refetch: async () => {} };
mock.module("antd", () => ({ App: { useApp: () => ({ message: { warning: () => {}, error: () => {} } }) } }));
mock.module("react-router", () => ({ useNavigate: () => (path: string) => paths.push(path) }));
mock.module("@tanstack/react-query", () => ({ useQuery: () => query, useQueries: () => [] }));
mock.module("@/services/api/skills", () => ({ getSkill: async () => {}, listSkillPresets: async () => ({ presets: [] }) }));
mock.module("@/stores/use-user-store", () => ({ useUserStore: { getState: () => ({ user: { id: userId } }) } }));
mock.module("@/open-ai-canvas-expand/director-canvas-handoff", () => ({
    findDirectorHandoff: async (contextId: string, scope: string) => { reads.push(`${scope}:${contextId}`); return records.get(`${scope}:${contextId}`) || null; },
    directorHandoffNavigationPath: (record: Record) => `/canvas/${record.canvasId}`,
    startOrResumeDirectorHandoff: (input: { contextId: string; expectedUserScope: string }) => {
        const pending = defer<Navigation>();
        calls.push({ contextId: input.contextId, userId: input.expectedUserScope, pending });
        return pending.promise;
    },
}));

const { useWorkbenchDirector } = await import("../../src/open-ai-canvas-expand/use-workbench-director");
let latest!: ReturnType<typeof useWorkbenchDirector>;
const revision = { current: 0 };
function Harness() {
    latest = useWorkbenchDirector({ kind: "video", prompt: "制作短片", references: [{ id: "reference", resourceId: "image", name: "image", kind: "image", previewUrl: "", progress: 100, uploading: false, role: "reference" }], seconds: "6", userId, workbenchRevisionRef: revision });
    return null;
}
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
const settle = async () => { await act(async () => { await new Promise((done) => setTimeout(done, 5)); }); };
const render = async () => { await act(async () => root.render(<Harness />)); await settle(); };
const start = async () => {
    let submission!: Promise<unknown>;
    await act(async () => { submission = latest.submit(); });
    assert.equal(latest.busy, true);
    return { completion: submission };
};
const durable = (call: (typeof calls)[number]) => {
    const record = { contextId: call.contextId, canvasId: `canvas-${call.userId}-${call.contextId}` };
    records.set(`${call.userId}:${call.contextId}`, record);
    return { canvasId: record.canvasId, path: `/canvas/${record.canvasId}?mode=director&director=${record.contextId}` };
};

try {
    await render();
    await act(async () => latest.selectGeneral());
    const first = await start();
    await act(async () => { void latest.submit(); });
    assert.equal(calls.length, 1, "double clicks share one active attempt");
    revision.current += 1;
    durable(calls[0]!);
    await act(async () => calls[0]!.pending.reject(new Error("post-create flush failed")));
    await first.completion;
    await settle();
    assert.equal(latest.busy, false, "composer revision changes must not keep busy forever");
    assert.equal(latest.hasHandoff, true, "durable association is reread after a later sync failure");
    assert.equal(latest.handoffLoading, false);
    assert.equal(paths.length, 0, "edited composer must not navigate from a stale result");
    assert.ok(reads.filter((key) => key === `user-a:${calls[0]!.contextId}`).length >= 2);

    await act(async () => latest.setContextId("context-old"));
    await settle();
    const old = await start();
    await act(async () => latest.setContextId("context-new"));
    await settle();
    assert.equal(latest.busy, false);
    const newer = await start();
    const readCount = reads.length;
    await act(async () => calls[1]!.pending.resolve(durable(calls[1]!)));
    await old.completion;
    await settle();
    assert.equal(latest.contextId, "context-new");
    assert.equal(latest.busy, true, "late old context cannot clear the new attempt's busy state");
    assert.equal(reads.length, readCount, "late old context cannot trigger a refresh of the new context");
    assert.equal(paths.length, 0);
    await act(async () => calls[2]!.pending.resolve(durable(calls[2]!)));
    await newer.completion;
    await settle();
    assert.equal(latest.busy, false);
    assert.equal(latest.hasHandoff, true);
    assert.equal(paths.length, 1);
    assert.match(paths[0]!, /context-new/);

    await act(async () => latest.setContextId("account-race"));
    await settle();
    const accountOld = await start();
    userId = "user-b";
    await render();
    const accountNew = await start();
    const accountReadCount = reads.length;
    await act(async () => calls[3]!.pending.resolve(durable(calls[3]!)));
    await accountOld.completion;
    await settle();
    assert.equal(latest.busy, true, "old account cannot clear a newer account's busy state");
    assert.equal(reads.length, accountReadCount);
    assert.equal(paths.length, 1);
    await act(async () => calls[4]!.pending.resolve(durable(calls[4]!)));
    await accountNew.completion;
    await settle();
    assert.equal(latest.busy, false);
    assert.match(paths[1]!, /user-b/);
    console.log("workbench-director-attempt: passed");
} finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
}
