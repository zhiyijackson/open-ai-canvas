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
const realSkill = { skillId: "skill-a", skillName: "真实技能", isAdded: true, status: 1, versionId: "v-a", version: "1" };
const skills = [realSkill, { ...realSkill, skillId: "skill-b", skillName: "第二项真实技能" }];
const added = { data: { skills: [] as typeof realSkill[] }, isPending: false, isError: false, refetch: async () => {} };
const installs: Array<{ id: string; pending: ReturnType<typeof defer<void>> }> = [];
mock.module("antd", () => ({ App: { useApp: () => ({ message: { warning: () => {}, error: () => {}, success: () => {} } }) } }));
mock.module("react-router", () => ({ useNavigate: () => (path: string) => paths.push(path) }));
mock.module("@tanstack/react-query", () => ({ useQuery: (options: { queryKey: string[] }) => options.queryKey[0] === "workbench-director-added-skills" ? added : query, useQueries: ({ queries }: { queries: Array<{ queryKey: string[] }> }) => queries.map((q) => ({ data: { skill: skills.find(s => s.skillId === q.queryKey[2]) }, isPending: false, isError: false })) }));
mock.module("@/services/api/skills", () => ({ addSkill: async (id: string) => { const pending = defer<void>(); installs.push({ id, pending }); await pending.promise; added.data.skills.push(skills.find(s => s.skillId === id)!); }, listAddedSkills: async () => added.data, getSkill: async () => {}, listSkillPresets: async () => ({ presets: [] }) }));
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
    await act(async () => { await latest.submit(); });
    assert.equal(calls.length, 0, "empty director selection cannot create a canvas");
    await act(async () => latest.setSelection({ mode: "general", skillIds: [] }));
    await act(async () => { await latest.submit(); });
    assert.equal(calls.length, 0, "historical general intent cannot start a new director run");
    await act(async () => latest.setSelection({ mode: "custom", skillIds: ["skill-a", "skill-b"] }));
    let installation!: Promise<void>;
    await act(async () => { installation = latest.installMissingSkills(); });
    await act(async () => { await latest.installMissingSkills(); });
    assert.equal(installs.length, 1, "double clicks do not install the same skills twice");
    await act(async () => installs[0]!.pending.resolve());
    assert.equal(installs[1]!.id, "skill-b");
    await act(async () => installs[1]!.pending.reject(new Error("installation failed")));
    await installation;
    await render();
    assert.deepEqual(latest.missingSkills.map(s => s.skillId), ["skill-b"], "partial installation retains the successful part");
    assert.deepEqual(latest.selection?.skillIds, ["skill-a", "skill-b"], "installation never removes a required skill");
    await act(async () => { installation = latest.installMissingSkills(); });
    assert.equal(installs[2]!.id, "skill-b", "retry installs only the missing skill");
    await act(async () => installs[2]!.pending.resolve());
    await installation;
    await render();
    assert.equal(latest.skillsIssue, undefined);
    assert.equal(calls.length, 0, "successful installation never starts Agent automatically");
    added.data.skills = [];
    await render();
    await act(async () => { installation = latest.installMissingSkills(); });
    await act(async () => latest.setSelection({ mode: "custom", skillIds: ["skill-b"] }));
    await act(async () => installs[3]!.pending.resolve());
    await installation;
    await render();
    assert.equal(installs.length, 4, "a scene change stops remaining installs from an older attempt");
    assert.deepEqual(latest.selection?.skillIds, ["skill-b"], "late installation does not rewrite a newer scene");
    added.data.skills = [];
    await act(async () => latest.setSelection({ mode: "custom", skillIds: ["skill-a"] }));
    await act(async () => { await latest.submit(); });
    assert.equal(calls.length, 0, "uninstalled skills block before canvas creation");
    added.data.skills = [realSkill];
    await render();
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
