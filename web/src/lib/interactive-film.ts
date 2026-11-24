import type { FilmGraph, FilmScene, InteractiveFilm } from "@/services/api/interactive-films";
import type { DramaEpisodeRow } from "@/services/api/drama";
import { filmRulesIssue, filmRuleIssues, type FilmValidationIssue } from "./film-interactions";

const MAX_NOVEL_CHARACTERS = 6_000_000;

export function newFilmMediaNode(id: string, kind: "event" | "clip"): FilmScene {
    return { id, title: kind === "event" ? "互动事件" : "视频片段", source: "", script: kind === "event" ? "点击继续" : "下一段剧情", media: { kind }, mode: "ending", exits: [] };
}

export function insertFilmNode(graph: FilmGraph, sourceId: string, exitIndex: number, id: string, kind: "event" | "clip"): FilmGraph {
    const source = graph.scenes.find((scene) => scene.id === sourceId);
    if (!source || graph.scenes.length >= 300 || graph.scenes.some((scene) => scene.id === id)) return graph;
    const append = source.mode === "ending" && exitIndex === -1;
    const edge = source.exits[exitIndex];
    if (!append && !edge) return graph;
    const scene = newFilmMediaNode(id, kind);
    if (edge?.target) {
        scene.mode = "next";
        scene.exits = [{ label: "继续", target: edge.target }];
    }
    const upstream: FilmScene = append ? { ...source, mode: "next", exits: [{ label: "继续", target: id }] } : { ...source, exits: source.exits.map((exit, index) => (index === exitIndex ? { ...exit, target: id } : exit)) };
    return { ...graph, scenes: [...graph.scenes.map((s) => (s.id === sourceId ? upstream : s)), scene] };
}

export function filmNovelFits(novel: string) {
    if (novel.length <= MAX_NOVEL_CHARACTERS) return true;
    // Go counts Unicode code points. Count surrogate pairs once without allocating an array for the whole novel.
    let characters = 0;
    for (let i = 0; i < novel.length; i++) {
        if (++characters > MAX_NOVEL_CHARACTERS) return false;
        if (novel.codePointAt(i)! > 0xffff) i++;
    }
    return true;
}

export function canOpenFilmWorkbench(graph: FilmGraph, manual?: boolean) {
    if (!manual) return !filmGraphIssue(graph, true);
    const ids = new Set(graph.scenes.map((scene) => scene.id));
    return ids.has(graph.start) && ids.size === graph.scenes.length;
}

export function filmGraphIssue(graph: FilmGraph, topologyOnly = false): string {
    return filmGraphIssues(graph, topologyOnly).next().value?.message ?? "";
}

export function* filmGraphIssues(graph: FilmGraph, topologyOnly = false): Generator<FilmValidationIssue, void> {
    const nodes = new Map<string, FilmScene>();
    for (const scene of graph.scenes) {
        if (nodes.has(scene.id)) yield { scene: scene.id, message: "场次编号重复" };
        nodes.set(scene.id, scene);
    }
    if (!nodes.has(graph.start)) yield { scene: graph.scenes[0]?.id ?? graph.start, message: "请选择有效的入口场次" };
    for (const scene of graph.scenes) {
        const title = scene.title || scene.id;
        const issue = (message: string) => ({ scene: scene.id, message: title + " " + message });
        if (!topologyOnly && scene.media?.kind === "clip" && !scene.media.resourceId) yield { ...issue("需要绑定视频片段"), summary: "缺少可播放的最新成片" };
        if (!scene.title.trim() || !scene.script.trim()) yield issue("缺少标题或剧本");
        if (scene.mode === "ending" && scene.exits.length) yield issue("是结局，不能有出口");
        if (scene.mode === "next" && scene.exits.length !== 1) yield issue("需要一个续播目标");
        if (scene.mode === "choice" && scene.exits.length < 2) yield issue("至少需要两个选择");
        for (const [index, exit] of scene.exits.entries()) {
            if (!nodes.has(exit.target)) yield { ...issue("的出口缺少有效目标"), exit: index, summary: "待连接目标" };
            if (scene.mode === "choice" && !exit.label.trim()) yield { ...issue("的选项缺少文字"), exit: index, summary: "缺少选项文案" };
        }
    }
    const seen = new Set<string>(),
        active = new Set<string>();
    function* walk(id: string): Generator<FilmValidationIssue, void> {
        const scene = nodes.get(id);
        if (!scene) return;
        if (active.has(id)) yield { scene: id, message: "剧情回环经过 " + scene.title };
        if (seen.has(id)) return;
        seen.add(id);
        active.add(id);
        for (const { target } of scene.exits) yield* walk(target);
        active.delete(id);
    }
    yield* walk(graph.start);
    for (const scene of graph.scenes) {
        if (!seen.has(scene.id)) yield { scene: scene.id, message: "从入口无法到达 " + scene.title, summary: "从入口无法到达" };
    }
    if (!topologyOnly) yield* filmRuleIssues(graph);
}

export function filmExportMedia(film: InteractiveFilm, episodes: DramaEpisodeRow[]) {
    const sceneResources: Record<string, string> = Object.create(null);
    const issue = filmGraphIssue(film.graph);
    if (issue) return { issue, sceneResources };
    const byEpisode = new Map(episodes.map((episode) => [episode.id, episode]));
    for (const scene of film.graph.scenes) {
        const take = film.takes[scene.id];
        const episode = take && byEpisode.get(take.episodeId);
        const id = scene.media ? scene.media.resourceId : episode && !episode.finalStale && take.script === scene.script ? episode.finalResourceId : undefined;
        if (!id && scene.media?.kind !== "event") return { issue: `「${scene.title}」缺少可播放的最新成片`, sceneResources };
        if (scene.track?.cues.length && scene.track.resourceId !== id) return { issue: `「${scene.title}」请先复核成片互动轨`, sceneResources };
        if (id) sceneResources[scene.id] = id;
    }
    return { issue: "", sceneResources };
}

