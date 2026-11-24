import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useBlocker } from "react-router";
import { AppModal } from "@/components/ui/product/app-modal";
import { Alert, Button, Checkbox, Input, InputNumber, Select } from "antd";
import { nanoid } from "nanoid";
import type { FilmCue, FilmScene, InteractiveFilm } from "@/services/api/interactive-films";
import type { DramaEpisodeRow } from "@/services/api/drama";
import { filmTrackIssue, orderedTrack, filmRulesIssue, MAX_FILM_CUES } from "@/lib/film-interactions";
import { useSceneRehearsal } from "./use-scene-rehearsal";
import { useResourceMediaUrl } from "@/pages/projects/drama-shared";
import { FilmPlayer } from "./studio-player";
import { getInteractiveFilm } from "@/services/api/interactive-films";
import { getDrama } from "@/services/api/drama";
import { filmSceneResource } from "@/lib/interactive-film";
import { ApiError } from "@/services/api/request";
import { useQueryClient } from "@tanstack/react-query";
import { filmDraftStorage } from "./draft-storage";
import { ItemNameInput } from "./item-name-input";

function Seconds({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
    return (
        <label>
            {label}
            <InputNumber
                aria-label={label}
                min={0}
                step={0.1}
                value={value / 1000}
                onChange={(next) => {
                    if (next !== null) onChange(Math.round(next * 1000));
                }}
                suffix="秒"
            />
        </label>
    );
}

export type TrackDraft = { base: InteractiveFilm; scene: FilmScene; selected: string; reviewTrack?: FilmScene["track"]; confirmed?: string[] };
type Props = {
    film: InteractiveFilm;
    scene: FilmScene;
    resourceId: string;
    episodes: DramaEpisodeRow[];
    save: (scene: FilmScene, base: InteractiveFilm) => Promise<InteractiveFilm>;
    demoMedia?: Record<string, string>;
    initialTime?: number;
    scope?: string;
    recovery?: TrackDraft;
    onDraftChange?: (draft: TrackDraft | null) => void;
};
export function InteractionTrack({ film, scene, resourceId: initialResource, episodes: initialEpisodes, save, demoMedia, initialTime = 0, scope, recovery, onDraftChange }: Props) {
    const cache = useQueryClient();
    const [resourceId, setResourceId] = useState(recovery?.scene.track?.resourceId ?? initialResource);
    const [reviewSource, setReviewSource] = useState<DramaEpisodeRow[]>();
    const episodes = reviewSource ?? initialEpisodes;
    const [retry, setRetry] = useState(0);
    const [failedResource, setFailedResource] = useState<string>();
    const retryFrame = useRef<{ resource: string; time: number }>(undefined);
    const resolved = useResourceMediaUrl(demoMedia ? undefined : resourceId, "playback", retry);
    const url = demoMedia?.[scene.id] || resolved;
    const monitor = useRef<HTMLVideoElement>(null);
    const [base, setBase] = useState(recovery?.base ?? film);
    const [server, setServer] = useState<InteractiveFilm | undefined>(() => (recovery && (film.revision !== base.revision || initialResource !== resourceId) ? film : undefined));
    const [serverEpisodes, setServerEpisodes] = useState<DramaEpisodeRow[]>(initialEpisodes);
    const remoteScene = server?.graph.scenes.find((entry) => entry.id === scene.id);
    const remoteResource = server && remoteScene && remoteScene.media?.kind !== "event" ? filmSceneResource(remoteScene, server.takes, serverEpisodes) : undefined;
    const [stored, setStored] = useState(recovery?.scene ?? scene);
    const [cues, setCues] = useState<FilmCue[]>(stored.track?.cues || []);
    const [exits, setExits] = useState(() => stored.exits.map((exit) => ({ ...exit, id: exit.id || nanoid() })));
    const [selected, setSelected] = useState(recovery?.selected ?? (cues.find((cue) => cue.atMs === initialTime || (cue.kind === "hotspot" && cue.atMs <= initialTime && initialTime < (cue.endMs || 0)))?.id || cues[0]?.id || ""));
    const [head, setHead] = useState(0),
        [duration, setDuration] = useState(0);
    const [confirmed, setConfirmed] = useState<string[]>(recovery?.confirmed || []);
    const [busy, setBusy] = useState(false),
        [savingError, setSavingError] = useState(""),
        [preview, setPreview] = useState(false),
        [dirty, setDirty] = useState(!!recovery);
    const [cached, setCached] = useState(!!recovery);
    const [observed, setObserved] = useState({ revision: film.revision, resource: initialResource });
    if (observed.revision !== film.revision || observed.resource !== initialResource) {
        setObserved({ revision: film.revision, resource: initialResource });
        if (film.revision >= base.revision && (film.revision !== base.revision || initialResource !== resourceId)) {
            if (dirty) {
                setServer(film);
                setServerEpisodes(initialEpisodes);
            } else {
                setBase(film);
                setStored(scene);
                setCues(scene.track?.cues || []);
                setExits(scene.exits.map((exit) => ({ ...exit, id: exit.id || nanoid() })));
                setSelected(scene.track?.cues[0]?.id || "");
                setReviewSource(undefined);
                setConfirmed([]);
                if (initialResource !== resourceId) setDuration(0);
                setResourceId(initialResource);
            }
        }
    }
    const active = cues.find((cue) => cue.id === selected);
    const [restoredReview, setRestoredReview] = useState(recovery?.reviewTrack);
    const reviewTrack = restoredReview || stored.track;
    const previousIds = reviewTrack?.resourceId !== resourceId ? reviewTrack?.cues.map((cue) => cue.id) : undefined;
    const pendingReview = cues.filter((cue) => previousIds?.includes(cue.id) && !confirmed.includes(cue.id));
    const track = useMemo(() => orderedTrack(resourceId, duration || (stored.track?.resourceId === resourceId ? stored.track.durationMs : 0), cues), [resourceId, duration, cues, stored.track]);
    const baseScene = base.graph.scenes.find((entry) => entry.id === scene.id) || scene;
    const updated = useMemo(() => ({ ...baseScene, exits, track }), [baseScene, exits, track]);
    const draft = useMemo(() => ({ base, scene: updated, selected, reviewTrack: reviewTrack?.resourceId !== resourceId ? reviewTrack : undefined, confirmed }), [base, updated, selected, reviewTrack, resourceId, confirmed]);
    useLayoutEffect(() => {
        onDraftChange?.(dirty ? draft : null);
    }, [dirty, draft, onDraftChange]);
    const graph = { ...base.graph, scenes: base.graph.scenes.map((entry) => (entry.id === scene.id ? updated : entry)) };
    const issue = filmTrackIssue(updated) || filmRulesIssue(graph);
    const rehearsal = useSceneRehearsal(graph, scene.id, Math.max(0, (active?.atMs ?? head) - 2000), "试演来路", undefined, base.graph);
    const copyIssue = cues.some((cue) => Array.from(cue.question || "").length > 80 || Array.from(cue.collectionName || "").length > 60);
    // A saved track already measured this exact video. Copy edits and retries can
    // reuse that duration, while new cue timing and placement need the monitor.
    const savedTrack = stored.track;
    const knownLayout =
        savedTrack?.resourceId === resourceId &&
        savedTrack.durationMs > 0 &&
        cues.length === savedTrack.cues.length &&
        cues.every((cue, index) => {
            const saved = savedTrack.cues[index];
            return cue.id === saved.id && cue.kind === saved.kind && cue.atMs === saved.atMs && cue.endMs === saved.endMs && cue.x === saved.x && cue.y === saved.y;
        });
    const canSave = !server && (duration > 0 || knownLayout) && !pendingReview.length && dirty && !copyIssue;
    const blocker = useBlocker(({ currentLocation, nextLocation }) => {
        if (!dirty) return false;
        if (currentLocation.pathname !== nextLocation.pathname) return true;
        const current = new URLSearchParams(currentLocation.search);
        const next = new URLSearchParams(nextLocation.search);
        return ["scene", "tab", "mode", "audit"].some((key) => current.get(key) !== next.get(key));
    });
    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    useEffect(() => {
        if (!dirty && blocker.state === "blocked") blocker.proceed();
    }, [dirty, blocker]);
    function locate(ms: number) {
        if (!monitor.current) return;
        monitor.current.pause();
        monitor.current.currentTime = ms / 1000;
        setHead(ms);
    }
    function patch(changes: Partial<FilmCue>) {
        setCues((previous) => previous.map((cue) => (cue.id === selected ? { ...cue, ...changes } : cue)));
        markEdited();
    }
    function markEdited() {
        setCached(false);
        setDirty(true);
    }
    function add(kind: FilmCue["kind"]) {
        monitor.current?.pause();
        const cue: FilmCue = kind === "choice" ? { id: nanoid(), kind, atMs: head } : { id: nanoid(), kind, atMs: head, endMs: Math.min(head + 3000, duration), x: 50, y: 50, label: kind === "caption" ? "画内对白" : "查看线索", feedback: "" };
        setCues([...cues, cue]);
        setSelected(cue.id);
        markEdited();
    }
    async function clearDraft() {
        if (scope) {
            try {
                await filmDraftStorage.removeItem(scope);
            } catch {
                setSavingError("本机草稿清理失败，请检查浏览器存储。");
                return false;
            }
            cache.setQueryData(["film-track-draft", scope], null);
        }
        setCached(false);
        return true;
    }
    async function persist() {
        if (busy || !canSave) return false;
        setBusy(true);
        setSavingError("");
        let cacheFailed = false;
        if (scope) {
            const entry = draft;
            try {
                await filmDraftStorage.setItem(scope, entry);
                cache.setQueryData(["film-track-draft", scope], entry);
                setCached(true);
            } catch {
                cacheFailed = true;
            }
        }
        try {
            const record = await save(updated, base);
            setBase(record);
            setStored(updated);
            setRestoredReview(undefined);
            setDirty(false);
            setServer(undefined);
            await clearDraft();
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : "保存失败";
            setSavingError(cacheFailed ? `${message}。本机草稿写入失败，请保留页面并重试。` : message);
            if (error instanceof ApiError && error.status === 409) {
                try {
                    const latest = await getInteractiveFilm(film.id);
                    const remote = latest.graph.scenes.find((entry) => entry.id === scene.id);
                    const rows = remote && !remote.media && latest.projectId ? (await getDrama(latest.projectId)).episodes : episodes;
                    setServerEpisodes(rows);
                    setServer(latest);
                } catch {
                    setSavingError("版本冲突，暂时无法读取对方版本。请重试保存。");
                }
            }
            return false;
        } finally {
            setBusy(false);
        }
    }
    if (!resourceId && !dirty) return <p className="drama-editor-note">本场成片就绪后，可定位画面并配置互动点。</p>;
    return (
        <section className="drama-scriptv-brief film-track-editor">
            <AppModal
                title="离开本场互动轨？"
                open={blocker.state === "blocked"}
                onCancel={() => {
                    if (!busy) blocker.reset?.();
                }}
                footer={[
                    <Button
                        key="discard"
                        disabled={busy}
                        onClick={async () => {
                            if (await clearDraft()) {
                                setDirty(false);
                                onDraftChange?.(null);
                                blocker.proceed?.();
                            }
                        }}
                    >
                        放弃修改
                    </Button>,
                    <Button key="stay" disabled={busy} onClick={() => blocker.reset?.()}>
                        继续编辑
                    </Button>,
                    <Button
                        key="save"
                        type="primary"
                        loading={busy}
                        disabled={!canSave}
                        onClick={async () => {
                            if (!(await persist())) blocker.reset?.();
                        }}
                    >
                        保存并离开
                    </Button>,
                ]}
            >
                「{scene.title}」的互动轨还有未保存的修改。
            </AppModal>
            <div className="drama-section-title">
                <h2>成片互动轨</h2>
                <span role="status">{dirty ? (cached ? "本地草稿待同步" : "尚未保存") : stored.track ? "已保存" : "尚未配置"}</span>
            </div>
            {!!pendingReview.length && <Alert type="warning" title={`成片版本已变更，还有 ${pendingReview.length} 个互动点待复核`} description="选择标有「待复核」的互动点，对照新成片确认时间与位置。" />}
            {savingError && <Alert type="error" title={savingError} />}
            {failedResource === resourceId && (
                <Alert
                    type="warning"
                    title="成片加载失败"
                    action={
                        <Button
                            onClick={() => {
                                retryFrame.current = { resource: resourceId, time: duration > 0 ? head : (active?.atMs ?? initialTime) };
                                setFailedResource(undefined);
                                setRetry((value) => value + 1);
                            }}
                        >
                            重试视频
                        </Button>
                    }
                />
            )}
            {server && (
                <details open>
                    <summary>对照服务器版本 {server.revision} 与当前编辑</summary>
                    <p>重新保存会采用服务器上的剧本和其他场次，并将本场互动点及出口替换为当前编辑。</p>
                    {[
                        ["服务器", server.graph.scenes.find((entry) => entry.id === scene.id)],
                        ["当前编辑", updated],
                    ].map(([name, value]) => (
                        <details key={String(name)}>
                            <summary>{String(name)}</summary>
                            <pre className="film-script">{JSON.stringify(value, null, 2)}</pre>
                        </details>
                    ))}
                    {!remoteResource && <p>服务器上的本场已移除或没有可编辑的成片，请返回剧情图核对。</p>}
                    <Button
                        disabled={!remoteResource}
                        onClick={() => {
                            if (!remoteResource) return;
                            if (remoteResource !== resourceId) {
                                setStored(updated);
                                setRestoredReview(undefined);
                                setConfirmed([]);
                                setDuration(0);
                                setHead(0);
                                setPreview(false);
                            }
                            setResourceId(remoteResource);
                            setReviewSource(serverEpisodes);
                            setBase(server);
                            setServer(undefined);
                            setSavingError("");
                            markEdited();
                        }}
                    >
                        对照完成，使用此版本继续编辑
                    </Button>
                </details>
            )}
            {issue && <Alert type="warning" title={issue} />}
            {preview && (
                <>
                    <Button onClick={() => setPreview(false)}>返回互动轨</Button>
                    <FilmPlayer graph={graph} takes={base.takes} episodes={episodes} demoMedia={demoMedia} initialHistory={rehearsal.history} />
                </>
            )}
            <fieldset disabled={busy} hidden={preview} className="film-track-fields">
                <div className="film-track-workspace">
                    <div>
                        <div
                            className="film-interactive-monitor"
                            onClick={(event) => {
                                if (active?.kind !== "hotspot") return;
                                const box = event.currentTarget.getBoundingClientRect();
                                patch({ x: Math.min(100, Math.max(0, ((event.clientX - box.left) / box.width) * 100)), y: Math.min(100, Math.max(0, ((event.clientY - box.top) / box.height) * 100)) });
                            }}
                        >
                            {url && (
                                <video
                                    key={resourceId + ":" + retry}
                                    ref={monitor}
                                    src={url}
                                    playsInline
                                    preload="metadata"
                                    onError={() => setFailedResource(resourceId)}
                                    onLoadedMetadata={(event) => {
                                        const length = Math.round(event.currentTarget.duration * 1000);
                                        setDuration(length);
                                        const restore = retryFrame.current;
                                        const frame = restore?.resource === resourceId ? restore.time : initialTime > 0 ? initialTime : active?.atMs || 0;
                                        retryFrame.current = undefined;
                                        setFailedResource(undefined);
                                        if (Number.isFinite(frame)) locate(Math.min(frame, length));
                                    }}
                                    onTimeUpdate={(event) => setHead(Math.round(event.currentTarget.currentTime * 1000))}
                                />
                            )}
                            {track.cues
                                .filter((cue) => cue.kind === "caption" && head >= cue.atMs && head < cue.endMs!)
                                .map((cue) => (
                                    <p className="film-screen-caption" key={cue.id}>
                                        {cue.label}
                                    </p>
                                ))}
                            {active?.kind === "hotspot" && (
                                <span className="film-cue-marker" style={{ left: (active.x ?? 0) + "%", top: (active.y ?? 0) + "%" }}>
                                    {active.label}
                                </span>
                            )}
                        </div>
                        <input aria-label="成片播放头" type="range" min={0} max={duration} step={1} value={head} onChange={(event) => locate(Number(event.target.value))} />
                        <div className="film-actions">
                            <Button
                                disabled={!duration}
                                onClick={() => {
                                    const video = monitor.current;
                                    if (video?.paused) void video.play().catch(() => setSavingError("无法播放成片"));
                                    else video?.pause();
                                }}
                            >
                                播放 / 暂停
                            </Button>
                            <span>
                                {(head / 1000).toFixed(1)} / {(duration / 1000).toFixed(1)} 秒
                            </span>
                        </div>
                        {track.cues
                            .filter((cue) => cue.kind === "choice")
                            .map((cue) => (
                                <div className="film-cut-strip" key={cue.id}>
                                    <span style={{ flexGrow: cue.atMs }}>前段 {(cue.atMs / 1000).toFixed(1)}s</span>
                                    <span style={{ flexGrow: Math.max(0, duration - cue.atMs) }}>余段 {(Math.max(0, duration - cue.atMs) / 1000).toFixed(1)}s</span>
                                </div>
                            ))}
                        <div className="film-actions">
                            {track.cues.map((cue) => (
                                <Button
                                    key={cue.id}
                                    danger={duration > 0 && (cue.atMs >= duration || (cue.endMs ?? 0) > duration)}
                                    aria-pressed={selected === cue.id}
                                    onClick={() => {
                                        setSelected(cue.id);
                                        locate(Math.min(duration, cue.atMs));
                                    }}
                                >
                                    {(cue.atMs / 1000).toFixed(1)}s · {cue.kind === "choice" ? "选择" : cue.label}
                                    {pendingReview.includes(cue) && " · 待复核"}
                                </Button>
                            ))}
                        </div>
                        <div className="film-actions">
                            <Button disabled={!duration || cues.length >= MAX_FILM_CUES || head >= duration} onClick={() => add("caption")}>
                                ＋ 画内对白
                            </Button>
                            <Button disabled={!duration || cues.length >= MAX_FILM_CUES || head >= duration} onClick={() => add("hotspot")}>
                                ＋ 画面热点
                            </Button>
                            <Button disabled={!duration || cues.length >= MAX_FILM_CUES || head >= duration || scene.mode !== "choice" || cues.some((cue) => cue.kind === "choice")} onClick={() => add("choice")}>
                                ＋ 物件 / 选择点
                            </Button>
                        </div>
                    </div>
                    {active && (
                        <aside className="film-rule-inspector">
                            <Seconds label="触发时刻" value={active.atMs} onChange={(atMs) => patch({ atMs })} />
                            <Button onClick={() => patch({ atMs: head })}>移到播放头</Button>
                            {active.kind === "caption" ? (
                                <>
                                    <Seconds label="收起时刻" value={active.endMs ?? active.atMs} onChange={(endMs) => patch({ endMs })} />
                                    <label>
                                        画内对白
                                        <Input.TextArea maxLength={500} value={active.label} onChange={(event) => patch({ label: event.target.value })} />
                                    </label>
                                </>
                            ) : active.kind === "hotspot" ? (
                                <>
                                    <Seconds label="收起时刻" value={active.endMs ?? active.atMs} onChange={(endMs) => patch({ endMs })} />
                                    <label>
                                        热点文案
                                        <Input maxLength={60} value={active.label} onChange={(event) => patch({ label: event.target.value })} />
                                    </label>
                                    <label>
                                        线索册名称
                                        <Input value={active.collectionName} placeholder={active.label} onChange={(event) => patch({ collectionName: event.target.value })} />
                                    </label>
                                    <label>
                                        点击反馈
                                        <Input maxLength={500} value={active.feedback} onChange={(event) => patch({ feedback: event.target.value })} />
                                    </label>
                                    <div className="film-actions">
                                        {(["x", "y"] as const).map((axis) => (
                                            <label key={axis}>
                                                {axis === "x" ? "水平" : "垂直"}位置 %<InputNumber min={0} max={100} value={Math.round(active[axis] ?? 0)} onChange={(value) => patch({ [axis]: value ?? 0 })} />
                                            </label>
                                        ))}
                                    </div>
                                    <Checkbox checked={active.wait} onChange={(event) => patch({ wait: event.target.checked })}>
                                        等候点击后续播
                                    </Checkbox>
                                </>
                            ) : (
                                <>
                                    <label>
                                        给观众的问题
                                        <Input.TextArea rows={2} value={active.question || ""} placeholder="可选，显示在本轮可用行动上方" onChange={(event) => patch({ question: event.target.value })} />
                                    </label>
                                    <small>{Array.from(active.question || "").length} / 80</small>
                                    <label>
                                        选定后
                                        <Select
                                            value={active.tail ? "end" : "now"}
                                            options={[
                                                { value: "now", label: "立即切场" },
                                                { value: "end", label: "播完余段再切场" },
                                            ]}
                                            onChange={(value) => patch({ tail: value === "end" })}
                                        />
                                    </label>
                                    {exits.map((exit, index) => (
                                        <label key={exit.id}>
                                            {exit.label} → {base.graph.scenes.find((entry) => entry.id === exit.target)?.title}
                                            <small>{exit.requiresItem ? `需要携带${exit.requiresItem}` : "所有来路"}</small>
                                            <ItemNameInput
                                                aria-label={exit.label + "选后携带"}
                                                placeholder="选后携带物（可选）"
                                                value={exit.item}
                                                onChange={(name) => {
                                                    setExits(exits.map((entry, position) => (position === index ? { ...entry, item: name } : entry)));
                                                    markEdited();
                                                }}
                                            />
                                        </label>
                                    ))}
                                    <Seconds label="倒计时（0 为等待）" value={active.timeoutMs || 0} onChange={(timeoutMs) => patch({ timeoutMs })} />
                                    {!!active.timeoutMs && (
                                        <label>
                                            超时默认项
                                            <Select value={active.defaultExit} options={exits.map((exit) => ({ value: exit.id, label: exit.label }))} onChange={(defaultExit) => patch({ defaultExit })} />
                                        </label>
                                    )}
                                </>
                            )}
                            {pendingReview.includes(active) && (
                                <Button
                                    disabled={!duration || active.atMs >= duration || (active.endMs ?? 0) > duration}
                                    onClick={() => {
                                        locate(active.atMs);
                                        setConfirmed([...confirmed, active.id]);
                                        markEdited();
                                    }}
                                >
                                    确认此互动点
                                </Button>
                            )}
                            <Button
                                onClick={() => {
                                    setCues(cues.filter((cue) => cue.id !== selected));
                                    setSelected("");
                                    markEdited();
                                }}
                            >
                                移除互动点
                            </Button>
                        </aside>
                    )}
                </div>
                <div className="film-actions">
                    {rehearsal.controls}
                    {copyIssue && <span role="alert">问题最多 80 字，线索册名称最多 60 字。</span>}
                    <Button type="primary" disabled={!canSave} loading={busy} onClick={() => void persist()}>
                        保存互动轨
                    </Button>
                    <Button
                        disabled={!rehearsal.arrival || !duration || !!pendingReview.length || !!issue || copyIssue}
                        onClick={() => {
                            monitor.current?.pause();
                            setPreview(true);
                        }}
                    >
                        从点前两秒试演
                    </Button>
                </div>
            </fieldset>
        </section>
    );
}
