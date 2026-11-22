import { useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router";
import { AppModal } from "@/components/ui/product/app-modal";
import { Alert, Button, Checkbox, Input, InputNumber, Select } from "antd";
import { nanoid } from "nanoid";
import type { FilmCue, FilmScene, InteractiveFilm } from "@/services/api/interactive-films";
import type { DramaEpisodeRow } from "@/services/api/drama";
import { filmTrackIssue, orderedTrack, filmRulesIssue, filmArrivals } from "@/lib/film-interactions";
import { useResourceMediaUrl } from "@/pages/projects/drama-shared";
import { FilmPlayer } from "./studio-player";
import { getInteractiveFilm } from "@/services/api/interactive-films";
import { ApiError } from "@/services/api/request";

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

type Props = { film: InteractiveFilm; scene: FilmScene; resourceId: string; episodes: DramaEpisodeRow[]; save: (scene: FilmScene, base: InteractiveFilm) => Promise<InteractiveFilm>; demoMedia?: Record<string, string>; initialTime?: number };
export function InteractionTrack({ film, scene, resourceId, episodes, save, demoMedia, initialTime = 0 }: Props) {
    const resolved = useResourceMediaUrl(demoMedia ? undefined : resourceId, "playback");
    const url = demoMedia?.[scene.id] || resolved;
    const monitor = useRef<HTMLVideoElement>(null);
    const [base, setBase] = useState(film);
    const [server, setServer] = useState<InteractiveFilm>();
    const [stored, setStored] = useState(scene);
    const [cues, setCues] = useState<FilmCue[]>(scene.track?.cues || []);
    const [exits, setExits] = useState(() => scene.exits.map((exit) => ({ ...exit, id: exit.id || nanoid() })));
    const [selected, setSelected] = useState(cues.find((cue) => cue.atMs === initialTime || (cue.kind === "hotspot" && cue.atMs <= initialTime && initialTime < (cue.endMs || 0)))?.id || cues[0]?.id || "");
    const [head, setHead] = useState(0),
        [duration, setDuration] = useState(0);
    const [reviewed, setReviewed] = useState(scene.track?.resourceId === resourceId || !scene.track?.cues.length);
    const [busy, setBusy] = useState(false),
        [savingError, setSavingError] = useState(""),
        [preview, setPreview] = useState(false),
        [dirty, setDirty] = useState(false);
    const active = cues.find((cue) => cue.id === selected);
    const track = orderedTrack(resourceId, duration, cues);
    const baseScene = base.graph.scenes.find((entry) => entry.id === scene.id) || scene;
    const updated = { ...baseScene, exits, track };
    const graph = { ...base.graph, scenes: base.graph.scenes.map((entry) => (entry.id === scene.id ? updated : entry)) };
    const issue = filmTrackIssue(updated) || filmRulesIssue(graph);
    const arrivals = [...new Set(filmArrivals(graph, scene.id).map((arrival) => arrival.item))];
    const [arrival, setArrival] = useState<string>();
    const trialItem = arrival !== undefined && arrivals.includes(arrival) ? arrival : arrivals[0] || "";
    const copyIssue = cues.some((cue) => Array.from(cue.question || "").length > 80 || Array.from(cue.collectionName || "").length > 60);
    const canSave = duration > 0 && reviewed && dirty && !copyIssue;
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
        setDirty(true);
    }
    function add(kind: FilmCue["kind"]) {
        monitor.current?.pause();
        const cue: FilmCue = kind === "choice" ? { id: nanoid(), kind, atMs: head } : { id: nanoid(), kind, atMs: head, endMs: Math.min(head + 3000, duration), x: 50, y: 50, label: kind === "caption" ? "画内对白" : "查看线索", feedback: "" };
        setCues([...cues, cue]);
        setSelected(cue.id);
        setDirty(true);
    }
    async function persist() {
        if (busy || !canSave) return false;
        setBusy(true);
        setSavingError("");
        try {
            const record = await save(updated, base);
            setBase(record);
            setStored(updated);
            setDirty(false);
            setServer(undefined);
            return true;
        } catch (error) {
            setSavingError(error instanceof Error ? error.message : "保存失败");
            if (error instanceof ApiError && error.status === 409) {
                try {
                    setServer(await getInteractiveFilm(film.id));
                } catch {
                    setSavingError("版本冲突，暂时无法读取对方版本。请重试保存。");
                }
            }
            return false;
        } finally {
            setBusy(false);
        }
    }
    if (!resourceId) return <p className="drama-editor-note">本场成片就绪后，可定位画面并配置互动点。</p>;
    return (
        <section className="drama-scriptv-brief film-track-editor">
            <AppModal
                title="离开本场互动轨？"
                open={blocker.state === "blocked"}
                onCancel={() => {
                    if (!busy) blocker.reset?.();
                }}
                footer={[
                    <Button key="discard" disabled={busy} onClick={() => blocker.proceed?.()}>
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
                <span role="status">{dirty ? "尚未保存" : stored.track ? "已保存" : "尚未配置"}</span>
            </div>
            {!reviewed && (
                <Alert
                    type="warning"
                    title="成片版本已变更，请复核时间与热点位置"
                    action={
                        <Button
                            onClick={() => {
                                setReviewed(true);
                                setDirty(true);
                            }}
                        >
                            确认当前画面
                        </Button>
                    }
                />
            )}
            {savingError && <Alert type="error" title={savingError} />}
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
                    <Button
                        disabled={!server.graph.scenes.some((entry) => entry.id === scene.id)}
                        onClick={() => {
                            setBase(server);
                            setServer(undefined);
                            setSavingError("");
                            setDirty(true);
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
                    <FilmPlayer graph={graph} takes={film.takes} episodes={episodes} demoMedia={demoMedia} initialHistory={[{ id: scene.id, time: Math.max(0, (active?.atMs ?? head) - 2000), state: { item: trialItem, clues: [] } }]} />
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
                                    ref={monitor}
                                    src={url}
                                    playsInline
                                    preload="metadata"
                                    onError={() => setSavingError("成片加载失败，请重新打开本场成片")}
                                    onLoadedMetadata={(event) => {
                                        const length = Math.round(event.currentTarget.duration * 1000);
                                        setDuration(length);
                                        const frame = initialTime > 0 ? initialTime : active?.atMs || 0;
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
                                </Button>
                            ))}
                        </div>
                        <div className="film-actions">
                            <Button disabled={!duration || cues.length >= 64 || head >= duration} onClick={() => add("caption")}>
                                ＋ 画内对白
                            </Button>
                            <Button disabled={!duration || cues.length >= 64 || head >= duration} onClick={() => add("hotspot")}>
                                ＋ 画面热点
                            </Button>
                            <Button disabled={!duration || cues.length >= 64 || head >= duration || scene.mode !== "choice" || cues.some((cue) => cue.kind === "choice")} onClick={() => add("choice")}>
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
                                            {exit.label} → {film.graph.scenes.find((entry) => entry.id === exit.target)?.title}
                                            <small>{exit.requiresItem ? `需要携带${exit.requiresItem}` : "所有来路"}</small>
                                            <Input
                                                aria-label={exit.label + "选后携带"}
                                                placeholder="选后携带物（可选）"
                                                value={exit.item}
                                                maxLength={60}
                                                onChange={(event) => {
                                                    setExits(exits.map((entry, position) => (position === index ? { ...entry, item: event.target.value.trim() } : entry)));
                                                    setDirty(true);
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
                            <Button
                                onClick={() => {
                                    setCues(cues.filter((cue) => cue.id !== selected));
                                    setSelected("");
                                    setDirty(true);
                                }}
                            >
                                移除互动点
                            </Button>
                        </aside>
                    )}
                </div>
                <div className="film-actions">
                    {arrivals.length > 1 && (
                        <label>
                            试演来路
                            <Select aria-label="试演来路" value={trialItem} onChange={setArrival} options={arrivals.map((item) => ({ value: item, label: item || "空手" }))} />
                        </label>
                    )}
                    {copyIssue && <span role="alert">问题最多 80 字，线索册名称最多 60 字。</span>}
                    <Button type="primary" disabled={!canSave} loading={busy} onClick={() => void persist()}>
                        保存互动轨
                    </Button>
                    <Button
                        disabled={!duration || !reviewed || !!issue || copyIssue}
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
