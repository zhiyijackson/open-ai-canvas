import type { FilmGraph, InteractiveFilm } from "@/services/api/interactive-films";
import type { DramaEpisodeRow } from "@/services/api/drama";
import { filmTrackIssue } from "@/lib/film-interactions";
import { filmGraphIssue } from "@/lib/interactive-film";
import { createZip } from "@/lib/zip";
import { getResourceBlob, resourceStorageKey } from "@/services/api/resources";
import studioStyle from "./studio.css?raw";
import shellStyle from "./h5.css?raw";

export type FilmPackage = { version: 1; revision: number; title: string; graph: FilmGraph; sceneResources: Record<string, string>; posters: Record<string, string>; stills?: Record<string, string>; assets: Record<string, string> };
const entry =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>互动影游</title><link rel="stylesheet" href="runtime/player.css"></head><body><main id="app">正在打开作品…</main><script defer src="runtime/player.js"></script></body></html>';

async function inspectVideo(blob: Blob, captureEnd: boolean): Promise<{ duration: number; still: Blob; poster?: Blob }> {
    const url = URL.createObjectURL(blob),
        video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    let timer = 0;
    try {
        return await new Promise((resolve, reject) => {
            timer = window.setTimeout(() => reject(Error("读取视频超时")), 30000);
            video.onerror = () => reject(Error("视频无法解码"));
            let still: Blob | undefined;
            video.onloadedmetadata = () => {
                if (!Number.isFinite(video.duration) || video.duration <= 0) {
                    reject(Error("视频时长无效"));
                    return;
                }
                video.currentTime = Math.min(0.12, video.duration / 2);
            };
            video.onseeked = () => {
                const canvas = document.createElement("canvas");
                canvas.width = Math.min(video.videoWidth, 1280);
                canvas.height = Math.max(1, Math.round((canvas.width * video.videoHeight) / video.videoWidth));
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    reject(Error("无法保存视频画面"));
                    return;
                }
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                canvas.toBlob(
                    (frame) => {
                        if (!frame) return reject(Error("保存视频画面失败"));
                        if (still) return resolve({ duration: video.duration, still, poster: frame });
                        const end = Math.max(0, video.duration - 0.04);
                        if (!captureEnd || Math.abs(video.currentTime - end) < 0.001) return resolve({ duration: video.duration, still: frame, poster: captureEnd ? frame : undefined });
                        still = frame;
                        video.currentTime = end;
                    },
                    "image/jpeg",
                    0.85,
                );
            };
            video.src = url;
        });
    } finally {
        clearTimeout(timer);
        video.onloadedmetadata = null;
        video.onseeked = null;
        video.onerror = null;
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
    }
}

export async function exportFilm(film: InteractiveFilm, episodes: DramaEpisodeRow[], progress: (message: string) => void) {
    const issue = filmGraphIssue(film.graph);
    if (issue) throw Error(issue);
    const sceneResources: Record<string, string> = Object.create(null),
        assets: Record<string, string> = Object.create(null);
    const posters: Record<string, string> = Object.create(null);
    const stills: Record<string, string> = Object.create(null);
    const resources = new Map<string, { name: string; kind: "image" | "video" }>();
    for (const scene of film.graph.scenes) {
        const take = film.takes[scene.id];
        const episode = episodes.find((e) => e.id === take?.episodeId);
        const id = scene.media ? scene.media.resourceId : episode && !episode.finalStale && take.script === scene.script ? episode.finalResourceId : undefined;
        if (scene.media?.kind !== "event" && !id) throw Error(`「${scene.title}」缺少可播放的最新成片`);
        if (scene.track?.cues.length && scene.track.resourceId !== id) throw Error(`「${scene.title}」请先复核成片互动轨`);
        if (id) {
            sceneResources[scene.id] = id;
            resources.set(id, { name: scene.title, kind: scene.media?.kind === "event" ? "image" : "video" });
        }
        for (const edge of scene.exits) if (edge.spot?.resourceId) resources.set(edge.spot.resourceId, { name: `${scene.title} · ${edge.label}`, kind: "image" });
    }
    const files: { name: string; data: BlobPart }[] = [];
    const runtime = await fetch(import.meta.env.BASE_URL + "film-runtime/player.js");
    if (!runtime.ok || !runtime.headers.get("content-type")?.includes("javascript")) throw Error("读取 H5 播放器失败，请重新导出");
    files.push({ name: "runtime/player.js", data: await runtime.blob() }, { name: "runtime/player.css", data: studioStyle + "\n" + shellStyle }, { name: "index.html", data: entry });
    let index = 0;
    for (const [id, resource] of resources) {
        progress(`正在打包 ${++index}/${resources.size} · ${resource.name}`);
        try {
            const blob = await getResourceBlob(resourceStorageKey(id), "browser-process", resource.kind === "video" ? "playback" : "original");
            if (!blob?.size) throw Error("素材为空");
            const type = blob.type.split(";")[0];
            const ext: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
            if (!type.startsWith(resource.kind + "/")) throw Error("文件类型与节点不匹配");
            if (resource.kind === "video") {
                const scenes = film.graph.scenes.filter((s) => sceneResources[s.id] === id);
                const needsPoster = film.graph.scenes.some((s) => s.media?.kind === "event" && !s.media.resourceId);
                const { duration, still, poster } = await inspectVideo(blob, needsPoster);
                const stillPath = `assets/still-${index}.jpg`;
                files.push({ name: stillPath, data: still });
                for (const scene of scenes) {
                    stills[scene.id] = stillPath;
                    const issue = filmTrackIssue(scene, scene.track, Math.round(duration * 1000));
                    if (issue) throw Error(issue);
                    if (poster) posters[scene.id] = `assets/frame-${index}.jpg`;
                }
                if (poster) files.push({ name: `assets/frame-${index}.jpg`, data: poster });
            }
            const path = `assets/${index}.${ext[type] || "bin"}`;
            assets[id] = path;
            files.push({ name: path, data: blob });
        } catch (cause) {
            throw Error(`「${resource.name}」${cause instanceof Error ? cause.message : "读取失败"}`);
        }
    }
    const story: FilmPackage = { version: 1, revision: film.revision, title: film.title, graph: film.graph, sceneResources, posters, stills, assets };
    files.push(
        { name: "story.json", data: JSON.stringify(story, null, 2) },
        {
            name: "README.md",
            data: `# ${film.title}\n\n工程格式 v1，作品版本 ${film.revision}。\n\n解压整个目录，在含 index.html 的目录运行 python3 -m http.server 8000 --bind 127.0.0.1，然后打开 http://127.0.0.1:8000/ 。将整个目录上传至静态站点即可部署。\n\nstory.json 中 graph 保存入口、节点、出口、时间轨和热区；sceneResources 指定各场素材编号，assets 映射到随包文件。编辑后刷新即可试玩。runtime/ 包含对应播放器。影策内继续制作请打开原作品。\n`,
        },
    );
    progress("正在生成 ZIP");
    return createZip(files);
}
