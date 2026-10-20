import { useEffect, useState } from "react";

import { formatBytes, formatDuration } from "@/lib/image-utils";
import type { RemoteResource } from "@/services/api/resources";

import { getExpandResource } from "./generation-api";

/** Read actual media facts from the existing resource API, never infer from requested settings. */
export function useWorkbenchOutputMetadata(resourceId: string | undefined, scope: string) {
    const [loaded, setLoaded] = useState<{ scope: string; resource: RemoteResource } | null>(null);
    useEffect(() => {
        if (!resourceId) return;
        const controller = new AbortController();
        void getExpandResource(resourceId, controller.signal).then((resource) => {
            if (!controller.signal.aborted) setLoaded({ scope, resource });
        }).catch(() => {
            // Unknown facts are omitted; a failed metadata read must not invent dimensions or format.
            if (!controller.signal.aborted) setLoaded(null);
        });
        return () => controller.abort();
    }, [resourceId, scope]);

    const resource = loaded?.scope === scope && loaded.resource.id === resourceId ? loaded.resource : null;
    if (!resource) return [];
    const metadata: Array<{ label: string; value: string }> = [];
    if (resource.width && resource.height) metadata.push({ label: "实际尺寸", value: `${resource.width} × ${resource.height}` });
    if (resource.mimeType) metadata.push({ label: "文件类型", value: resource.mimeType });
    if (resource.size > 0) metadata.push({ label: "文件大小", value: formatBytes(resource.size) });
    if (resource.durationMs && resource.durationMs > 0) metadata.push({ label: "实际时长", value: formatDuration(resource.durationMs) });
    return metadata;
}
