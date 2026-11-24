import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, InputNumber, Select } from "antd";
import { nanoid } from "nanoid";
import { AppModal } from "@/components/ui/product/app-modal";
import { availableExits, filmExitEditIssue, filmConnectionTargets, filmSceneLabels, orderedTrack, MAX_FILM_CUES, videoHasChoiceOverlay } from "@/lib/film-interactions";
import { ItemNameInput } from "./item-name-input";
import { filmEventBackdrop, filmSceneResource } from "@/lib/interactive-film";
import { resolveDramaMedia, useResourceMediaUrl } from "@/pages/projects/drama-shared";
import type { FilmCue, FilmExit, FilmGraph, FilmScene, InteractiveFilm } from "@/services/api/interactive-films";
import type { DramaEpisodeRow } from "@/services/api/drama";
import type { FilmCheckpoint } from "@/lib/film-audit";
import { FilmPlayer } from "./studio-player";
import { useSceneRehearsal } from "./use-scene-rehearsal";
import { ChoiceOptions } from "./choice-options";
import { EventFrame } from "./event-frame";
import { FilmMediaContext } from "./film-media";

type Props = {
    graph: FilmGraph;
    scene: FilmScene;
    index: number;
    takes: InteractiveFilm["takes"];
    episodes: DramaEpisodeRow[];
    onApply: (scene: FilmScene) => void;
    onClose: () => void;
    onOpenTrack?: () => void;
    onInsert: (scene: FilmScene, kind: "event" | "clip") => void;
};

