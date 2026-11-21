import { http } from "@/services/api/request";
import type { DramaModels } from "@/services/api/drama";

export type FilmExit = { id?: string; label: string; target: string; item?: string; requiresItem?: string; spot?: { x: number; y: number }; feedback?: string };
export type FilmCue = {
    id: string;
    kind: "hotspot" | "choice";
    atMs: number;
    endMs?: number;
    x?: number;
    y?: number;
    label?: string;
    feedback?: string;
    collectionName?: string;
    question?: string;
    wait?: boolean;
    tail?: boolean;
    timeoutMs?: number;
    defaultExit?: string;
};
export type FilmTrack = { resourceId: string; durationMs: number; cues: FilmCue[] };
export type FilmScene = { id: string; title: string; source: string; script: string; mode: "choice" | "next" | "ending"; exits: FilmExit[]; track?: FilmTrack; clue?: string; response?: string; media?: { kind: "event" | "clip"; resourceId?: string } };
export type FilmGraph = { start: string; scenes: FilmScene[] };
export type FilmDraft = { title: string; novel: string; direction: string; graph: FilmGraph; revision: number };
export type InteractiveFilm = FilmDraft & { id: string; projectId: string; takes: Record<string, { episodeId: string; script: string }>; updatedAt: string };
const base = "/interactive-films";
export function getFilmAdaptationMethod(signal: AbortSignal) {
    return http.get<{ method: string }>(base + "/adaptation-method", { signal });
}
export function listInteractiveFilms(signal?: AbortSignal) {
    return http.get<Pick<InteractiveFilm, "id" | "title" | "updatedAt" | "revision">[]>(base, { signal });
}
export function getInteractiveFilm(id: string, signal?: AbortSignal) {
    return http.get<InteractiveFilm>(base + "/" + encodeURIComponent(id), { signal });
}
export function saveInteractiveFilm(draft: FilmDraft & { creationKey?: string }, id?: string) {
    const { title, novel, direction, graph, revision } = draft;
    const input = { title, novel, direction, graph, revision };
    return id ? http.put<InteractiveFilm>(base + "/" + encodeURIComponent(id), input) : http.post<InteractiveFilm>(base, { ...input, creationKey: draft.creationKey });
}
export function produceFilmScenes(id: string, revision: number, sceneIds: string[], models?: Partial<DramaModels>) {
    return http.post<InteractiveFilm>(base + "/" + encodeURIComponent(id) + "/produce", { revision, sceneIds, models }, { timeout: 120000 });
}
