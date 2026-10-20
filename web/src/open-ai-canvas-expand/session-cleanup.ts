import { clearDirectorHandoffSession } from "@/open-ai-canvas-expand/director-canvas-handoff";
import { clearWorkbenchDraftsForScope } from "@/open-ai-canvas-expand/workbench-session";
import { useUserStore } from "@/stores/use-user-store";

/** Invalidates synchronous extension state before awaiting persisted cleanup. */
export function clearOpenAiCanvasExpandSession(scope: string) {
    clearWorkbenchDraftsForScope(scope);
    return clearDirectorHandoffSession(scope);
}

let observedScope = useUserStore.getState().user?.id || "guest";
useUserStore.subscribe((state) => {
    const nextScope = state.user?.id || "guest";
    if (nextScope === observedScope) return;
    const previousScope = observedScope;
    observedScope = nextScope;
    void clearOpenAiCanvasExpandSession(previousScope);
});
