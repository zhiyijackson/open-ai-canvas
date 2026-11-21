import type { FilmGraph } from "@/services/api/interactive-films";
import { availableExits, emptyFilmState, takeFilmExit, type FilmState } from "./film-interactions";

export type FilmCheckpoint = { id: string; state: FilmState; time: number; choice?: boolean; decision?: string; routeKey?: string };
export type FilmRouteCase = { key: string; ending: string; label: string; timed: boolean; history: FilmCheckpoint[] };

export function filmDecisionKey(scene: string, item: string, exitIndex: number, timed: boolean) {
    return JSON.stringify([scene, item, exitIndex, timed]);
}

// Keep one reproducible arrival per scene and carried item. After the last
// decision a chain of continuous scenes can still lead to the ending.
export function filmRouteCases(graph: FilmGraph): FilmRouteCase[] {
    const nodes = new Map(graph.scenes.map((s) => [s.id, s]));
    const result: FilmRouteCase[] = [];
    const queue: FilmCheckpoint[][] = [[{ id: graph.start, state: emptyFilmState, time: 0 }]];
    const seen = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
        const history = queue[i],
            point = history[history.length - 1],
            scene = nodes.get(point.id);
        const visit = JSON.stringify([point.id, point.state.item]);
        if (!scene || seen.has(visit)) continue;
        seen.add(visit);
        const cue = scene.track?.cues.find((c) => c.kind === "choice");
        for (const exit of availableExits(scene, point.state.item)) {
            const index = scene.exits.indexOf(exit),
                state = takeFilmExit(point.state, exit);
            queue.push([...history.slice(0, -1), { ...point, time: cue?.atMs ?? scene.track?.durationMs ?? 0, choice: scene.mode === "choice", decision: exit.label }, { id: exit.target, state, time: 0 }]);
            if (scene.mode !== "choice") continue;
            let next = nodes.get(exit.target),
                carry = state;
            const tail = new Set<string>();
            while (next?.mode === "next" && !tail.has(next.id)) {
                tail.add(next.id);
                const edge = availableExits(next, carry.item)[0];
                if (!edge) break;
                carry = takeFilmExit(carry, edge);
                next = nodes.get(edge.target);
            }
            if (next?.mode !== "ending") continue;
            const modes = cue?.timeoutMs && cue.defaultExit && cue.defaultExit === exit.id ? [false, true] : [false];
            for (const timed of modes)
                result.push({ key: filmDecisionKey(scene.id, point.state.item, index, timed), ending: next.id, label: exit.label, timed, history: [...history.slice(0, -1), { ...point, time: Math.max(0, (cue?.atMs || 0) - 2000) }] });
        }
        if (scene.mode === "ending" && !history.some((p) => p.choice)) result.push({ key: JSON.stringify(["linear", scene.id]), ending: scene.id, label: "连续播放", timed: false, history: [history[0]] });
    }
    return result;
}
