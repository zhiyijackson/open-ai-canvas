import { useCallback, useMemo, useState } from "react";
import "@open-ai-canvas/expand/styles.css";

import { WorkbenchPage } from "@/pages/workbench/image-workbench-page";
import type { WorkbenchKind } from "@/services/api/workbench";
import { useUserStore } from "@/stores/use-user-store";

import { createExpandWorkbenchRuntime } from "./generation-api";
import { GenerationWorkbenchBoundary } from "./generation-workbench-boundary";
import { GenerationWorkbenchSurface } from "./generation-workbench-surface";
import "./session-cleanup";
import type { WorkbenchSurfaceRenderer } from "./workbench-contract";
import { expandWorkbenchEnabled } from "./workbench-support";

export function ExpandWorkbenchRoute({ kind }: { kind: WorkbenchKind }) {
    const scope = useUserStore((state) => state.user?.id || "guest");
    const [surfaceFailed, setSurfaceFailed] = useState(false);
    const runtime = useMemo(() => createExpandWorkbenchRuntime(kind, scope), [kind, scope]);
    const renderSurface = useCallback<WorkbenchSurfaceRenderer>(
        (controller) => (
            <GenerationWorkbenchBoundary onError={() => setSurfaceFailed(true)}>
                <GenerationWorkbenchSurface controller={controller} />
            </GenerationWorkbenchBoundary>
        ),
        [],
    );
    const enabled = expandWorkbenchEnabled(import.meta.env.VITE_OPEN_AI_CANVAS_EXPAND_ENABLED);
    return <WorkbenchPage key={`${scope}:${kind}`} kind={kind} runtime={enabled ? runtime : undefined} renderSurface={enabled && !surfaceFailed ? renderSurface : undefined} />;
}
