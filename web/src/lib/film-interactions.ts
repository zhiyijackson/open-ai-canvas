import type { FilmCue, FilmExit, FilmGraph, FilmScene, FilmTrack } from "@/services/api/interactive-films";

export type FilmState = { item: string; clues: string[] };
export const emptyFilmState: FilmState = { item: "", clues: [] };
export const MAX_FILM_CUES = 64;
export type FilmArrival = { from: string; item: string; parent: number };

export function videoHasChoiceOverlay(scene: FilmScene) {
    return scene.mode === "choice";
}

export function availableExits(scene: FilmScene, item: string) {
    return scene.exits.filter((exit) => !exit.requiresItem || exit.requiresItem === item);
}

// An edge back to the source or any of its ancestors would close a cycle.
export function filmConnectionTargets(graph: FilmGraph, source: string) {
    const parents = new Map<string, string[]>();
    for (const scene of graph.scenes)
        for (const exit of scene.exits) {
            const group = parents.get(exit.target) || [];
            group.push(scene.id);
            parents.set(exit.target, group);
        }
    const blocked = new Set<string>();
    const pending = [source];
    while (pending.length) {
        const id = pending.pop()!;
        if (blocked.has(id)) continue;
        blocked.add(id);
        pending.push(...(parents.get(id) || []));
    }
    return graph.scenes.filter((scene) => !blocked.has(scene.id));
}

export function filmSceneLabels(graph: FilmGraph) {
    const counts = new Map<string, number>();
    for (const { title } of graph.scenes) counts.set(title, (counts.get(title) ?? 0) + 1);
    return new Map(graph.scenes.map(({ id, title }, index) => [id, counts.get(title)! > 1 ? `第 ${index + 1} 场 · ${title || "未命名"}` : title || id]));
}

// A scene can be reached by many paths that carry the same item. Expand each
// (scene, item) once, retaining the immediate origin for the director's picker.
export function filmRoutes(graph: FilmGraph) {
    const nodes = new Map(graph.scenes.map((scene) => [scene.id, scene]));
    const labels = filmSceneLabels(graph);
    const arrivals = new Map<string, Map<string, FilmArrival>>();
    const seen = new Map<string, Set<string>>();
    const pending = [{ id: graph.start, item: "", parent: -1 }];
    for (let i = 0; i < pending.length; i++) {
        const { id, item } = pending[i],
            scene = nodes.get(id);
        if (!scene || seen.get(id)?.has(item)) continue;
        if (!seen.has(id)) seen.set(id, new Set());
        seen.get(id)!.add(item);
        for (const exit of availableExits(scene, item)) {
            const nextItem = exit.item || item;
            if (!nodes.has(exit.target)) continue;
            const group = arrivals.get(exit.target) || new Map();
            const key = JSON.stringify([id, item, nextItem]);
            if (!group.has(key)) group.set(key, { from: id, item: nextItem, parent: i });
            arrivals.set(exit.target, group);
            pending.push({ id: exit.target, item: nextItem, parent: i });
        }
    }
    // Resolve only the selected path. Successive merges can represent exponentially many histories.
    function trace(parent: number, choices: Record<string, number> = {}) {
        const path: { id: string; state: FilmState; time: number }[] = [];
        const branches: { key: string; scene: string; options: FilmArrival[]; parent: number }[] = [];
        const visited = new Set<string>();
        for (let i = parent; i >= 0;) {
            const { id, item } = pending[i];
            const key = JSON.stringify([id, item]);
            if (visited.has(key)) break;
            visited.add(key);
            const track = nodes.get(id)?.track;
            path.push({ id, state: { item, clues: [] }, time: track?.cues.find((c) => c.kind === "choice")?.atMs ?? track?.durationMs ?? 0 });
            if (pending[i].parent < 0) break;
            const options = Array.from(arrivals.get(id)?.values() || []).filter((a) => a.item === item && !visited.has(JSON.stringify([a.from, pending[a.parent].item])));
            i = options.find((a) => a.parent === choices[key])?.parent ?? pending[i].parent;
            if (options.length > 1) branches.push({ key, scene: id, options, parent: i });
        }
        return { path: path.reverse(), branches: branches.reverse() };
    }
    return {
        arrivals(id: string) {
            return nodes.has(id) && id === graph.start ? [{ from: "", item: "", parent: -1 }] : Array.from(arrivals.get(id)?.values() || []);
        },
        history(parent: number) {
            return trace(parent).path;
        },
        trace,
        labels,
        arrivalLabel(a: FilmArrival) {
            const before = pending[a.parent]?.item;
            return `${labels.get(a.from) || "入口"} · ${before !== undefined && before !== a.item ? `${before || "空手"} → ` : ""}${a.item || "空手"}`;
        },
    };
}