export function ExitEditor({ graph, scene, index, takes, episodes, onApply, onClose, onInsert, onOpenTrack }: Props) {
    const [exitIds] = useState(() => scene.exits.map((e) => e.id || nanoid()));
    const [edits, setEdits] = useState<Partial<Pick<FilmExit, "label" | "target" | "item" | "requiresItem">>>({});
    const exitId = exitIds[index];
    const exits = scene.exits.map((entry, i) => ({ ...entry, id: entry.id || exitIds[i] }));
    const current = exits[index].id === exitId ? exits[index] : (exits.find((entry) => entry.id === exitId) ?? exits[index]);
    const edge = { ...current, ...edits };
    const original = scene.track?.cues.find((c) => c.kind === "choice");
    const [cue, setCue] = useState<FilmCue>(() => original || { id: nanoid(), kind: "choice", atMs: 0 });
    const [timed, setTimed] = useState(!!original);
    const [inserting, setInserting] = useState(false);
    const [duration, setDuration] = useState(0);
    const [failed, setFailed] = useState(false);
    const [retry, setRetry] = useState(0);
    const [preview, setPreview] = useState<FilmCheckpoint[]>();
    const testButton = useRef<HTMLButtonElement>(null);
    const monitor = useRef<HTMLVideoElement>(null);
    const image = scene.media?.kind === "event";
    const resource = filmSceneResource(scene, takes, episodes);
    const mismatch = !!scene.track?.cues.length && scene.track.resourceId !== resource;
    const length = duration || (!mismatch && scene.track?.durationMs) || 0;
    const trigger = image ? 0 : timed ? cue.atMs : length;
    function seek() {
        const video = monitor.current;
        if (video && Number.isFinite(video.duration)) video.currentTime = Math.min(Math.max(0, video.duration - 0.04), timed ? cue.atMs / 1000 : video.duration);
    }
    useEffect(seek, [timed, cue.atMs, duration, preview, inserting]);
    const targets = useMemo(() => filmConnectionTargets(graph, scene.id), [graph, scene.id]);
    const labels = useMemo(() => filmSceneLabels(graph), [graph]);
    const others = scene.track?.cues.filter((c) => c.kind !== "choice") || [];
    const cues = timed && !image ? [...others, cue] : others;
    const track = mismatch ? scene.track : cues.length ? orderedTrack(resource || "", length, cues) : undefined;
    const updated = { ...scene, exits: exits.map((entry) => (entry === current ? edge : entry)), track };
    const updatedGraph = { ...graph, scenes: graph.scenes.map((s) => (s.id === scene.id ? updated : s)) };
    const rehearsal = useSceneRehearsal(updatedGraph, scene.id, Math.max(0, trigger - 2000), "试玩来路", edge.requiresItem, graph);
    const { arrival, arrivals } = rehearsal;
    const hasTarget = (id: string) => targets.some((s) => s.id === id);
    const problem = filmExitEditIssue(updated, arrivals, hasTarget);
    const [newTarget] = useState(() => nanoid());
    const connected = { ...updated, exits: updated.exits.map((e) => (e.id === edge.id ? { ...e, target: newTarget } : e)) };
    const canInsert = graph.scenes.length < 300 && (!problem || (!edge.target && !filmExitEditIssue(connected, arrivals, (id) => id === newTarget || hasTarget(id))));
    const visibleExits = availableExits(updated, arrival?.item || "");
    const changedExit = edge.label !== current.label || edge.target !== current.target || edge.item !== current.item || edge.requiresItem !== current.requiresItem;
    const backdrop = filmEventBackdrop(
        graph,
        scene,
        rehearsal.history
            .slice(0, -1)
            .reverse()
            .map((point) => point.id),
    );
    const url = useResourceMediaUrl(image ? backdrop && filmSceneResource(backdrop, takes, episodes) : resource, backdrop?.media?.kind === "event" ? "original" : "playback", retry);
    function closePreview() {
        setPreview(undefined);
        requestAnimationFrame(() => testButton.current?.focus());
    }
    function test() {
        if (!arrival || problem || mismatch) return;
        onApply(updated);
        const history = rehearsal.history;
        setPreview(!image && !timed && !length ? history.map((point, i) => (i === history.length - 1 ? { ...point, beforeEndMs: 2000 } : point)) : history);
    }
    return (
        <AppModal open width={820} title={inserting ? "插入剧情节点" : preview ? "试玩此选项" : `编辑出口 · ${scene.title}`} footer={null} onCancel={inserting ? () => setInserting(false) : preview ? closePreview : onClose}>
            {inserting ? (
                <>
                    <p>
                        {scene.title} → {targets.find((s) => s.id === edge.target)?.title || "待连接"}
                    </p>
                    <div className="film-actions">
                        <Button onClick={() => setInserting(false)}>返回此出口</Button>
                        <Button onClick={() => onInsert(updated, "event")}>插入互动事件</Button>
                        <Button onClick={() => onInsert(updated, "clip")}>插入视频片段</Button>
                    </div>
                </>
            ) : preview ? (
                <>
                    <Button onClick={closePreview}>返回此出口</Button>
                    <FilmPlayer graph={updatedGraph} takes={takes} episodes={episodes} initialHistory={preview} rehearsalExit={{ scene: scene.id, exit: edge.id }} />
                </>
            ) : (
                <>
                    <div className="film-exit-workbench">
                        <section className="film-exit-monitor">
                            {image ? (
                                <div inert>
                                    <FilmMediaContext.Provider value={resolveDramaMedia}>
                                        <EventFrame scene={updated} exits={visibleExits} background={backdrop?.media?.kind === "event" ? url : undefined} backdropVideo={backdrop?.media?.kind !== "event" ? url : undefined} suspended />
                                    </FilmMediaContext.Provider>
                                </div>
                            ) : url && !failed ? (
                                <div className="film-interactive-monitor" inert>
                                    <video
                                        key={retry}
                                        ref={monitor}
                                        src={url}
                                        muted
                                        playsInline
                                        preload="metadata"
                                        onError={() => setFailed(true)}
                                        onLoadedMetadata={(e) => {
                                            const d = e.currentTarget.duration;
                                            if (Number.isFinite(d)) setDuration(Math.round(d * 1000));
                                            seek();
                                        }}
                                    />
                                    {videoHasChoiceOverlay(scene) && (
                                        <div className="film-choice-overlay">
                                            <div className="film-actions">
                                                <ChoiceOptions question={timed ? cue.question : undefined} exits={visibleExits} />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <p>{failed ? `「${scene.title}」素材加载失败` : resource ? "正在载入素材…" : image ? "沿用上一场画面" : "本场尚未绑定成片"}</p>
                            )}
                            {failed && (
                                <Button
                                    onClick={() => {
                                        setFailed(false);
                                        setRetry(retry + 1);
                                    }}
                                >
                                    重试素材
                                </Button>
                            )}
                            <strong>{image ? "进入事件时显示" : scene.mode === "next" ? "片尾自动进入下一场" : timed ? `第 ${cue.atMs / 1000} 秒出现` : "视频播完时"}</strong>
                            {!image && !!length && (
                                <small>
                                    距片尾 {Math.max(0, length - trigger) / 1000} 秒 · 全长 {length / 1000} 秒
                                </small>
                            )}
                            {!image && !mismatch && scene.mode === "choice" && (
                                <>
                                    <Select
                                        aria-label="选择出现时机"
                                        value={timed ? "time" : "end"}
                                        onChange={(v) => setTimed(v === "time")}
                                        options={[
                                            { value: "end", label: "视频播完时" },
                                            { value: "time", label: "指定视频时刻", disabled: !length || others.length >= MAX_FILM_CUES },
                                        ]}
                                    />
                                    {others.length >= MAX_FILM_CUES && <small>每场最多 {MAX_FILM_CUES} 个互动点，请先在成片互动轨移除一个互动点。</small>}
                                    {timed && (
                                        <>
                                            <label>
                                                第几秒出现
                                                <InputNumber aria-label="第几秒出现" step={0.1} min={0} max={Math.max(0, length - 1) / 1000} value={cue.atMs / 1000} onChange={(v) => setCue({ ...cue, atMs: Math.round((v || 0) * 1000) })} />
                                            </label>
                                            <label>
                                                画内提问
                                                <Input value={cue.question} maxLength={80} onChange={(e) => setCue({ ...cue, question: e.target.value })} />
                                            </label>
                                            <label>
                                                倒计时（秒，0 为等候选择）
                                                <InputNumber min={0} max={3600} value={(cue.timeoutMs || 0) / 1000} onChange={(v) => setCue({ ...cue, timeoutMs: Math.round((v || 0) * 1000), defaultExit: cue.defaultExit || edge.id })} />
                                            </label>
                                            {!!cue.timeoutMs && (
                                                <label>
                                                    默认出口
                                                    <Select value={cue.defaultExit} options={updated.exits.filter((e) => e.id).map((e) => ({ value: e.id, label: e.label || "继续" }))} onChange={(defaultExit) => setCue({ ...cue, defaultExit })} />
                                                </label>
                                            )}
                                        </>
                                    )}
                                </>
                            )}
                            {mismatch && (
                                <Alert
                                    type="warning"
                                    title="成片已更换，请到成片互动轨逐点复核时间与位置。"
                                    description={changedExit ? "先应用出口修改并保存作品，再打开互动轨。" : onOpenTrack ? undefined : "保存作品后可进入制作台复核。"}
                                    action={
                                        onOpenTrack && (
                                            <Button disabled={changedExit} onClick={onOpenTrack}>
                                                打开成片互动轨
                                            </Button>
                                        )
                                    }
                                />
                            )}
                        </section>
                        <section className="film-exit-properties">
                            <label>
                                选项文案
                                <Input value={edge.label} maxLength={200} onChange={(e) => setEdits({ ...edits, label: e.target.value })} />
                            </label>
                            <label>
                                目标场次
                                <Select
                                    aria-label="目标场次"
                                    allowClear
                                    placeholder="待连接"
                                    value={edge.target || undefined}
                                    onChange={(v) => setEdits({ ...edits, target: v || "" })}
                                    options={targets.map((s) => ({ label: labels.get(s.id), value: s.id }))}
                                />
                            </label>
                            <Button disabled={!canInsert} onClick={() => setInserting(true)}>
                                {edge.target ? "在此出口插入节点" : "新建并连接"}
                            </Button>
                            <label>
                                需要持有
                                <ItemNameInput value={edge.requiresItem} placeholder="所有观众可选" onChange={(requiresItem) => setEdits({ ...edits, requiresItem })} />
                            </label>
                            <label>
                                选择后携带
                                <ItemNameInput value={edge.item} placeholder="保留当前物件" onChange={(item) => setEdits({ ...edits, item })} />
                            </label>
                            {rehearsal.controls}
                            {!arrival && <small>从入口走到本场的观众{edge.requiresItem ? `无法持有「${edge.requiresItem}」` : "没有可达路径"}。请检查上游出口。</small>}
                        </section>
                    </div>
                    {problem && <Alert type="warning" title={problem.message} />}
                    <div className="film-actions film-exit-footer">
                        <Button onClick={onClose}>取消</Button>
                        <Button
                            disabled={problem?.blocksApply}
                            onClick={() => {
                                onApply(updated);
                                onClose();
                            }}
                        >
                            应用
                        </Button>
                        <Button type="primary" ref={testButton} disabled={mismatch || !!problem || !arrival || !hasTarget(edge.target)} onClick={test}>
                            应用并试玩此选项
                        </Button>
                    </div>
                </>
            )}
        </AppModal>
    );
}
