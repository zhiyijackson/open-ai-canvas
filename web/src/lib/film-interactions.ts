import type { FilmCue, FilmExit, FilmGraph, FilmScene, FilmTrack } from "@/services/api/interactive-films";

export type FilmState = { item: string; clues: string[] };
export const emptyFilmState: FilmState = { item: "", clues: [] };

export function availableExits(scene: FilmScene, item: string) {
    return scene.exits.filter((exit) => !exit.requiresItem || exit.requiresItem === item);
}

// A scene can be reached by many paths that carry the same item. Expand each
// (scene, item) once, retaining the immediate origin for the director's picker.
export function filmArrivals(graph: FilmGraph, target: string) {
    const nodes = new Map(graph.scenes.map((scene) => [scene.id, scene]));
    const arrivals: { from: string; item: string }[] = [];
    const seen = new Map<string, Set<string>>();
    const pending = [{ id: graph.start, item: "" }];
    for (let i = 0; i < pending.length; i++) {
        const { id, item } = pending[i],
            scene = nodes.get(id);
        if (!scene || seen.get(id)?.has(item)) continue;
        if (!seen.has(id)) seen.set(id, new Set());
        seen.get(id)!.add(item);
        for (const exit of availableExits(scene, item)) {
            const nextItem = exit.item || item;
            if (exit.target === target && !arrivals.some((entry) => entry.from === id && entry.item === nextItem)) arrivals.push({ from: id, item: nextItem });
            pending.push({ id: exit.target, item: nextItem });
        }
    }
    return arrivals;
}

export function takeFilmExit(state: FilmState, exit: FilmExit): FilmState {
    return { ...state, item: exit.item || state.item };
}

export function inspectFilmCue(state: FilmState, cue: FilmCue): FilmState {
    return state.clues.includes(cue.id) ? state : { ...state, clues: [...state.clues, cue.id] };
}

export function filmTrackIssue(scene: FilmScene, track = scene.track, durationMs = track?.durationMs) {
    if (!track?.cues?.length) return "";
    if (!track.resourceId || !durationMs || durationMs <= 0) return "请确认成片版本和时长";
    let lastEnd = -1;
    const ids = new Set<string>();
    for (const [index, cue] of track.cues.entries()) {
        if (!cue.id || ids.has(cue.id)) return "互动点编号为空或重复";
        ids.add(cue.id);
        if (!Number.isInteger(cue.atMs) || cue.atMs < 0 || cue.atMs >= durationMs) return "互动点超出成片时长";
        if (cue.atMs < lastEnd) return "互动窗口重叠";
        if (cue.kind === "hotspot") {
            if (!cue.label?.trim() || !Number.isInteger(cue.endMs) || cue.endMs! <= cue.atMs || cue.endMs! > durationMs) return "请检查热点名称和结束时间";
            if ([cue.x ?? 0, cue.y ?? 0].some((value) => !Number.isFinite(value) || value < 0 || value > 100)) return "热点位置超出画面";
            lastEnd = cue.endMs!;
        } else if (cue.kind !== "choice" || scene.mode !== "choice" || index !== track.cues.length - 1) return "分支点需要绑定本场选择，并位于最后";
        if ((cue.timeoutMs ?? 0) < 0 || (cue.timeoutMs ?? 0) > 3600000) return "倒计时需在一小时以内";
    }
    return "";
}

export function filmRulesIssue(graph: FilmGraph) {
    const clues = new Set<string>();
    const nodes = new Map(graph.scenes.map((scene) => [scene.id, scene]));
    for (const scene of graph.scenes) {
        const timing = filmTrackIssue(scene);
        if (timing) return scene.title + " · " + timing;
        const exits = scene.exits.flatMap((exit) => (exit.id ? [exit.id] : []));
        if (new Set(exits).size !== exits.length) return scene.title + " 的出口编号重复";
        for (const cue of scene.track?.cues ?? []) {
            if (cue.kind !== "hotspot") continue;
            if (clues.has(cue.id)) return scene.title + " 的线索编号重复";
            clues.add(cue.id);
        }
    }
    const seen = new Map<string, Set<string>>();
    const pending = [{ id: graph.start, item: "" }];
    while (pending.length) {
        const { id, item } = pending.pop()!;
        const scene = nodes.get(id);
        if (!scene || seen.get(id)?.has(item)) continue;
        if (!seen.has(id)) seen.set(id, new Set());
        seen.get(id)!.add(item);
        if (scene.clue && !clues.has(scene.clue)) return scene.title + " 引用了已移除的线索";
        const exits = availableExits(scene, item);
        if (scene.mode !== "ending" && !exits.length) return scene.title + " 在" + (item || "空手") + "状态下没有可用出口";
        const timed = scene.track?.cues?.find((cue) => cue.kind === "choice" && cue.timeoutMs);
        if (timed && !exits.some((exit) => exit.id && exit.id === timed.defaultExit)) return scene.title + " 的超时默认出口不可用";
        for (const exit of exits) pending.push({ id: exit.target, item: exit.item || item });
    }
    const unreachable = graph.scenes.find((scene) => !seen.has(scene.id));
    return unreachable ? unreachable.title + " 的携带条件使本场无法到达" : "";
}

export function orderedTrack(resourceId: string, durationMs: number, cues: FilmCue[]): FilmTrack {
    return { resourceId, durationMs, cues: [...cues].sort((left, right) => left.atMs - right.atMs) };
}
