import { normalizeImageValue, normalizeVideoValue, type ImageCapabilityConfig, type VideoCapabilityConfig } from "@/lib/model-capabilities";

export function expandWorkbenchEnabled(configuredValue?: string) {
    return configuredValue !== "false";
}

export type ExpandWorkbenchReference = {
    id: string;
    name: string;
    kind: "image" | "video" | "audio";
    resourceId?: string;
    previewUrl: string;
    progress: number;
    uploading: boolean;
    error?: string;
    role: "reference" | "first_frame" | "last_frame";
    slotKey?: string;
};

export function assignWorkbenchReferenceRole(references: ExpandWorkbenchReference[], referenceId: string, role: ExpandWorkbenchReference["role"]) {
    return references.map((reference) => {
        if (reference.id === referenceId) return { ...reference, role };
        if ((role === "first_frame" || role === "last_frame") && reference.role === role) return { ...reference, role: "reference" as const };
        return reference;
    });
}

export function workbenchFrameRoleConflict(references: ExpandWorkbenchReference[]) {
    const firstFrames = references.filter((reference) => reference.kind === "image" && reference.role === "first_frame").length;
    const lastFrames = references.filter((reference) => reference.kind === "image" && reference.role === "last_frame").length;
    return firstFrames > 1 ? "首帧最多只能选择一张图片" : lastFrames > 1 ? "尾帧最多只能选择一张图片" : undefined;
}

export function parseImageParameters(value?: string) {
    if (!value?.trim()) return undefined;
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

function canonicalJSON(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJSON(nested)}`).join(",")}}`;
    return JSON.stringify(value);
}

export function serializedWorkbenchImageParameters(parameters: Record<string, unknown>) {
    if (typeof parameters.imageParameters === "string") return parameters.imageParameters;
    return parameters.imageParameters && typeof parameters.imageParameters === "object" ? JSON.stringify(parameters.imageParameters) : "";
}

export function historicalImageParameterIssue(profile: ImageCapabilityConfig, parameters: Record<string, unknown>) {
    const imageParameters = serializedWorkbenchImageParameters(parameters) || undefined;
    const requested = {
        size: typeof parameters.size === "string" ? parameters.size : undefined,
        quality: typeof parameters.quality === "string" ? parameters.quality : undefined,
        imageResolution: typeof parameters.imageResolution === "string" ? parameters.imageResolution : undefined,
        count: parameters.count != null ? String(parameters.count) : undefined,
        transparentBackground:
            typeof parameters.transparentBackground === "boolean" || typeof parameters.transparentBackground === "string" ? String(parameters.transparentBackground) : undefined,
        imageParameters,
    };
    const normalized = normalizeImageValue(profile, requested);
    const labels = { size: "画面比例", quality: "图片质量", imageResolution: "图片分辨率", count: "生成张数", transparentBackground: "透明背景" } as const;
    const normalizedScalars = { ...normalized, imageResolution: normalized.imageResolution || "auto" };
    const incompatibleKey = (Object.keys(labels) as Array<keyof typeof labels>).find((key) => requested[key] !== undefined && requested[key] !== normalizedScalars[key]);
    if (incompatibleKey) return `${labels[incompatibleKey]}与当前模型不兼容，请重新选择参数`;
    if (imageParameters && canonicalJSON(parseImageParameters(imageParameters)) !== canonicalJSON(parseImageParameters(normalized.imageParameters))) return "图片自定义参数与当前模型不兼容，请重新选择参数";
    return undefined;
}

export function historicalVideoParameterIssue(profile: VideoCapabilityConfig, parameters: Record<string, unknown>) {
    const requested = {
        seconds: parameters.seconds != null ? String(parameters.seconds) : undefined,
        ratio: typeof parameters.ratio === "string" ? parameters.ratio : undefined,
        resolution: typeof parameters.resolution === "string" ? parameters.resolution : undefined,
    };
    const normalized = normalizeVideoValue(profile, requested);
    if (requested.seconds !== undefined && requested.seconds !== normalized.seconds) return "视频时长与当前模型不兼容，请重新选择参数";
    if (requested.ratio !== undefined && requested.ratio !== normalized.ratio) return "视频比例与当前模型不兼容，请重新选择参数";
    if (requested.resolution !== undefined && requested.resolution.replace(/p$/i, "") !== normalized.resolution.replace(/p$/i, "")) return "视频清晰度与当前模型不兼容，请重新选择参数";
    return undefined;
}
