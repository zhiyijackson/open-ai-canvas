import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cloudAgentPrefillSkillIds } from "../../src/components/canvas/canvas-cloud-agent-panel";
import { directorPresetForTool, directorSelectionFromPreset, directorSelectionIssue, isDirectorScene, normalizeDirectorSelection, snapshotDirectorSkills, videoDirectorPresets } from "../../src/open-ai-canvas-expand/director-skills";
import { clearWorkbenchDraftsForScope, readWorkbenchDraft, sameWorkbenchComposerDraft, writeWorkbenchDraft, type WorkbenchSessionDraft } from "../../src/open-ai-canvas-expand/workbench-session";
import type { Skill, SkillPreset } from "../../src/services/api/skills";

const presets = JSON.parse(readFileSync(resolve(import.meta.dir, "../../../backend/internal/skills/seed/presets.json"), "utf8")).presets as SkillPreset[];
const skill = (id: string, extra: Partial<Skill> = {}) => ({ skillId: id, skillName: `真实技能 ${id}`, isAdded: true, status: 1, versionId: `version-${id}`, version: "1", ...extra }) as Skill;
const builtinId = (key: string) => {
    const bytes = createHash("sha1").update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex")).update(`yingce/workbench/tool/${key}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6]! & 15) | 80;
    bytes[8] = (bytes[8]! & 63) | 128;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

afterEach(() => { clearWorkbenchDraftsForScope("director-user-a"); clearWorkbenchDraftsForScope("director-user-b"); });

describe("director real skill identity", () => {
    test("maps only stable existing host scene identities to published preset identities", () => {
        const catalog = JSON.parse(readFileSync(resolve(import.meta.dir, "../../../backend/internal/workbench/seed/catalog.json"), "utf8")) as Array<{ key: string }>;
        for (const [key, presetId] of [["vertical-product-hook", "ad-full-chain"], ["drama-vertical-hook", "short-drama-starter"], ["drama-lipsync-line", "ai-performer"]]) {
            expect(catalog.some((entry) => entry.key === key)).toBe(true);
            expect(directorPresetForTool(builtinId(key!))).toBe(presetId);
            const preset = presets.find((item) => item.presetId === presetId)!;
            expect(directorSelectionFromPreset(preset).skillIds).toEqual(preset.skillIds);
        }
        expect(isDirectorScene("竖屏商品三秒钩子")).toBe(false);
        expect(isDirectorScene(builtinId("image-to-video-motion"))).toBe(false);
        expect(videoDirectorPresets(presets).map((preset) => preset.presetId)).not.toContain("ecom-image");
    });

    test("reads historical general intent but blocks it and empty custom selections for new director runs", () => {
        expect(directorSelectionIssue(null)).toContain("选择编导场景");
        expect(directorSelectionIssue({ mode: "general", skillIds: [] })).toContain("至少需要一项真实技能");
        expect(directorSelectionIssue({ mode: "custom", skillIds: [] })).toContain("至少需要一项真实技能");
        expect(directorSelectionIssue({ mode: "custom", skillIds: ["real-id"] })).toBeUndefined();
        expect(() => normalizeDirectorSelection({ mode: "scene", presetId: "missing", skillIds: [] })).toThrow("场景技能尚未确认");
        expect(() => normalizeDirectorSelection({ mode: "general", skillIds: ["real-id"] })).toThrow("通用编导不能包含");
        expect(normalizeDirectorSelection({ mode: "general", skillIds: [] })).toEqual({ mode: "general", skillIds: [] });
        const selection = { mode: "custom" as const, skillIds: ["real-id"] };
        expect(snapshotDirectorSkills(selection, [skill("real-id")])).toEqual([{ skillId: "real-id", skillName: "真实技能 real-id", versionId: "version-real-id", version: "1" }]);
        expect(() => snapshotDirectorSkills(selection, [skill("real-id", { status: 0 })])).toThrow("不可用");
    });

    test("skill intent participates in dirty detection and remains isolated and deeply cloned", () => {
        const draft: WorkbenchSessionDraft = { prompt: "短片", model: "model", parameters: {}, references: [], directorSelection: { mode: "custom", skillIds: ["skill-a"] } };
        writeWorkbenchDraft("director-user-a", "video", draft);
        draft.directorSelection!.skillIds.push("late-mutation");
        const restored = readWorkbenchDraft("director-user-a", "video")!;
        expect(restored.directorSelection?.skillIds).toEqual(["skill-a"]);
        restored.directorSelection!.skillIds.push("local-mutation");
        expect(readWorkbenchDraft("director-user-a", "video")?.directorSelection?.skillIds).toEqual(["skill-a"]);
        expect(readWorkbenchDraft("director-user-a", "image")).toBeNull();
        expect(readWorkbenchDraft("director-user-b", "video")).toBeNull();
        expect(sameWorkbenchComposerDraft(restored, { ...restored, directorSelection: { mode: "general", skillIds: [] } })).toBe(false);
        clearWorkbenchDraftsForScope("director-user-a");
        expect(readWorkbenchDraft("director-user-a", "video")).toBeNull();
    });
});

describe("native Agent optional skill prefill", () => {
    test("leaves native prefills alone and permits only an explicit empty general intent", () => {
        expect(cloudAgentPrefillSkillIds(undefined, [], false)).toBeUndefined();
        expect(cloudAgentPrefillSkillIds([], [], false)).toEqual([]);
        expect(() => cloudAgentPrefillSkillIds(["skill-a"], [], false)).toThrow("暂停发送");
    });

    test("waits for all required skills and never filters missing, disabled or uninstalled IDs", () => {
        expect(() => cloudAgentPrefillSkillIds(["skill-a", "skill-b"], [skill("skill-a")], true)).toThrow("skill-b");
        expect(() => cloudAgentPrefillSkillIds(["skill-a"], [skill("skill-a", { isAdded: false })], true)).toThrow("尚未加入");
        expect(() => cloudAgentPrefillSkillIds(["skill-a"], [skill("skill-a", { status: 0 })], true)).toThrow("不可用");
        expect(() => cloudAgentPrefillSkillIds(["广告全链路"], [skill("16000000000105")], true)).toThrow("广告全链路");
    });

    test("returns an immutable validated set independent of later input or selection updates", () => {
        const input = ["skill-a", "skill-b", "skill-a"];
        const frozen = cloudAgentPrefillSkillIds(input, [skill("skill-b"), skill("skill-a")], true)!;
        input.splice(0, input.length, "changed");
        expect(frozen).toEqual(["skill-a", "skill-b"]);
        expect(Object.isFrozen(frozen)).toBe(true);
        expect(() => cloudAgentPrefillSkillIds(Array.from({ length: 9 }, (_, index) => `s-${index}`), [], true)).toThrow("最多启用 8");
    });
});
