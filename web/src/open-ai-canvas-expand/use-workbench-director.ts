import { App } from "antd";
import { useCallback, useEffect, useState, type MutableRefObject } from "react";
import { useNavigate } from "react-router";

import type { WorkbenchKind } from "@/services/api/workbench";
import { useUserStore } from "@/stores/use-user-store";
import { startOrResumeDirectorHandoff } from "./director-canvas-handoff";
import type { ExpandWorkbenchReference } from "./workbench-support";

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
    const [language, setLanguage] = useState(() => (typeof navigator === "undefined" ? "zh-CN" : navigator.language || "zh-CN"));
    const [busy, setBusy] = useState(false);

    useEffect(() => setBusy(false), [contextId, userId]);

    const submit = useCallback(async () => {
        if (kind !== "video") return;
        const ready = references.filter((reference) => reference.resourceId);
        if (!prompt.trim()) return message.warning("请填写视频创作需求");
        if (references.some((reference) => reference.uploading)) return message.warning("请等待编导素材上传完成");
        if (references.some((reference) => reference.error || !reference.resourceId)) return message.warning("请移除或重新上传不可用的编导素材");
        if (!ready.some((reference) => reference.kind === "image")) return message.warning("超级编导至少需要一张图片素材");
        if (ready.length > 8) return message.warning("超级编导最多使用 8 个焦点素材");

        setBusy(true);
        const requestScope = userId;
        const requestRevision = workbenchRevisionRef.current;
        try {
            const result = await startOrResumeDirectorHandoff({
                contextId,
                prompt: prompt.trim(),
                durationSeconds: Number(seconds) || undefined,
                language,
                expectedUserScope: userId,
                resources: ready.map((reference) => ({ resourceId: reference.resourceId!, kind: reference.kind, title: reference.name })),
            });
            if ((useUserStore.getState().user?.id || "guest") !== requestScope || requestRevision !== workbenchRevisionRef.current) return;
            if (result.syncError) message.warning(`画布已建立，部分素材同步待恢复：${result.syncError}`);
            navigate(result.path);
        } catch (error) {
            if ((useUserStore.getState().user?.id || "guest") !== requestScope || requestRevision !== workbenchRevisionRef.current) return;
            message.error(error instanceof Error ? error.message : "进入超级编导失败");
        } finally {
            if ((useUserStore.getState().user?.id || "guest") === requestScope && requestRevision === workbenchRevisionRef.current) setBusy(false);
        }
    }, [contextId, kind, language, message, navigate, prompt, references, seconds, userId, workbenchRevisionRef]);

    return { contextId, setContextId, language, setLanguage, busy, submit };
}