export function filmTrialIssue(graph: FilmGraph) {
    return filmGraphIssue(graph, true) || filmRulesIssue(graph);
}

export function filmSceneResource(scene: FilmScene, takes: InteractiveFilm["takes"], episodes: DramaEpisodeRow[]) {
    if (scene.media) return scene.media.resourceId;
    const take = takes[scene.id];
    const episode = episodes.find((row) => row.id === take?.episodeId);
    return episode && !episode.finalStale && take?.script === scene.script ? episode.finalResourceId : undefined;
}

export function filmEventBackdrop(graph: FilmGraph, scene: FilmScene, priorIds: string[]) {
    if (scene.media?.kind !== "event" || scene.media.resourceId) return;
    if (!priorIds.length) {
        const parents = graph.scenes.filter((s) => s.exits.some((edge) => edge.target === scene.id));
        if (parents.length === 1) priorIds = [parents[0].id];
    }
    return priorIds.map((id) => graph.scenes.find((s) => s.id === id)).find((s) => s && (s.media?.resourceId || s.media?.kind !== "event"));
}

export function parseFilmGraph(text: string): FilmGraph {
    let data;
    try {
        data = JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, ""));
    } catch {
        throw new Error("模型返回的剧情图不是有效 JSON，请重试");
    }
    if (!data || typeof data.start !== "string" || !Array.isArray(data.scenes) || !data.scenes.length || data.scenes.length > 300) throw new Error("剧情图缺少入口或有效场次");
    const ids = new Set<string>();
    const scenes: FilmScene[] = data.scenes.map((value: unknown) => {
        if (!value || typeof value !== "object") throw new Error("场次格式无效");
        const scene = value as Partial<FilmScene>;
        if (
            typeof scene.id !== "string" ||
            !/^[a-zA-Z0-9_-]{1,64}$/.test(scene.id) ||
            ids.has(scene.id) ||
            typeof scene.title !== "string" ||
            typeof scene.script !== "string" ||
            !["next", "choice", "ending"].includes(String(scene.mode)) ||
            !Array.isArray(scene.exits)
        )
            throw new Error("模型返回的场次编号、剧本或出口格式无效");
        ids.add(scene.id);
        const event = scene.media?.kind === "event";
        const exits = scene.exits.map((exit) => {
            if (!exit || typeof exit.target !== "string" || typeof exit.label !== "string") throw new Error("模型返回的出口格式无效");
            if (event && exit.feedback !== undefined && (typeof exit.feedback !== "string" || Array.from(exit.feedback).length > 500)) throw new Error("互动反馈格式无效或超过 500 字");
            return { target: exit.target, label: exit.label, ...(event && exit.feedback ? { feedback: exit.feedback } : {}) };
        });
        return { id: scene.id, title: scene.title, script: scene.script, source: typeof scene.source === "string" ? scene.source : "", mode: scene.mode!, exits, ...(event ? { media: { kind: "event" as const } } : {}) };
    });
    return { start: data.start, scenes };
}

// The generation contract emits start first, then scenes. Only close the array after a complete scene;
// braces, escaped quotes and JSON examples inside dialogue must not be mistaken for a scene boundary.
export function recoverFilmGraph(text: string): FilmGraph | undefined {
    const body = text.trimStart().replace(/^\x60\x60\x60(?:json)?\s*/i, "");
    const prefix = /^\{\s*"start"\s*:\s*"[\w-]+"\s*,\s*"scenes"\s*:\s*\[/.exec(body);
    if (!prefix) return;
    let depth = 0;
    let quoted = false;
    let end = 0;
    for (let i = prefix[0].length; i < body.length; i++) {
        const c = body[i];
        if (quoted && c === "\\") i++;
        else if (c === '"') quoted = !quoted;
        else if (!quoted) {
            if (c === "{") depth++;
            else if (c === "}" && --depth === 0) end = i + 1;
            else if (depth === 0 && c === "]") break;
        }
    }
    if (!end) return;
    try {
        return parseFilmGraph(body.slice(0, end) + "]}");
    } catch {
        return;
    }
}

export function missingFilmScenes(graph: FilmGraph): string[] {
    const existing = new Set(graph.scenes.map((s) => s.id));
    return [...new Set(graph.scenes.flatMap((s) => s.exits.map((exit) => exit.target)).filter((id) => id && !existing.has(id)))];
}

export function appendFilmScenes(graph: FilmGraph, addition: FilmGraph): FilmGraph {
    const ids = new Set(graph.scenes.map((s) => s.id));
    const missing = new Set(missingFilmScenes(graph));
    if (addition.scenes.some((s) => ids.has(s.id))) throw new Error("续写返回了已有场次，原剧本已保留");
    if (!addition.scenes.some((s) => missing.has(s.id))) throw new Error("续写未接上待补的场次，原剧本已保留");
    if (graph.scenes.length + addition.scenes.length > 300) throw new Error("续写后超过 300 场，请调整改编方向");
    return { start: graph.start, scenes: [...graph.scenes, ...addition.scenes] };
}
