import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Select } from "antd";
import type { DramaEpisodeRow } from "@/services/api/drama";
import type { FilmCue, FilmExit, FilmGraph, FilmScene, InteractiveFilm } from "@/services/api/interactive-films";
import { availableExits, emptyFilmState, filmArrivals, filmTrackIssue, inspectFilmCue, takeFilmExit, type FilmState } from "@/lib/film-interactions";
import { useResourceMediaUrl } from "@/pages/projects/drama-shared";
import { filmDecisionKey, type FilmCheckpoint as Checkpoint } from "@/lib/film-audit";
import { BookOpen } from "lucide-react";
import { FilmNotebook } from "./notebook";
import { EventFrame } from "./node-media";

type PlayerProps = {
    graph: FilmGraph;
    takes: InteractiveFilm["takes"];
    episodes: DramaEpisodeRow[];
    start?: string;
    time?: number;
    demoMedia?: Record<string, string>;
    onLocate?: (id: string, time?: number) => void;
    initialHistory?: Checkpoint[];
    onEnding?: (key: string, ending: string) => void;
    onAudit?: () => void;
};

export function FilmPlayer({ graph, takes, episodes, start, time = 0, demoMedia, onLocate, initialHistory, onEnding, onAudit }: PlayerProps) {
    const [history, setHistory] = useState<Checkpoint[]>(() => initialHistory || [{ id: start || graph.start, state: { item: start && start !== graph.start ? filmArrivals(graph, start)[0]?.item || "" : "", clues: [] }, time }]);
    const [generation, setGeneration] = useState(0);
    const [analysis, setAnalysis] = useState(false);
    const [notebook, setNotebook] = useState(false);
    const notebookButton = useRef<HTMLButtonElement>(null);
    const [wait, setWait] = useState(false);
    const [noTimer, setNoTimer] = useState(false);
    const [textMode, setTextMode] = useState(false);
    const [still, setStill] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const current = history[history.length - 1];
    const scene = graph.scenes.find((entry) => entry.id === current.id)!;
    const arrivals = useMemo(() => filmArrivals(graph, scene.id), [graph, scene.id]);
    useEffect(() => {
        if (scene.mode !== "ending") return;
        const decision = [...history].reverse().find((point) => point.routeKey);
        if (decision?.routeKey) onEnding?.(decision.routeKey, scene.id);
        else if (history[0].id === graph.start) onEnding?.(JSON.stringify(["linear", scene.id]), scene.id);
    }, [history, scene, graph.start, onEnding]);
    const take = takes[scene.id],
        episode = episodes.find((entry) => entry.id === take?.episodeId);
    const resource = scene.media?.kind === "clip" ? scene.media.resourceId : episode && !episode.finalStale && take?.script === scene.script ? episode.finalResourceId : undefined;
    const mediaVersion = demoMedia?.[scene.id] ? scene.track?.resourceId : resource;
    const items = [...new Set(graph.scenes.flatMap((entry) => entry.exits.map((exit) => exit.item).filter((item): item is string => !!item)))];
    const clues = graph.scenes.flatMap((entry) => entry.track?.cues?.filter((cue) => cue.kind === "hotspot") || []);
    const previousChoices = history
        .map((point, index) => ({ point, index }))
        .slice(0, -1)
        .filter(({ point }) => point.choice);
    function rewind(index: number) {
        setHistory([...history.slice(0, index), { ...history[index], decision: undefined }]);
        setGeneration((value) => value + 1);
    }
    function follow(edge: FilmExit, state: FilmState, at: number, timed?: boolean) {
        setHistory((previous) =>
            previous[previous.length - 1] !== current
                ? previous
                : [
                      ...previous.slice(0, -1),
                      { ...current, state, time: at, choice: scene.mode === "choice", decision: edge.label, routeKey: scene.mode === "choice" ? filmDecisionKey(scene.id, state.item, scene.exits.indexOf(edge), !!timed) : undefined },
                      { id: edge.target, state: takeFilmExit(state, edge), time: 0 },
                  ],
        );
    }
    function reset(checkpoint: Checkpoint) {
        setHistory([checkpoint]);
        setGeneration((value) => value + 1);
    }
    return (
        <section className="drama-scriptv-brief film-panel film-player" data-still={still}>
            <div className="drama-section-title">
                <h2>{scene.title}</h2>
                <div className="film-actions">
                    <Button ref={notebookButton} aria-haspopup="dialog" icon={<BookOpen size={15} />} onClick={() => setNotebook(true)}>
                        线索册
                    </Button>
                    <Button aria-pressed={analysis} onClick={() => setAnalysis(!analysis)}>
                        作者分析
                    </Button>
                </div>
            </div>
            <FilmNotebook
                graph={graph}
                history={history}
                open={notebook}
                onClose={() => {
                    setNotebook(false);
                    requestAnimationFrame(() => notebookButton.current?.focus({ preventScroll: true }));
                }}
            />
            {scene.media?.kind === "event" ? (
                <EventFrame key={`${generation}:${history.length}:${scene.id}`} scene={scene} exits={availableExits(scene, current.state.item)} onAction={(edge) => follow(edge, current.state, 0)} />
            ) : (
                <Playback
                    key={generation + ":" + history.length + ":" + current.id + ":" + textMode + ":" + (resource || "")}
                    checkpoint={current}
                    scene={scene}
                    sampleUrl={textMode ? undefined : demoMedia?.[scene.id]}
                    resource={textMode ? undefined : resource}
                    mediaVersion={mediaVersion}
                    wait={wait}
                    noTimer={noTimer}
                    suspended={notebook}
                    analysis={analysis}
                    onLocate={onLocate}
                    onInspect={(cue) =>
                        setHistory((previous) => {
                            const last = previous[previous.length - 1];
                            return [...previous.slice(0, -1), { ...last, state: inspectFilmCue(last.state, cue) }];
                        })
                    }
                    onExit={follow}
                />
            )}
            {scene.clue && current.state.clues.includes(scene.clue) && <p>{scene.response}</p>}
            {demoMedia?.[scene.id] && !textMode && <p className="film-caption">{scene.script}</p>}
            {scene.mode === "ending" && (
                <section className="film-panel">
                    <h3>我的故事线</h3>
                    <ol className="film-storyline">
                        {history.map((p, i) => (
                            <li key={i}>
                                <strong>{graph.scenes.find((s) => s.id === p.id)?.title}</strong>
                                {p.choice && (
                                    <Button type="link" size="small" onClick={() => rewind(i)}>
                                        回到 {Math.floor(p.time / 60000)}:{String(Math.floor(p.time / 1000) % 60).padStart(2, "0")} 重选 · {p.decision}
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ol>
                    {onAudit && <Button onClick={onAudit}>返回作品体检</Button>}
                </section>
            )}
            <div className="film-actions">
                <Checkbox checked={wait} onChange={(event) => setWait(event.target.checked)}>
                    等我查看热点
                </Checkbox>
                <Checkbox checked={still} onChange={(event) => setStill(event.target.checked)}>
                    静止热点
                </Checkbox>
                <Checkbox checked={noTimer} onChange={(event) => setNoTimer(event.target.checked)}>
                    关闭倒计时
                </Checkbox>
            </div>
            {analysis && (
                <div className="film-rule-inspector">
                    <Checkbox checked={textMode} onChange={(event) => setTextMode(event.target.checked)}>
                        以文字重演本场
                    </Checkbox>
                    {arrivals.length > 0 && (
                        <label>
                            从上游试演
                            <Select<number>
                                placeholder="选取来路"
                                value={undefined}
                                options={arrivals.map(({ from, item }, index) => ({ value: index, label: (graph.scenes.find((entry) => entry.id === from)?.title || from) + " · " + (item || "空手") }))}
                                onChange={(index) => reset({ id: scene.id, time: 0, state: { item: arrivals[index].item, clues: [] } })}
                            />
                        </label>
                    )}
                    <p>本轮路径　{history.map((point) => (graph.scenes.find((entry) => entry.id === point.id)?.title || point.id) + (point.decision ? "（" + point.decision + "）" : "")).join(" → ")}</p>
                    <label>
                        本场测试携带物
                        <Select value={current.state.item} options={["", ...items].map((item) => ({ value: item, label: item || "空手" }))} onChange={(item) => reset({ ...current, state: { ...current.state, item } })} />
                    </label>
                    <label>
                        已发现的线索
                        <Select mode="multiple" value={current.state.clues} options={clues.map((cue) => ({ value: cue.id, label: cue.label }))} onChange={(values) => reset({ ...current, state: { ...current.state, clues: values } })} />
                    </label>
                </div>
            )}
            <div className="film-actions">
                {previousChoices.map(({ point, index }) => (
                    <Button key={index} onClick={() => rewind(index)}>
                        重选 · {point.decision || point.id}
                    </Button>
                ))}
                <Button onClick={() => reset({ id: graph.start, state: emptyFilmState, time: 0 })}>从头试玩</Button>
            </div>
        </section>
    );
}

function Playback({
    scene,
    checkpoint,
    sampleUrl,
    resource,
    mediaVersion,
    wait,
    noTimer,
    suspended,
    analysis,
    onLocate,
    onInspect,
    onExit,
}: {
    scene: FilmScene;
    checkpoint: Checkpoint;
    sampleUrl?: string;
    resource?: string;
    mediaVersion?: string;
    wait: boolean;
    noTimer: boolean;
    suspended: boolean;
    analysis: boolean;
    onLocate?: PlayerProps["onLocate"];
    onInspect: (cue: FilmCue) => void;
    onExit: (exit: FilmExit, state: FilmState, at: number, timed?: boolean) => void;
}) {
    const video = useRef<HTMLVideoElement>(null);
    const committed = useRef(false);
    const resumeAfterNotebook = useRef(false);
    const handled = useRef(new Set<string>());
    const state = checkpoint.state;
    const resolved = useResourceMediaUrl(resource, "playback");
    const url = sampleUrl || resolved;
    const loading = !!resource && !url;
    const [failed, setFailed] = useState(false);
    const [duration, setDuration] = useState<number>();
    const [active, setActive] = useState<FilmCue>();
    const [finished, setFinished] = useState(false);
    const [pending, setPending] = useState<{ edge: FilmExit; timed: boolean }>();
    const [feedback, setFeedback] = useState("");
    const [paused, setPaused] = useState(false);
    const [remaining, setRemaining] = useState(0);
    const track = scene.track;
    const mismatch = track?.cues?.length && mediaVersion && mediaVersion !== track.resourceId;
    const problem = filmTrackIssue(scene, track, duration ?? track?.durationMs);
    const videoMode = !!url && !mismatch && !problem && !failed;
    const exits = availableExits(scene, state.item);
    const choice = track?.cues?.find((cue) => cue.kind === "choice");
    const mustInspect = track?.cues?.some((cue) => cue.kind === "hotspot" && (cue.wait || wait) && !state.clues.includes(cue.id));
    const optionsVisible = (!videoMode && (!loading || failed) && !mustInspect) || finished || active?.kind === "choice";
    const chooseRef = useRef<(edge: FilmExit, timed?: boolean) => void>(() => {});
    function choose(edge: FilmExit, timed = false) {
        if (committed.current) return;
        committed.current = true;
        if (videoMode && active?.kind === "choice" && active.tail && !finished) {
            setPending({ edge, timed });
            setActive(undefined);
            setFeedback("已选「" + edge.label + "」，片尾进入下一场");
            resume();
            return;
        }
        onExit(edge, state, active?.atMs ?? (videoMode ? Math.round((video.current?.currentTime || 0) * 1000) : choice?.atMs || 0), timed);
    }
    chooseRef.current = choose;
    useEffect(() => {
        if (suspended) {
            const el = video.current;
            if (el && !el.paused) {
                resumeAfterNotebook.current = true;
                el.pause();
            }
        } else if (resumeAfterNotebook.current) {
            resumeAfterNotebook.current = false;
            if (document.hidden) setPaused(true);
            else resume();
        }
    }, [suspended]);
    useEffect(() => {
        const onVisibility = () => {
            if (document.hidden && video.current && !video.current.paused) {
                video.current.pause();
                setPaused(true);
            }
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, []);
    useEffect(() => {
        if (!active?.timeoutMs || active.kind !== "choice" || noTimer || paused || suspended) return;
        let rest = remaining,
            prior = performance.now();
        const resetClock = () => {
            prior = performance.now();
        };
        document.addEventListener("visibilitychange", resetClock);
        const timer = window.setInterval(() => {
            const now = performance.now();
            if (!document.hidden) rest -= now - prior;
            prior = now;
            setRemaining(Math.max(0, rest));
            if (rest <= 0) {
                const edge = exits.find((entry) => entry.id === active.defaultExit);
                if (edge) chooseRef.current(edge, true);
            }
        }, 100);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", resetClock);
        };
    }, [active, noTimer, paused, suspended]);
    function resume() {
        if (suspended) {
            resumeAfterNotebook.current = true;
            return;
        }
        setPaused(false);
        void video.current?.play().catch(() => setPaused(true));
    }
    function tick(milliseconds: number) {
        if (committed.current || active?.kind === "choice") return true;
        const cue = track?.cues?.find((entry) => !handled.current.has(entry.id) && milliseconds >= entry.atMs && (entry.kind === "choice" || milliseconds < entry.endMs! || entry.wait || wait));
        if (!cue) {
            if (active) setActive(undefined);
            return false;
        }
        if (active?.id === cue.id) return !!(cue.wait || wait);
        setFeedback("");
        setActive(cue);
        if (cue.kind === "choice" || cue.wait || wait) {
            video.current?.pause();
            if (video.current) video.current.currentTime = cue.atMs / 1000;
        }
        if (cue.kind === "choice") {
            setRemaining(cue.timeoutMs || 0);
            setPaused(false);
        }
        return cue.kind === "choice" || cue.wait || wait;
    }
    function inspect(cue: FilmCue) {
        if (handled.current.has(cue.id)) return;
        handled.current.add(cue.id);
        onInspect(cue);
        setFeedback(cue.feedback || cue.label || "已查看");
        setActive(undefined);
        if (videoMode) resume();
    }
    const controls = (
        <div className="film-actions">
            {optionsVisible && !pending && choice?.question?.trim() && <strong className="film-choice-question">{choice.question}</strong>}
            {optionsVisible &&
                !pending &&
                (scene.mode === "ending" ? (
                    <strong>已抵达结局</strong>
                ) : (
                    exits.map((exit, index) => (
                        <Button key={exit.id || index} onClick={() => choose(exit)}>
                            {exit.label || "继续"}
                        </Button>
                    ))
                ))}
            {active?.kind === "choice" && !!active.timeoutMs && !noTimer && (
                <Button onClick={() => setPaused(!paused)}>
                    {paused ? "恢复" : "暂停"}倒计时 · {Math.ceil(remaining / 1000)} 秒
                </Button>
            )}
        </div>
    );
    return (
        <>
            {!!(mismatch || problem || failed) && <Alert type="warning" title={(problem || (failed ? "视频加载失败" : "成片版本已更新，请复核互动轨")) + " · 当前为文字试玩"} />}
            {videoMode ? (
                <>
                    <div className="film-interactive-monitor">
                        <video
                            ref={video}
                            src={url}
                            playsInline
                            preload="auto"
                            onLoadedMetadata={(event) => {
                                const element = event.currentTarget;
                                setDuration(Math.round(element.duration * 1000));
                                element.currentTime = Math.min(checkpoint.time / 1000, element.duration);
                                for (const cue of track?.cues || []) if (cue.kind === "hotspot" && (cue.endMs! <= checkpoint.time || checkpoint.state.clues.includes(cue.id))) handled.current.add(cue.id);
                                if (checkpoint.choice && !choice) {
                                    setFinished(true);
                                    return;
                                }
                                if (!tick(checkpoint.time)) resume();
                            }}
                            onTimeUpdate={(event) => tick(Math.round(event.currentTarget.currentTime * 1000))}
                            onError={() => {
                                if (pending) {
                                    onExit(pending.edge, state, choice?.atMs || 0, pending.timed);
                                    return;
                                }
                                setFailed(true);
                                setActive(undefined);
                            }}
                            onEnded={() => {
                                if (pending) {
                                    onExit(pending.edge, state, choice?.atMs || 0, pending.timed);
                                    return;
                                }
                                if (scene.mode === "next" && exits[0]) choose(exits[0]);
                                else setFinished(true);
                            }}
                        />
                        {active?.kind === "hotspot" && (
                            <>
                                <div className="film-hotspot-veil" />
                                <button type="button" className="film-cue-marker" style={{ left: (active.x ?? 0) + "%", top: (active.y ?? 0) + "%" }} onClick={() => inspect(active)}>
                                    {active.label}
                                </button>
                            </>
                        )}
                        {optionsVisible && <div className="film-choice-overlay">{controls}</div>}
                    </div>
                    {!optionsVisible && (!active || !(wait || active.wait)) && (
                        <Button
                            onClick={() => {
                                if (video.current?.paused) resume();
                                else {
                                    video.current?.pause();
                                    setPaused(true);
                                }
                            }}
                        >
                            {paused ? "继续播放" : "暂停播放"}
                        </Button>
                    )}
                </>
            ) : (
                <>
                    <p className="film-script">{scene.script}</p>
                    {loading && !failed ? (
                        <Button onClick={() => setFailed(true)}>使用文字试玩</Button>
                    ) : (
                        <>
                            {track?.cues
                                ?.filter((cue) => cue.kind === "hotspot" && !state.clues.includes(cue.id))
                                .map((cue) => (
                                    <Button key={cue.id} onClick={() => inspect(cue)}>
                                        {cue.label}
                                    </Button>
                                ))}
                            {controls}
                        </>
                    )}
                </>
            )}
            {feedback && <p role="status">{feedback}</p>}
            {analysis && (
                <div className="film-rule-inspector">
                    <p>
                        当前携带：{state.item || "空手"}　已发现 {state.clues.length} 条线索
                    </p>
                    {scene.exits
                        .filter((exit) => !exits.includes(exit))
                        .map((exit, index) => (
                            <p key={index}>
                                隐藏「{exit.label}」：需要持有{exit.requiresItem}
                            </p>
                        ))}
                    {!exits.length && scene.mode !== "ending" && <p>此测试初态没有可用出口</p>}
                    {onLocate && <Button onClick={() => onLocate(scene.id, videoMode ? Math.round((video.current?.currentTime || 0) * 1000) : undefined)}>回到本场编辑</Button>}
                </div>
            )}
        </>
    );
}
