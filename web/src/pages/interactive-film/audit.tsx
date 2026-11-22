import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Checkbox, Segmented } from "antd";
import { ClipboardCheck, Film, GitBranch, Play } from "lucide-react";
import localforage from "localforage";
import type { InteractiveFilm } from "@/services/api/interactive-films";
import type { DramaEpisodeRow } from "@/services/api/drama";
import { filmGraphIssue } from "@/lib/interactive-film";
import { filmRouteCases, type FilmCheckpoint } from "@/lib/film-audit";
import { FilmPlayer } from "./studio-player";

const records = localforage.createInstance({ name: "yingce-film-audit", storeName: "played" });
type Props = {
    film: InteractiveFilm;
    owner: string;
    episodes: DramaEpisodeRow[];
    demoMedia?: Record<string, string>;
    sampleRecords?: Set<string>;
    onLocate: (scene: string, time: number) => void;
    onBack: () => void;
    initialPlay?: string;
    onPlaying?: (playing: boolean) => void;
};

export function FilmAudit(props: Props) {
    const { film, episodes, demoMedia, owner } = props;
    const byEpisode = new Map(episodes.map((e) => [e.id, e]));
    const media = film.graph.scenes.map((s) => {
        if (s.media) return s.media.resourceId || "";
        const take = film.takes[s.id],
            ep = byEpisode.get(take?.episodeId);
        return demoMedia?.[s.id] ? "sample-" + s.id : take?.script === s.script && !ep?.finalStale ? ep?.finalResourceId || "" : "";
    });
    const scope = JSON.stringify([owner, film.id, film.revision, media]);
    return <AuditVersion key={scope} {...props} scope={scope} media={media} />;
}

