import type { FilmGraph, FilmScene } from "@/services/api/interactive-films";
import { filmRoutes } from "./film-interactions";
import { filmGraphIssues } from "./interactive-film";

type EditorIssue = { scene: string; exit?: number; message: string; track?: boolean };

export function filmEditorIssues(graph: FilmGraph, resource: (s: FilmScene) => string | undefined) {
    const routes = filmRoutes(graph);
    const issues = new Map<string, EditorIssue>();
    function add(issue: EditorIssue) {
        issues.set(JSON.stringify([issue.scene, issue.exit, issue.message]), issue);
    }
    const playable = new Set<string>();
    for (const scene of graph.scenes) {
        const arrivals = routes.arrivals(scene.id);
        const media = resource(scene);
        if (media) playable.add(scene.id);
        else if (scene.media?.kind !== "event") add({ scene: scene.id, message: "缺少可播放的最新成片" });
        if (scene.track?.cues.length && scene.track.resourceId !== media) add({ scene: scene.id, message: "更换成片后需复核时间和位置", track: !!media });
        scene.exits.forEach((edge, i) => {
            if (edge.requiresItem && arrivals.length && !arrivals.some((a) => a.item === edge.requiresItem)) add({ scene: scene.id, message: `没有来路能持有「${edge.requiresItem}」`, exit: i });
        });
    }
    for (const { scene, exit, message, summary, track } of filmGraphIssues(graph)) {
        add({ scene, message: summary ?? message, ...(exit !== undefined && { exit }), ...(track && playable.has(scene) && { track }) });
    }
    return [...issues.values()];
}
