import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import type { CloudAgentPrefillRequest } from "@/components/canvas/canvas-cloud-agent-panel";
import { canvasAssetHandoffPayloads, finalizeCanvasAssetHandoff } from "@/lib/canvas/canvas-asset-handoff";
import { flushCanvasStorePersistence } from "@/stores/canvas/use-canvas-store";
import type { Asset } from "@/stores/use-asset-store";
import type { CanvasNodeData } from "@/types/canvas";
import { loadAssetsForUse } from "@/services/user-data-sync";
import { getActiveUserScope } from "@/lib/user-scope";
import { useUserStore } from "@/stores/use-user-store";
import { workbenchSessionEpoch } from "./workbench-session";
import {
    directorAgentPrompt,
    directorHandoffNodeIds,
    directorHandoffSkillIds,
    loadDirectorHandoff,
    markDirectorHandoffPrepared,
    uninsertedDirectorHandoffPayloads,
    type StoredDirectorHandoff,
} from "@/open-ai-canvas-expand/director-canvas-handoff";

type SetSearchParams = (next: URLSearchParams, options: { replace: boolean }) => void;

type UseDirectorCanvasHandoffInput = {
    projectId: string;
    projectLoaded: boolean;
    assets: Asset[];
    assetsHydrated: boolean;
    searchParams: URLSearchParams;
    setSearchParams: SetSearchParams;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    setSelectedNodeIds: (selection: Set<string>) => void;
    insertPayloads: (payloads: InsertAssetPayload[]) => Promise<CanvasNodeData[]>;
    persistNodes: (nodes: CanvasNodeData[]) => Promise<void>;
    enqueueAgentPrefill: (create: (current: CloudAgentPrefillRequest | null) => CloudAgentPrefillRequest) => void;
    openAgent: () => void;
    reportError: (message: string) => void;
};

export function useDirectorCanvasHandoff({
    projectId,
    projectLoaded,
    assets,
    assetsHydrated,
    searchParams,
    setSearchParams,
    nodesRef,
    selectedNodeIdsRef,
    setSelectedNodeIds,
    insertPayloads,
    persistNodes,
    enqueueAgentPrefill,
    openAgent,
    reportError,
}: UseDirectorCanvasHandoffInput) {
    const handoffAttemptRef = useRef("");
    const prefillContextsRef = useRef(new Map<number, string>());
    const [handoff, setHandoff] = useState<StoredDirectorHandoff | null>(null);
    const userId = useUserStore((state) => state.user?.id);
    const scopeRef = useRef("");
    scopeRef.current = `${getActiveUserScope()}:${projectId}`;

    useEffect(() => {
        handoffAttemptRef.current = "";
        prefillContextsRef.current.clear();
    }, [projectId, userId]);

    useEffect(() => {
        const contextId = searchParams.get("director")?.trim() || "";
        if (!projectLoaded || searchParams.get("mode") !== "director" || !contextId) {
            setHandoff(null);
            return;
        }
        setHandoff(null);
        let active = true;
        void loadDirectorHandoff(contextId, projectId)
            .then((record) => {
                if (active) setHandoff(record);
            })
            .catch((error) => {
                if (active) reportError(error instanceof Error ? error.message : "超级编导交接记录读取失败");
            });
        return () => {
            active = false;
        };
    }, [projectId, projectLoaded, reportError, searchParams, userId]);

    useEffect(() => {
        if (!handoff?.assetIds.length || handoff.preparedAt) return;
        void loadAssetsForUse(handoff.assetIds).catch((error) => reportError(error instanceof Error ? error.message : "超级编导素材读取失败"));
    }, [handoff, reportError]);

    useEffect(() => {
        if (!projectLoaded || !assetsHydrated || !handoff || handoff.preparedAt || searchParams.get("mode") !== "director") return;
        let skillIds: readonly string[];
        try {
            skillIds = directorHandoffSkillIds(handoff);
            if (!skillIds.length) throw new Error("视频编导需要真实技能，请返回视频工作台重新选择后继续");
        } catch (error) {
            reportError(error instanceof Error ? error.message : "编导技能尚未确认");
            return;
        }
        const scope = getActiveUserScope();
        const epoch = workbenchSessionEpoch(scope);
        const isCurrent = () => scopeRef.current === `${scope}:${projectId}` && epoch === workbenchSessionEpoch(scope);
        const { payloads: assetPayloads, missingAssetIds } = canvasAssetHandoffPayloads(assets, handoff.assetIds);
        if (missingAssetIds.length) return;
        const payloads = [...assetPayloads, ...handoff.resourcePayloads];
        if (!payloads.some((payload) => payload.kind === "image")) {
            reportError("超级编导至少需要一张参考图片");
            return;
        }
        const readiness = payloads.map((payload) => payload.assetId || ("storageKey" in payload ? payload.storageKey : "") || payload.title).join("|");
        const handoffKey = `${projectId}:${handoff.contextId}:${readiness}`;
        if (handoffAttemptRef.current === handoffKey) return;
        handoffAttemptRef.current = handoffKey;

        const pendingPayloads = uninsertedDirectorHandoffPayloads(nodesRef.current, payloads);
        const persistAndPrefill = async (createdNodes: CanvasNodeData[]) => {
            if (!isCurrent()) return;
            const finalized = await finalizeCanvasAssetHandoff({
                searchParams,
                currentNodes: nodesRef.current,
                createdNodes,
                persist: async (nextNodes) => {
                    if (!isCurrent()) throw new DOMException("编导会话已切换", "AbortError");
                    nodesRef.current = nextNodes;
                    await persistNodes(nextNodes);
                    await flushCanvasStorePersistence();
                },
            });
            if (!isCurrent()) return;
            const focusNodeIds = directorHandoffNodeIds(finalized.nodes, handoff);
            if (focusNodeIds.length !== payloads.length) throw new Error("超级编导参考素材未完整写入画布，请重试");
            const selection = new Set(focusNodeIds);
            selectedNodeIdsRef.current = selection;
            setSelectedNodeIds(selection);
            const text = directorAgentPrompt(handoff);
            enqueueAgentPrefill((current) => {
                const id = (current?.id ?? 0) + 1;
                prefillContextsRef.current.set(id, handoff.contextId);
                return { id, text, displayText: text, autoSubmit: true, skillIds };
            });
            openAgent();
        };
        const insertion = pendingPayloads.length ? insertPayloads(pendingPayloads) : Promise.resolve([] as CanvasNodeData[]);
        void insertion.then(persistAndPrefill).catch((error) => {
            if (!isCurrent()) return;
            handoffAttemptRef.current = "";
            reportError(error instanceof Error ? error.message : "超级编导素材交接失败");
        });
    }, [assets, assetsHydrated, enqueueAgentPrefill, handoff, insertPayloads, nodesRef, openAgent, persistNodes, projectId, projectLoaded, reportError, searchParams, selectedNodeIdsRef, setSelectedNodeIds]);

    return useCallback(
        async (prefillId: number) => {
            const contextId = prefillContextsRef.current.get(prefillId);
            if (!contextId) return;
            const record = await markDirectorHandoffPrepared(contextId, projectId);
            setHandoff(record);
            prefillContextsRef.current.delete(prefillId);
            if (searchParams.get("director") !== contextId) return;
            const next = new URLSearchParams(searchParams);
            next.delete("mode");
            next.delete("director");
            setSearchParams(next, { replace: true });
        },
        [projectId, searchParams, setSearchParams],
    );
}
