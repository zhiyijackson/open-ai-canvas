import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { clearDirectorHandoffSession, directorAgentPrompt, directorHandoffSkillIds, loadDirectorHandoff, markDirectorHandoffPrepared, startOrResumeDirectorHandoff } from "../../src/open-ai-canvas-expand/director-canvas-handoff";
import { apiClient } from "../../src/services/api/request";
import { useCanvasStore } from "../../src/stores/canvas/use-canvas-store";
import type { DirectorSkillSelection } from "../../src/open-ai-canvas-expand/director-skills";
import * as userDataSync from "../../src/services/user-data-sync";

const adapter = apiClient.defaults.adapter;
const originalProjects = useCanvasStore.getState().projects;
const resource = { id: "director-skill-image", userId: "guest", kind: "image", status: "ready", provider: "local", endpoint: "", bucket: "", objectKey: "reference.png", publicUrl: "", mimeType: "image/png", size: 12, width: 32, height: 32, createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z" };
const input = (contextId: string) => ({ contextId, prompt: "制作短片", resources: [{ resourceId: resource.id, kind: "image" as const }] });
let loadProject: ReturnType<typeof spyOn>;

beforeEach(() => {
    useCanvasStore.setState({ hydrated: true, projects: [] });
    loadProject = spyOn(userDataSync, "loadCanvasProjectForEditing").mockImplementation(async (id) => useCanvasStore.getState().openProject(id));
    apiClient.defaults.adapter = async (config) => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: { resource }, msg: "ok" } });
});
afterEach(async () => { loadProject.mockRestore(); apiClient.defaults.adapter = adapter; await clearDirectorHandoffSession("guest"); useCanvasStore.setState({ projects: originalProjects }); });

describe("director durable skill intent", () => {
    test("retains the original scene IDs and real identity snapshots across handoff and freezes after preparation", async () => {
        const selection: DirectorSkillSelection = { mode: "scene", presetId: "ad-full-chain", presetName: "广告全链路", skillIds: ["skill-a"] };
        const snapshots = [{ skillId: "skill-a", skillName: "真实导演", versionId: "version-a", version: "1" }];
        const request = { ...input("skills-frozen"), skillSelection: selection, skillSnapshots: snapshots };
        const created = await startOrResumeDirectorHandoff(request);
        selection.skillIds.push("late-change");
        snapshots[0]!.skillName = "late-name";
        const stored = await loadDirectorHandoff(request.contextId, created.canvasId);
        expect(directorHandoffSkillIds(stored)).toEqual(["skill-a"]);
        expect(directorAgentPrompt(stored)).toContain("真实导演（skill-a）");
        expect(directorAgentPrompt(stored)).not.toContain("late-name");
        await markDirectorHandoffPrepared(request.contextId, created.canvasId);
        await expect(startOrResumeDirectorHandoff({ ...request, skillSelection: { mode: "custom", skillIds: ["skill-b"] }, skillSnapshots: [{ skillId: "skill-b", skillName: "其他导演", versionId: "v-b", version: "1" }] })).rejects.toThrow("Agent 继续对话");
        const resumed = await startOrResumeDirectorHandoff({ ...request, skillSelection: { ...selection, skillIds: ["skill-a"] } });
        expect(resumed.canvasId).toBe(created.canvasId);
        expect(resumed.path).toContain("agent=1");
        expect(useCanvasStore.getState().projects).toHaveLength(1);
    });

    test("rejects unresolved, historical general and empty custom inputs before canvas creation", async () => {
        expect(() => directorHandoffSkillIds({})).toThrow("旧编导记录尚未确认技能");
        await expect(startOrResumeDirectorHandoff(input("legacy-unresolved"))).rejects.toThrow("选择编导场景");
        for (const mode of ["general", "custom"] as const) {
            await expect(startOrResumeDirectorHandoff({ ...input(`empty-${mode}`), skillSelection: { mode, skillIds: [] }, skillSnapshots: [] })).rejects.toThrow("至少需要一项真实技能");
        }
        expect(useCanvasStore.getState().projects).toHaveLength(0);
    });

    test("rejects incomplete skill snapshots before creating any canvas", async () => {
        await expect(startOrResumeDirectorHandoff({ ...input("missing-snapshot"), skillSelection: { mode: "custom", skillIds: ["skill-a"] } })).rejects.toThrow("身份快照缺失");
        expect(useCanvasStore.getState().projects).toHaveLength(0);
    });
});