export function filmArrivals(graph: FilmGraph, target: string) {
    if (target === graph.start) return [];
    return filmRoutes(graph)
        .arrivals(target)
        .map(({ from, item }) => ({ from, item }));
}

export function takeFilmExit(state: FilmState, exit: FilmExit): FilmState {
    return { ...state, item: exit.item || state.item };
}

export function inspectFilmCue(state: FilmState, cue: FilmCue): FilmState {
    return state.clues.includes(cue.id) ? state : { ...state, clues: [...state.clues, cue.id] };
}

export function filmTrackIssue(scene: FilmScene, track = scene.track, durationMs = track?.durationMs) {
    if (!track?.cues?.length) return "";
    if (track.cues.length > MAX_FILM_CUES) return `每场最多 ${MAX_FILM_CUES} 个互动点`;
    if (!track.resourceId || !durationMs || durationMs <= 0) return "请确认成片版本和时长";
    let lastEnd = -1;
    const ids = new Set<string>();
    for (const [index, cue] of track.cues.entries()) {
        if (!cue.id || ids.has(cue.id)) return "互动点编号为空或重复";
        ids.add(cue.id);
        if (!Number.isInteger(cue.atMs) || cue.atMs < 0 || cue.atMs >= durationMs) return "互动点超出成片时长";
        if (cue.atMs < lastEnd) return "互动窗口重叠";
        if (cue.kind === "caption") {
            if (!cue.label?.trim() || cue.label.length > 500 || !Number.isInteger(cue.endMs) || cue.endMs! <= cue.atMs || cue.endMs! > durationMs) return "请检查画内对白和收起时刻";
            lastEnd = cue.endMs!;
        } else if (cue.kind === "hotspot") {
            if (!cue.label?.trim() || !Number.isInteger(cue.endMs) || cue.endMs! <= cue.atMs || cue.endMs! > durationMs) return "请检查热点名称和结束时间";
            if ([cue.x ?? 0, cue.y ?? 0].some((value) => !Number.isFinite(value) || value < 0 || value > 100)) return "热点位置超出画面";
            lastEnd = cue.endMs!;
        } else if (cue.kind !== "choice" || scene.mode !== "choice" || index !== track.cues.length - 1) return "分支点需要绑定本场选择，并位于最后";
        if ((cue.timeoutMs ?? 0) < 0 || (cue.timeoutMs ?? 0) > 3600000) return "倒计时需在一小时以内";
    }
    return "";
}

type ExitEditIssue = {
    reason: "track" | "detached-default" | "invalid-default" | "requires-item";
    message: string;
    blocksApply: boolean;
    exit?: number;
};

function defaultExitIssue(scene: FilmScene, arrivals: Iterable<{ item: string }>, hasTarget: (id: string) => boolean): ExitEditIssue | undefined {
    const timed = scene.track?.cues.find((cue) => cue.kind === "choice" && cue.timeoutMs);
    if (!timed) return;
    const index = scene.exits.findIndex((edge) => edge.id && edge.id === timed.defaultExit);
    const exit = scene.exits[index];
    if (!exit?.target || !hasTarget(exit.target)) {
        const detached = !!exit && !exit.target;
        return { reason: detached ? "detached-default" : "invalid-default", message: "超时默认出口不可用，请选择已连接的出口", blocksApply: !detached, exit: scene.exits.length ? Math.max(index, 0) : undefined };
    }
    for (const { item } of arrivals) {
        if (exit.requiresItem && exit.requiresItem !== item) return { reason: "requires-item", message: `超时默认出口「${exit.label}」需要持有「${exit.requiresItem}」，${item ? `携带「${item}」` : "空手"}的观众无法选择`, blocksApply: true, exit: index };
    }
}

export function filmExitEditIssue(scene: FilmScene, arrivals: Iterable<{ item: string }>, hasTarget: (id: string) => boolean): ExitEditIssue | undefined {
    const timing = filmTrackIssue(scene);
    if (timing) return { reason: "track", message: timing, blocksApply: true };
    return defaultExitIssue(scene, arrivals, hasTarget);
}

