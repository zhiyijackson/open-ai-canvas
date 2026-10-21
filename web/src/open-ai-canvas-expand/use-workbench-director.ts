import { App } from "antd";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { useNavigate } from "react-router";
import { useQueries, useQuery } from "@tanstack/react-query";

import type { WorkbenchKind } from "@/services/api/workbench";
import { getSkill, listSkillPresets } from "@/services/api/skills";
import { useUserStore } from "@/stores/use-user-store";
import { directorHandoffNavigationPath, findDirectorHandoff, startOrResumeDirectorHandoff, type StoredDirectorHandoff } from "./director-canvas-handoff";
import type { ExpandWorkbenchReference } from "./workbench-support";
import { directorPresetForTool, directorSelectionFromPreset, normalizeDirectorSelection, snapshotDirectorSkills, videoDirectorPresets, type DirectorSkillSelection } from "./director-skills";
import { workbenchSessionEpoch } from "./workbench-session";

type UseWorkbenchDirectorInput = {
    kind: WorkbenchKind;
    prompt: string;
    references: ExpandWorkbenchReference[];
    seconds: string;
    userId: string;
    workbenchRevisionRef: MutableRefObject<number>;
};

export function useWorkbenchDirector({ kind, prompt, references, seconds, userId, workbenchRevisionRef }: UseWorkbenchDirectorInput) {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [contextId, setContextId] = useState<string>(() => crypto.randomUUID());
    const [language, setLanguage] = useState(() => (typeof navigator === "undefined" || navigator.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"));
    const [busy, setBusy] = useState(false);
    const identityRef = useRef({ contextId, userId });
    identityRef.current = { contextId, userId };
    const submitAttemptRef = useRef<object | null>(null);
    const [handoffState, setHandoffState] = useState<{ contextId: string; userId: string; record?: StoredDirectorHandoff | null; error?: string } | null>(null);
    const [handoffReadRevision, setHandoffReadRevision] = useState(0);
    const retryHandoff = () => { setHandoffState(null); setHandoffReadRevision((value) => value + 1); };
    const currentHandoff = handoffState?.contextId === contextId && handoffState.userId === userId ? handoffState : null;
    const handedOff = Boolean(currentHandoff?.record?.preparedAt);
    const handoffCanvasId = currentHandoff?.record?.canvasId;
    useEffect(() => {
        if (kind !== "video") return;
        let active = true;
        void findDirectorHandoff(contextId, userId).then((record) => {
            if (active) setHandoffState({ contextId, userId, record });
        }).catch((error) => {
            if (active) setHandoffState({ contextId, userId, error: error instanceof Error ? error.message : "编导交接状态读取失败" });
        });
        return () => { active = false; };
    }, [contextId, handoffReadRevision, kind, userId]);
    const continueHandoff = () => { if (currentHandoff?.record) navigate(directorHandoffNavigationPath(currentHandoff.record)); };
    const [selection, setSelection] = useState<DirectorSkillSelection | null>(null);
    const [skillPickerOpen, setSkillPickerOpen] = useState(false);
    const presetQuery = useQuery({ queryKey: ["workbench-director-presets", userId], queryFn: listSkillPresets, enabled: kind === "video" });
    const presets = videoDirectorPresets(presetQuery.data?.presets || []);
    const skillQueries = useQueries({ queries: (selection?.skillIds || []).map((id) => ({
        queryKey: ["workbench-director-skill", userId, id], queryFn: () => getSkill(id), enabled: kind === "video",
    })) });
    const selectedSkills = skillQueries.flatMap((query) => query.data ? [query.data.skill] : []);
    const skillsLoading = Boolean(selection?.mode === "scene" && presetQuery.isPending) || skillQueries.some((query) => query.isPending);
    const skillsError = (!selection || selection.mode === "scene") && presetQuery.isError ? "场景目录读取失败，请重试"
        : selection?.mode === "scene" && !presetQuery.isPending && !presets.some((preset) => preset.presetId === selection.presetId) ? "此场景预设当前不可用，请重试、重新选择或主动使用通用编导"
        : skillQueries.some((query) => query.isError) || selectedSkills.some((skill) => skill.status !== 1) ? "部分技能已下架或无法访问，请重试或重新选择" : "";
    const retrySkills = () => { void presetQuery.refetch(); skillQueries.forEach((query) => { void query.refetch(); }); };
    const choosePreset = (presetId: string, sceneToolId?: string) => {
        const preset = presets.find((item) => item.presetId === presetId);
        setSelection(preset ? directorSelectionFromPreset(preset, sceneToolId) : { mode: "scene", skillIds: [], presetId, sceneToolId });
    };
    const chooseScene = (toolId: string) => {
        const presetId = directorPresetForTool(toolId);
        if (!presetId) return false;
        choosePreset(presetId, toolId);
        return true;
    };
    const selectGeneral = () => setSelection({ mode: "general", skillIds: [] });

    useEffect(() => {
        if (selection?.mode !== "scene" || selection.skillIds.length) return;
        const preset = presets.find((item) => item.presetId === selection.presetId);
        if (preset?.skillIds.length) setSelection(directorSelectionFromPreset(preset, selection.sceneToolId));
    }, [presetQuery.data, selection]);

    useEffect(() => {
        submitAttemptRef.current = null;
        setBusy(false);
        return () => { submitAttemptRef.current = null; };
    }, [contextId, userId]);

    const submit = useCallback(async () => {
        if (kind !== "video") return;
        if (!currentHandoff) return message.warning("正在读取原编导交接状态，请稍后继续");
        if (handedOff && handoffCanvasId) { navigate(`/canvas/${encodeURIComponent(handoffCanvasId)}?agent=1`); return; }
        if (currentHandoff?.error) return message.error(currentHandoff.error);
        const ready = references.filter((reference) => reference.resourceId);
        if (!prompt.trim()) return message.warning("请填写视频创作需求");
        if (references.some((reference) => reference.uploading)) return message.warning("请等待编导素材上传完成");
        if (references.some((reference) => reference.error || !reference.resourceId)) return message.warning("请移除或重新上传不可用的编导素材");
        if (!ready.some((reference) => reference.kind === "image")) return message.warning("超级编导至少需要一张图片素材");
        if (ready.length > 8) return message.warning("超级编导最多使用 8 个焦点素材");
        if (!selection) return message.warning("请选择编导场景或技能，也可以主动选择通用编导");
        if (skillsLoading) return message.warning("正在确认编导技能，请稍后继续");
        if (skillsError) return message.warning(skillsError);
        if (submitAttemptRef.current) return;

        setBusy(true);
        const attempt = {};
        submitAttemptRef.current = attempt;
        const requestScope = userId;
        const requestContextId = contextId;
        const requestEpoch = workbenchSessionEpoch(userId);
        const requestRevision = workbenchRevisionRef.current;
        const isCurrentAttempt = () => submitAttemptRef.current === attempt && identityRef.current.contextId === requestContextId && identityRef.current.userId === requestScope
            && (useUserStore.getState().user?.id || "guest") === requestScope && workbenchSessionEpoch(requestScope) === requestEpoch;
        try {
            const result = await startOrResumeDirectorHandoff({
                contextId,
                prompt: prompt.trim(),
                durationSeconds: Number(seconds) || undefined,
                language,
                expectedUserScope: userId,
                skillSelection: normalizeDirectorSelection(selection),
                skillSnapshots: snapshotDirectorSkills(selection, selectedSkills),
                resources: ready.map((reference) => ({ resourceId: reference.resourceId!, kind: reference.kind, title: reference.name })),
            });
            if (!isCurrentAttempt() || requestRevision !== workbenchRevisionRef.current) return;
            if (result.syncError) message.warning(`画布已建立，部分素材同步待恢复：${result.syncError}`);
            navigate(result.path);
        } catch (error) {
            if (!isCurrentAttempt() || requestRevision !== workbenchRevisionRef.current) return;
            message.error(error instanceof Error ? error.message : "进入超级编导失败");
        } finally {
            if (isCurrentAttempt()) {
                submitAttemptRef.current = null;
                setBusy(false);
                // A canvas association can already be durable even when the later sync failed.
                // Re-read it independently of composer edits so recovery reflects the real handoff.
                retryHandoff();
            }
        }
    }, [contextId, currentHandoff, handedOff, handoffCanvasId, kind, language, message, navigate, prompt, references, seconds, selection, selectedSkills, skillsError, skillsLoading, userId, workbenchRevisionRef]);

    return { contextId, setContextId, language, setLanguage, busy, submit, selection, setSelection, chooseScene, choosePreset, selectGeneral, presets, presetsLoading: presetQuery.isPending, selectedSkills, skillsLoading, skillsError, retrySkills, skillPickerOpen, setSkillPickerOpen,
        hasHandoff: Boolean(currentHandoff?.record), handedOff, handoffCanvasId, handoffLoading: kind === "video" && !currentHandoff, handoffError: currentHandoff?.error || "", continueHandoff,
        handoffNeedsConfirmation: Boolean(currentHandoff?.record && !handedOff && !currentHandoff.record.skillSelection), retryHandoff };
}
