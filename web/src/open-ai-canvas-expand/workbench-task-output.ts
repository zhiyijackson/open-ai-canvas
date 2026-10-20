import { EXPAND_OPENAPI_PREFIX } from "@open-ai-canvas/expand";

import { apiBaseURL } from "@/services/api/request";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import type { GenerationTask, GenerationTaskOutput } from "@/services/api/task-center";

export type ExpandGenerationTaskOutput = GenerationTaskOutput & {
    resourceId?: string;
};

/** Fields owned by expand-openapi's projection, never by the host Task model. */
export type ExpandGenerationTask = Omit<GenerationTask, "outputs"> & {
    clientOperationId?: string;
    assetRegistrationState?: string;
    assetRegistrationVersion?: number;
    materializationErrorCode?: string;
    outputCount?: number;
    outputs?: ExpandGenerationTaskOutput[];
};
import type { Asset } from "@/stores/use-asset-store";

export type WorkbenchOutputPreview = {
    id: string;
    outputIndex: number;
    kind: "image" | "video";
    url: string;
    resourceId?: string;
    assetId?: string;
    status: "processing" | "saving" | "ready" | "failed" | "unavailable";
};

function resourceFileURL(resourceId: string) {
    const base = String(apiBaseURL).replace(/\/+$/, "");
    return `${base}${EXPAND_OPENAPI_PREFIX}/resources/${encodeURIComponent(resourceId)}/file`;
}

export function safeWorkbenchDownloadURL(value: string) {
    const url = value.trim();
    if (/^data:(?:image|video|audio)\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(url)) return url;
    try {
        const parsed = new URL(url, typeof window === "undefined" ? "https://local.invalid" : window.location.origin);
        return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "blob:" ? parsed.href : null;
    } catch {
        return null;
    }
}

export function taskOutputPreviews(task: ExpandGenerationTask, registrationVerified = task.assetRegistrationVersion !== undefined || Boolean(task.outputs?.some((output) => output.materializedAssetId)), registrationError = task.materializationErrorCode || ""): WorkbenchOutputPreview[] {
    let result: { mode?: string; outputCount?: number; images?: Array<{ url?: string; dataUrl?: string; storageKey?: string }>; video?: { url?: string; dataUrl?: string; storageKey?: string } } | null = null;
    try {
        result = task.resultJson ? JSON.parse(task.resultJson) : null;
    } catch {
        result = null;
    }
    const outputBindings = new Map((task.outputs || []).map((output) => [output.outputIndex, output]));
    const addonTracked = Boolean(task.clientOperationId || task.assetRegistrationState || task.assetRegistrationVersion !== undefined || task.outputs?.length);
    const statusFor = (index: number): WorkbenchOutputPreview["status"] => {
        const output = outputBindings.get(index);
        if (output?.materializationErrorCode) return ["asset_unavailable", "asset_deleted"].includes(output.materializationErrorCode) ? "unavailable" : "failed";
        if (output?.materializedAssetId && registrationVerified) return "ready";
        if (registrationError) return registrationError === "asset_unavailable" ? "unavailable" : "failed";
        if (task.status === "failed" || task.status === "cancelled") return "failed";
        if (task.status !== "succeeded") return "processing";
        if (!addonTracked) return "ready";
        if (task.assetRegistrationState === "failed" || task.assetRegistrationState === "partial") return "failed";
        return task.resultState === "FAILED_PERMANENT" ? "unavailable" : "saving";
    };
    const videoOutput = (task.outputs || []).find((output) => output.mediaType === "video");
    if (task.previewKind === "video" || (task.type || "").includes("video") || result?.mode === "video" || result?.video || videoOutput) {
        const output = videoOutput || outputBindings.get(0);
        const outputIndex = output?.outputIndex || 0;
        const url = (output?.resourceId ? resourceFileURL(output.resourceId) : "") || result?.video?.url || result?.video?.dataUrl || task.previewUrl || "";
        return [{ id: `${task.id}:${outputIndex}`, outputIndex, kind: "video", url, ...(output?.resourceId ? { resourceId: output.resourceId } : {}), ...(output?.materializedAssetId ? { assetId: output.materializedAssetId } : {}), status: statusFor(outputIndex) }];
    }
    const images = result?.images || [];
    const boundOutputCount = (task.outputs || []).reduce((maximum, output) => Math.max(maximum, output.outputIndex + 1), 0);
    const outputCount = Math.max(task.outputCount || 0, result?.outputCount || 0, images.length, boundOutputCount, task.previewUrl ? 1 : 0);
    return Array.from({ length: outputCount }, (_, index) => {
        const output = outputBindings.get(index);
        return {
            id: `${task.id}:${index}`,
            outputIndex: index,
            kind: "image" as const,
            url: (output?.resourceId ? resourceFileURL(output.resourceId) : "") || images[index]?.url || images[index]?.dataUrl || (index === 0 ? task.previewUrl || "" : ""),
            ...(output?.resourceId ? { resourceId: output.resourceId } : {}),
            ...(output?.materializedAssetId ? { assetId: output.materializedAssetId } : {}),
            status: statusFor(index),
        };
    });
}

/** Generation and delivery are separate states, shared by preview and queue. */
export function workbenchDeliveryState(task: ExpandGenerationTask, outputs = taskOutputPreviews(task)): {
    status: "queued" | "running" | "saving" | "completed" | "failed" | "cancelled" | "unavailable";
    label: string;
} {
    if (task.status === "queued") return { status: "queued", label: "排队中" };
    if (task.status === "running") return { status: "running", label: "生成中" };
    const ready = outputs.some((output) => output.status === "ready");
    const pending = outputs.some((output) => output.status === "saving" || output.status === "processing");
    const unavailable = outputs.some((output) => output.status === "unavailable");
    const failed = outputs.some((output) => output.status === "failed") || task.assetRegistrationState === "failed" || task.assetRegistrationState === "partial";
    if (ready) return { status: "completed", label: pending ? "部分已保存" : failed || unavailable ? "部分产物不可用" : "已完成" };
    if (task.status === "cancelled") return { status: "cancelled", label: "已取消" };
    if (task.status === "failed") return { status: "failed", label: "生成失败" };
    if (pending) return { status: "saving", label: "正在保存作品" };
    if (unavailable) return { status: "unavailable", label: "产物不可用" };
    if (failed || task.materializationErrorCode) return { status: "failed", label: "保存失败" };
    return { status: "saving", label: "正在保存作品" };
}

export function taskAssetVerificationKey(task: ExpandGenerationTask) {
    return `${task.updatedAt}:${(task.outputs || []).map((output) => `${output.outputIndex}:${output.materializedAssetId || ""}:${output.materializationErrorCode || ""}`).join("|")}`;
}

export function assetReferenceData(asset: Asset) {
    if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio") return null;
    const resourceId = resourceIdFromStorageKey(asset.data.storageKey);
    if (!resourceId) return null;
    const previewUrl = resourceFileURL(resourceId);
    return { resourceId, previewUrl, kind: asset.kind, storageKey: asset.data.storageKey };
}