export function filmRulesIssue(graph: FilmGraph) {
    return filmRuleIssues(graph).next().value?.message ?? "";
}

export type FilmValidationIssue = { scene: string; message: string; summary?: string; exit?: number; track?: boolean };

export function* filmRuleIssues(graph: FilmGraph): Generator<FilmValidationIssue, void> {
    const clues = new Map<string, { source: string; label: string }>();
    const nodes = new Map(graph.scenes.map((scene) => [scene.id, scene]));
    function timeoutIssue(scene: FilmScene, arrivals: Iterable<{ item: string }>): FilmValidationIssue | undefined {
        const issue = defaultExitIssue(scene, arrivals, (target) => nodes.has(target));
        if (issue) return { scene: scene.id, message: scene.title + " · " + issue.message, summary: issue.message, exit: issue.exit };
    }
    for (const scene of graph.scenes) {
        const timing = filmTrackIssue(scene);
        if (timing) yield { scene: scene.id, message: scene.title + " · " + timing, summary: timing, track: true };
        const exits = scene.exits.flatMap((exit) => (exit.id ? [exit.id] : []));
        if (new Set(exits).size !== exits.length) yield { scene: scene.id, message: scene.title + " 的出口编号重复" };
        for (const cue of scene.track?.cues ?? []) {
            if (cue.kind !== "hotspot") continue;
            if (clues.has(cue.id)) yield { scene: scene.id, message: scene.title + " 的线索编号重复" };
            clues.set(cue.id, { source: scene.id, label: cue.collectionName || cue.label || cue.id });
        }
    }
    // Hotspots in the same scene share reachability. Track only sources used by responses.
    const sourceBits = new Map<string, bigint>();
    for (const scene of graph.scenes) {
        if (!scene.clue) continue;
        const clue = clues.get(scene.clue);
        if (!clue) yield { scene: scene.id, message: scene.title + " 引用了已移除的线索" };
        else if (!sourceBits.has(clue.source)) sourceBits.set(clue.source, BigInt(1) << BigInt(sourceBits.size));
    }
    // An exit tests only the carried item. Paths with that same item may therefore
    // share all individually obtainable clues, including ones arriving via a later merge.
    const empty = BigInt(0);
    type Arrival = { scene: FilmScene; item: string; sources: bigint; exits?: FilmExit[] };
    const arrivals = new Map<string, Map<string, Arrival>>();
    const pending = new Set<Arrival>();
    function arrive(id: string, item: string, sources: bigint) {
        const scene = nodes.get(id);
        if (!scene) return;
        let states = arrivals.get(id);
        if (!states) {
            states = new Map();
            arrivals.set(id, states);
        }
        const known = states.get(item);
        if (!known) {
            const arrival = { scene, item, sources: sources | (sourceBits.get(id) ?? empty) };
            states.set(item, arrival);
            pending.add(arrival);
        } else if ((known.sources | sources) !== known.sources) {
            known.sources |= sources;
            pending.add(known);
        }
    }
    arrive(graph.start, "", empty);
    for (const arrival of pending) {
        pending.delete(arrival);
        const { scene, item, sources } = arrival;
        if (!arrival.exits) {
            arrival.exits = availableExits(scene, item);
            if (scene.mode !== "ending" && !arrival.exits.length) yield { scene: scene.id, message: scene.title + " 在" + (item || "空手") + "状态下没有可用出口" };
            const issue = timeoutIssue(scene, [{ item }]);
            if (issue) yield issue;
        }
        for (const exit of arrival.exits) arrive(exit.target, exit.item || item, sources);
    }
    for (const scene of graph.scenes) {
        const states = arrivals.get(scene.id);
        if (states) {
            const clue = scene.clue && clues.get(scene.clue);
            if (clue) {
                const bit = sourceBits.get(clue.source)!;
                if (!Array.from(states.values()).some(({ sources }) => (sources & bit) !== empty)) yield { scene: scene.id, message: `${scene.title} 的观众无法在回应前取得线索「${clue.label}」` };
            }
            continue;
        }
        yield { scene: scene.id, message: scene.title + " 的携带条件使本场无法到达", summary: "从入口无法到达" };
        const issue = timeoutIssue(scene, []);
        if (issue) yield issue;
    }
}

export function orderedTrack(resourceId: string, durationMs: number, cues: FilmCue[]): FilmTrack {
    return { resourceId, durationMs, cues: [...cues].sort((left, right) => left.atMs - right.atMs) };
}