function AuditVersion({ film, episodes, demoMedia, sampleRecords, initialPlay, scope, media, onLocate, onBack, onPlaying }: Props & { scope: string; media: string[] }) {
    const { graph } = film,
        cases = useMemo(() => filmRouteCases(graph), [graph]),
        issue = filmGraphIssue(graph);
    const nodes = new Map(graph.scenes.map((s) => [s.id, s]));
    const [filter, setFilter] = useState("全部"),
        [selected, setSelected] = useState(""),
        [played, setPlayed] = useState<Set<string>>(() => new Set(cases.filter((route) => sampleRecords?.has(route.key)).map((route) => route.key))),
        [error, setError] = useState(""),
        [clues, setClues] = useState<string[]>([]);
    const [run, setRun] = useState<{ history?: FilmCheckpoint[]; start?: string } | null>(initialPlay && !issue ? { start: nodes.has(initialPlay) ? initialPlay : graph.start } : null);
    const isPlaying = !!run;
    useEffect(() => {
        onPlaying?.(isPlaying);
        return () => onPlaying?.(false);
    }, [isPlaying, onPlaying]);
    useEffect(() => {
        if (sampleRecords) return;
        let active = true;
        Promise.all(cases.map(async (r) => ((await records.getItem(scope + r.key)) ? r.key : "")))
            .then((keys) => {
                if (active) setPlayed((old) => new Set([...old, ...keys.filter(Boolean)]));
            })
            .catch(() => {
                if (active) setError("读取本机试玩记录失败");
            });
        return () => {
            active = false;
        };
    }, [scope, cases, sampleRecords]);
    const record = useCallback(
        (key: string, ending: string) => {
            if (!cases.some((r) => r.key === key && r.ending === ending)) return;
            setSelected(key);
            setFilter("全部");
            setPlayed((old) => (old.has(key) ? old : new Set([...old, key])));
            if (sampleRecords) sampleRecords.add(key);
            else void records.setItem(scope + key, true).catch(() => setError("试玩记录仅在本次打开期间保留，本机存储失败"));
        },
        [cases, scope, sampleRecords],
    );
    const visible = cases.filter((r) => filter === "全部" || played.has(r.key) === (filter === "已试玩")),
        current = visible.find((r) => r.key === selected) || visible[0];
    const last = current?.history.at(-1),
        source = last && nodes.get(last.id);
    const priorClues =
        current?.history.flatMap(
            (p, index) =>
                nodes
                    .get(p.id)
                    ?.track?.cues.filter((c) => c.kind === "hotspot" && c.atMs <= p.time)
                    .map((c) => ({ cue: c, index })) || [],
        ) || [];
    const problems = graph.scenes.flatMap((s, i) => {
        if (s.media?.kind === "event") return [];
        const cues = s.track?.cues || [];
        if (media[i] && (!cues.length || s.track?.resourceId === media[i])) return [];
        return [{ scene: s, time: cues[0]?.atMs || 0, needsReview: !!media[i], label: media[i] ? "成片已换版，需复核互动轨" : "待制作有效成片" }];
    });
    function audition() {
        if (!current) return;
        setRun({ history: current.history.map((p, i) => ({ ...p, state: { ...p.state, clues: priorClues.filter((c) => c.index <= i && clues.includes(c.cue.id)).map((c) => c.cue.id) } })) });
    }
    if (run)
        return (
            <main className="drama-main film-audit">
                <div className="drama-ep-header">
                    <h2>互动试玩</h2>
                    <Button onClick={() => setRun(null)}>退出试玩</Button>
                </div>
                <div className="film-audit-scroll">
                    <FilmPlayer graph={graph} takes={film.takes} episodes={episodes} demoMedia={demoMedia} start={run.start} initialHistory={run.history} onEnding={record} onAudit={() => setRun(null)} onLocate={(id, t) => onLocate(id, t || 0)} />
                </div>
            </main>
        );
    const endings = graph.scenes.filter((s) => s.mode === "ending").length;
    return (
        <main className="drama-main film-audit">
            <div className="drama-ep-header">
                <div className="drama-ep-heading">
                    <div className="drama-eyebrow">{film.title} · 当前版本</div>
                    <h2>作品体检</h2>
                    <p>
                        {graph.scenes.length} 个场次 · {endings} 个结局
                    </p>
                </div>
                <Button onClick={onBack}>返回制作</Button>
            </div>
            <div className="film-audit-scroll">
                {issue && <Alert showIcon type="warning" title={issue} />} {error && <Alert showIcon type="warning" title={error} />}
                <div className="film-audit-stats">
                    {[
                        ["规则可达结局", `${new Set(cases.map((r) => r.ending)).size} / ${endings}`],
                        ["已试玩路线", `${played.size} / ${cases.length}`],
                        ["成片待复核", problems.filter((p) => p.needsReview).length],
                    ].map(([label, value]) => (
                        <div key={label}>
                            <small>{label}</small>
                            <strong>{value}</strong>
                        </div>
                    ))}
                </div>
                <section className="drama-scriptv-brief film-panel">
                    <div className="drama-section-title">
                        <h2>
                            <GitBranch size={15} /> 路线检查
                        </h2>
                        <Button size="small" disabled={!!issue} onClick={() => setRun({ start: graph.start })}>
                            从头试玩
                        </Button>
                    </div>
                    <div className="film-audit-grid">
                        <div className="film-audit-list">
                            <Segmented
                                size="small"
                                value={filter}
                                options={["全部", "待试玩", "已试玩"].map((value, i) => ({ value, label: `${value} ${[cases.length, cases.length - played.size, played.size][i]}` }))}
                                onChange={(v) => setFilter(String(v))}
                            />
                            {visible.map((r) => {
                                const entry = r.history.at(-1)!;
                                return (
                                    <button
                                        className="film-audit-row"
                                        key={r.key}
                                        aria-pressed={r === current}
                                        onClick={() => {
                                            setSelected(r.key);
                                            setClues([]);
                                        }}
                                    >
                                        <span>
                                            <strong>
                                                {entry.state.item || nodes.get(entry.id)?.title} → {nodes.get(r.ending)?.title}
                                            </strong>
                                            <small>
                                                {r.label} · {r.timed ? "超时默认" : "主动或续播"}
                                            </small>
                                        </span>
                                        <span className={"drama-chip " + (played.has(r.key) ? "is-completed" : "")}>{played.has(r.key) ? "已试玩" : "待试玩"}</span>
                                    </button>
                                );
                            })}
                            {!visible.length && <p>当前分组没有路线。</p>}
                        </div>
                        {current && source && (
                            <div className="film-audit-detail">
                                <small>来路试演 · {source.id}</small>
                                <h3>
                                    {source.title} → {nodes.get(current.ending)?.title}
                                </h3>
                                <p>{current.history.map((p) => nodes.get(p.id)?.title).join(" → ")}</p>
                                <span>
                                    {current.timed ? "等候超时默认选择" : "预期行动"} · {current.label}
                                </span>
                                {priorClues.map(({ cue }) => (
                                    <Checkbox key={cue.id} checked={clues.includes(cue.id)} onChange={(e) => setClues((old) => (e.target.checked ? [...old, cue.id] : old.filter((id) => id !== cue.id)))}>
                                        带入「{cue.label}」线索
                                    </Checkbox>
                                ))}
                                <Button type="primary" icon={<Play size={14} />} disabled={!!issue} onClick={audition}>
                                    {source.track?.cues.some((c) => c.kind === "choice") ? "从选择点前 2 秒试演" : "从本场试演"}
                                </Button>
                            </div>
                        )}
                    </div>
                </section>
                <section className="drama-scriptv-brief film-panel">
                    <div className="drama-section-title">
                        <h2>
                            <Film size={15} /> 成片复核
                        </h2>
                    </div>
                    {problems.length ? (
                        problems.map((p) => (
                            <div className="film-bar" key={p.scene.id}>
                                <span>
                                    {p.scene.title} · {p.label}
                                </span>
                                <Button size="small" onClick={() => onLocate(p.scene.id, p.time)}>
                                    {p.needsReview ? "定位到互动轨" : "打开本场成片"}
                                </Button>
                            </div>
                        ))
                    ) : (
                        <span>
                            <ClipboardCheck size={14} /> 当前版本没有待复核成片。
                        </span>
                    )}
                </section>
                <small>{sampleRecords ? "样片试玩记录在本次打开期间保留。" : "试玩记录保存在当前浏览器，按账号和作品版本隔离。"}</small>
            </div>
        </main>
    );
}
