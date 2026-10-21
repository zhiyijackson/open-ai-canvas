import type { Skill, SkillPreset } from "@/services/api/skills";

export type DirectorSkillSelection = {
    mode: "scene" | "custom" | "general";
    skillIds: string[];
    presetId?: string;
    presetName?: string;
    sceneToolId?: string;
};

export type DirectorSkillSnapshot = Pick<Skill, "skillId" | "skillName" | "versionId" | "version">;

// UUIDs come from the host's builtinCatalogID("tool/" + seed key), never display names.
const directorScenes: Readonly<Record<string, string>> = {
    "41125721-244f-5d8f-a412-60afdc549ee7": "ad-full-chain", // vertical-product-hook
    "75a100a8-d5a5-5bb5-8d92-92f144b554bc": "short-drama-starter", // drama-vertical-hook
    "b847e912-65b5-543d-bffc-17b83c89d19c": "ai-performer", // drama-lipsync-line
};

const videoPresetIds = new Set(["short-drama-starter", "short-drama-pilot", "ad-full-chain", "h3-video", "seedance-video", "ai-performer"]);

export function directorPresetForTool(toolId: string) {
    return directorScenes[toolId];
}

export function isDirectorScene(toolId: string) {
    return Boolean(directorPresetForTool(toolId));
}

export function videoDirectorPresets(presets: SkillPreset[]) {
    return presets.filter((preset) => videoPresetIds.has(preset.presetId));
}

export function normalizeDirectorSelection(selection: DirectorSkillSelection): DirectorSkillSelection {
    if (!["scene", "custom", "general"].includes(selection.mode) || !Array.isArray(selection.skillIds)) throw new Error("编导技能选择无效，请重新选择");
    if (selection.skillIds.some((id) => typeof id !== "string" || !id.trim())) throw new Error("编导技能身份无效，请重新选择");
    const skillIds = [...new Set(selection.skillIds.map((id) => id.trim()))];
    if (skillIds.length > 8) throw new Error("编导最多启用 8 个技能");
    if (selection.mode === "general" && skillIds.length) throw new Error("通用编导不能包含场景技能");
    if (selection.mode !== "general" && !skillIds.length) throw new Error("场景技能尚未确认，请选择技能或主动切换通用编导");
    if (selection.mode === "scene" && !selection.presetId?.trim()) throw new Error("编导场景预设身份缺失，请重新选择");
    return {
        mode: selection.mode,
        skillIds,
        ...(selection.presetId ? { presetId: selection.presetId.trim() } : {}),
        ...(selection.presetName ? { presetName: selection.presetName } : {}),
        ...(selection.sceneToolId ? { sceneToolId: selection.sceneToolId.trim() } : {}),
    };
}

export function directorSelectionFromPreset(preset: SkillPreset, sceneToolId?: string): DirectorSkillSelection {
    return normalizeDirectorSelection({ mode: "scene", presetId: preset.presetId, presetName: preset.name, skillIds: [...preset.skillIds], sceneToolId });
}

export function snapshotDirectorSkills(selection: DirectorSkillSelection, skills: readonly Skill[]): DirectorSkillSnapshot[] {
    const byId = new Map(skills.map((skill) => [skill.skillId, skill]));
    return normalizeDirectorSelection(selection).skillIds.map((id) => {
        const skill = byId.get(id);
        if (!skill || skill.status !== 1 || !skill.skillName) throw new Error(`技能 ${id} 不可用，请重新选择或重试读取`);
        return { skillId: skill.skillId, skillName: skill.skillName, versionId: skill.versionId, version: skill.version };
    });
}
