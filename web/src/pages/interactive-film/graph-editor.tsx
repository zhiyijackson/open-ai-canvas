import { SceneMap } from "./scene-map";
import { useMemo, useRef, useState } from "react";
import { ExitEditor } from "./exit-editor";
import { filmEditorIssues } from "@/lib/film-editor-issues";
import { NodeMediaEditor, EventActionEditor } from "./node-media";
import { AppModal } from "@/components/ui/product/app-modal";
import { filmSceneResource, insertFilmNode, newFilmMediaNode } from "@/lib/interactive-film";
import type { DramaEpisodeRow } from "@/services/api/drama";
import { filmConnectionTargets, filmSceneLabels } from "@/lib/film-interactions";
import { ItemNameInput } from "./item-name-input";
import { FilmPlayer } from "./studio-player";
import type { FilmCheckpoint } from "@/lib/film-audit";
import { useSceneRehearsal } from "./use-scene-rehearsal";
import { Button, Input, InputNumber, Select } from "antd";
import { GitBranch, Plus, Trash2 } from "lucide-react";
import { WorkspaceState } from "@/components/layout/workspace-state";
import { nanoid } from "nanoid";
import type { FilmGraph, FilmScene, InteractiveFilm } from "@/services/api/interactive-films";

export function GraphEditor({
    graph,
    takes,
    manual = false,
    selected,
    onSelect,
    onChange,
    projectId,
    episodes,
    initialInsert,
    uploadingNodes,
    onUpload,
    episodeId,
    onOpenTrack,
}: {
    graph: FilmGraph;
    takes: InteractiveFilm["takes"];
    manual?: boolean;
    selected: string;
    onSelect: (id: string) => void;
    onChange: (graph: FilmGraph) => void;
    projectId?: string;
    episodes: DramaEpisodeRow[];
    initialInsert: string | null;
    uploadingNodes: string[];
    onUpload: (scene: FilmScene, file: File, exitIndex?: number) => void;
    episodeId?: string;
    onOpenTrack?: (id: string) => void;
}) {
    const scene = graph.scenes.find((s) => s.id === selected) || graph.scenes[0];
    const uploading = !!scene && uploadingNodes.includes(scene.id);
    const [insertion, setInsertion] = useState<number | null>(() => (initialInsert !== null && scene?.exits[Number(initialInsert)] ? Number(initialInsert) : null));
    const event = scene?.media?.kind === "event";
    const [editing, setEditing] = useState<number | null>(null);
    const [related, setRelated] = useState(false),
        [fit, setFit] = useState(false),
        [checking, setChecking] = useState(false),
        [deleting, setDeleting] = useState(false);
    const [notice, setNotice] = useState("");
    const [audition, setAudition] = useState<FilmCheckpoint[]>();
    const rehearsal = useSceneRehearsal(graph, scene?.id, 0, "本场试玩来路");
    const { arrival, arrivals } = rehearsal;
    const panel = useRef<HTMLElement>(null);
    const targets = useMemo(() => filmConnectionTargets(graph, scene?.id || ""), [graph, scene?.id]);
    const issues = useMemo(() => (checking ? filmEditorIssues(graph, (s) => filmSceneResource(s, takes, episodes)) : []), [checking, graph, takes, episodes]);
    function editExit(id: string, index: number) {
        onSelect(id);
        setEditing(index);
    }
    function closeExit() {
        setEditing(null);
        requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>(`.film-map-exit[data-scene="${CSS.escape(scene.id)}"][data-exit="${editing}"]`)?.focus({ preventScroll: true }));
    }
    function connect(id: string, index: number, target: string) {
        if (!filmConnectionTargets(graph, id).some((s) => s.id === target)) {
            setNotice(id === target ? "无法连接到本场。" : "这条连接会形成回环。");
            return;
        }
        onChange({ ...graph, scenes: graph.scenes.map((s) => (s.id === id ? { ...s, exits: s.exits.map((e, i) => (index === i ? { ...e, id: e.id || nanoid(), target } : e)) } : s)) });
        onSelect(id);
        setNotice("已更新出口去向。");
    }
    function insert(kind: "event" | "clip", index = insertion, source = graph) {
        if (index === null) return;
        const id = "s_" + nanoid(9);
        const updated = insertFilmNode(source, scene.id, index, id, kind);
        setInsertion(null);
        if (updated !== source) {
            setEditing(null);
            onChange(updated);
            onSelect(id);
        }
    }
    const labels = useMemo(() => filmSceneLabels(graph), [graph]);
    const options = graph.scenes.map((s) => ({ value: s.id, label: labels.get(s.id) }));
    function change(patch: Partial<FilmScene>) {
        onChange({ ...graph, scenes: graph.scenes.map((s) => (s.id === scene?.id ? { ...s, ...patch } : s)) });
    }
    function add(kind?: "event" | "clip") {
        const id = "s_" + nanoid(9);
        const node: FilmScene = kind ? newFilmMediaNode(id, kind) : { id, title: "新场次", script: "", source: "", mode: "ending", exits: [] };
        onChange({ start: graph.start || id, scenes: [...graph.scenes, node] });
        onSelect(id);
    }
    function remove() {
        if (!scene) return;
        const successor = scene.media && scene.mode === "next" ? scene.exits[0]?.target || "" : "";
        const scenes = graph.scenes
            .filter((s) => s.id !== scene.id)
            .map((s): FilmScene => {
                if (!s.exits.some((e) => e.target === scene.id)) return s;
                return { ...s, exits: s.exits.map((e) => (e.target === scene.id ? { ...e, target: successor } : e)) };
            });
        const start = graph.start === scene.id ? successor || scenes[0]?.id || "" : graph.start;
        onChange({ start, scenes });
        onSelect(start);
    }
    function setMode(mode: FilmScene["mode"]) {
        const blank = { label: "", target: "" };
        const track = scene.track && mode !== "choice" ? { ...scene.track, cues: scene.track.cues.filter((c) => c.kind !== "choice") } : scene.track;
        change({ mode, track, exits: mode === "ending" ? [] : mode === "next" ? [scene.exits[0] || blank] : [scene.exits[0] || blank, scene.exits[1] || blank, ...scene.exits.slice(2)] });
    }
    return (
        <section ref={panel} className="drama-scriptv-brief film-panel">
            <div className="drama-section-title">
                <h2>
                    <GitBranch className="size-4" />
                    剧情图
                </h2>
                {manual ? (
                    <div className="film-actions">
                        {(
                            [
                                ["clip", "添加视频"],
                                ["event", "添加事件"],
                            ] as const
                        ).map(([kind, label]) => (
                            <Button key={kind} size="small" disabled={graph.scenes.length >= 300} onClick={() => add(kind)} icon={<Plus size={15} />}>
                                {label}
                            </Button>
                        ))}
                    </div>
                ) : (
                    <Button size="small" disabled={graph.scenes.length >= 300} onClick={() => add()} icon={<Plus size={15} />}>
                        添加场次
                    </Button>
                )}
            </div>
            {graph.scenes.length === 0 ? (
                <WorkspaceState compact icon="projects" title={manual ? "添加第一个节点" : "还没有场次"} description={manual ? "从视频或互动事件开始，第一个节点将成为故事入口。" : "确认改编方向后生成剧情图，也可以手动添加第一个场次。"} />
            ) : (
                <>
                    <label>
                        入口场次
                        <Select aria-label="入口场次" value={graph.start || undefined} options={options} onChange={(start) => onChange({ ...graph, start })} />
                    </label>
                    <div className="film-actions">
                        <Button size="small" aria-pressed={checking} onClick={() => setChecking(!checking)}>
                            检查剧情图
                        </Button>
                        <Button size="small" aria-pressed={related} onClick={() => setRelated(!related)}>
                            仅相关连线
                        </Button>
                        <Button size="small" aria-pressed={fit} onClick={() => setFit(!fit)}>
                            适合屏幕
                        </Button>
                    </div>
                    {checking && (
                        <div className="film-graph-issues" aria-live="polite">
                            {issues.length
                                ? issues.map((issue, i) => (
                                      <button
                                          type="button"
                                          key={i}
                                          onClick={() => {
                                              if (issue.track && onOpenTrack) onOpenTrack(issue.scene);
                                              else if (issue.exit !== undefined) editExit(issue.scene, issue.exit);
                                              else {
                                                  onSelect(issue.scene);
                                                  requestAnimationFrame(() => panel.current?.querySelector(".film-scene")?.scrollIntoView({ block: "nearest" }));
                                              }
                                          }}
                                      >
                                          {graph.scenes.find((s) => s.id === issue.scene)?.title} · {issue.exit !== undefined && `${graph.scenes.find((s) => s.id === issue.scene)?.exits[issue.exit]?.label || `出口 ${issue.exit + 1}`} · `}
                                          {issue.message}
                                      </button>
                                  ))
                                : "剧情图检查通过"}
                        </div>
                    )}
                    <SceneMap
                        graph={graph}
                        selected={scene?.id || ""}
                        onSelect={onSelect}
                        onEditExit={editExit}
                        onConnect={connect}
                        fit={fit}
                        related={related}
                        thumbnail={(id) => {
                            const s = graph.scenes.find((s) => s.id === id);
                            return s && filmSceneResource(s, takes, episodes);
                        }}
                    />
                    {notice && <small role="status">{notice}</small>}
                </>
            )}
            {scene && (
                <div className="film-scene">
                    <div className="drama-section-title">
                        <h3>{event ? "互动事件" : scene.media ? "视频片段" : "场次剧本"}</h3>
                        <Button size="small" danger type="text" disabled={uploading} onClick={() => setDeleting(true)} icon={<Trash2 size={15} />}>
                            移除场次
                        </Button>
                    </div>
                    <div className="film-actions">
                        {rehearsal.controls}
                        <Button disabled={!arrival} onClick={() => setAudition(rehearsal.history)}>
                            从这里试玩
                        </Button>
                        {!arrival && <small>从入口无法到达本场</small>}
                    </div>
                    <label>
                        {scene.media ? "节点名称" : "场名"}
                        <Input value={scene.title} maxLength={60} onChange={(e) => change({ title: e.target.value })} />
                    </label>
                    {!manual && (
                        <label>
                            原著出处
                            <Input value={scene.source} onChange={(e) => change({ source: e.target.value })} />
                        </label>
                    )}
                    <label>
                        {event ? "给观众的提示" : "动作与对白"}
                        <Input.TextArea value={scene.script} autoSize={{ minRows: 4, maxRows: 14 }} onChange={(e) => change({ script: e.target.value })} />
                    </label>
                    {scene.media ? (
                        <>
                            <NodeMediaEditor
                                key={scene.id}
                                scene={scene}
                                projectId={projectId}
                                episodes={episodes}
                                initialEpisode={episodeId}
                                loading={uploading}
                                onUpload={(file) => onUpload(scene, file)}
                                onMedia={(resourceId) => change({ media: { ...scene.media!, resourceId } })}
                                onPosition={(index, x, y) => change({ exits: scene.exits.map((edge, i) => (i === index && edge.spot ? { ...edge, spot: { ...edge.spot, x, y } } : edge)) })}
                            />
                            {event && (
                                <label>
                                    画内选项样式
                                    <Select
                                        value={scene.media.presentation || (scene.exits.some((e) => e.spot) ? "spots" : "text")}
                                        options={[
                                            { value: "text", label: "画内文字" },
                                            { value: "spots", label: "物件热点" },
                                        ]}
                                        onChange={(presentation) =>
                                            change({
                                                media: { ...scene.media!, presentation },
                                                exits: presentation === "spots" ? scene.exits.map((e, i) => ({ ...e, spot: e.spot || { x: Math.round((100 * (i + 1)) / (scene.exits.length + 1)), y: 65 } })) : scene.exits,
                                            })
                                        }
                                    />
                                </label>
                            )}
                            {event && scene.mode === "next" && (
                                <label>
                                    自动继续（秒，0 为等候点击）
                                    <InputNumber min={0} max={3600} value={(scene.media.advanceMs || 0) / 1000} onChange={(v) => change({ media: { ...scene.media!, advanceMs: Math.round((v || 0) * 1000) } })} />
                                </label>
                            )}
                            {scene.media.kind === "clip" && (
                                <Button disabled={uploading} onClick={() => change({ media: undefined })}>
                                    改用整场分镜制作
                                </Button>
                            )}
                        </>
                    ) : (
                        !scene.track?.cues.length && <Button onClick={() => change({ media: { kind: "clip" }, track: undefined })}>使用单个分镜视频</Button>
                    )}
                    <details>
                        <summary>上游前情与线索回应</summary>
                        <p>各条来路在本场看到同一份剧本。当前可达的携带状态如下。</p>
                        {arrivals.map((entry) => (
                            <p key={JSON.stringify(entry)}>
                                {labels.get(entry.from) || "入口"} → {entry.item || "空手"}
                            </p>
                        ))}
                        {graph.scenes
                            .filter((entry) => entry.exits.some((exit) => exit.target === scene.id))
                            .map((entry) => (
                                <p key={entry.id}>
                                    <strong>{labels.get(entry.id)}</strong>　{entry.script}
                                </p>
                            ))}
                        <label>
                            发现线索后{" "}
                            <Select
                                allowClear
                                placeholder="选择热点"
                                value={scene.clue || undefined}
                                onChange={(clue) => change({ clue })}
                                options={graph.scenes.flatMap((entry) => (entry.track?.cues || []).filter((cue) => cue.kind === "hotspot").map((cue) => ({ value: cue.id, label: labels.get(entry.id) + " · " + cue.label })))}
                            />
                        </label>
                        {scene.clue && <Input aria-label="线索回应" placeholder="角色的补充回应" value={scene.response || ""} onChange={(event) => change({ response: event.target.value })} />}
                    </details>
                    <label>
                        {event ? "互动后" : "播完后"}
                        <Select
                            value={scene.mode}
                            onChange={setMode}
                            options={[
                                { value: "ending", label: "抵达结局" },
                                { value: "next", label: event ? "点击后继续" : "自动续播" },
                                { value: "choice", label: "让观众选择" },
                            ]}
                        />
                    </label>
                    {scene.exits.map((edge, i) => (
                        <div className="film-exit" key={i}>
                            {(event || scene.mode === "choice") && (
                                <Input aria-label={`选项 ${i + 1} 文案`} placeholder="选项文案" value={edge.label} onChange={(e) => change({ exits: scene.exits.map((v, j) => (j === i ? { ...v, label: e.target.value } : v)) })} />
                            )}
                            <Select
                                aria-label={`出口 ${i + 1} 目标`}
                                placeholder="选择目标场次"
                                value={edge.target || undefined}
                                options={targets.map((s) => ({ value: s.id, label: labels.get(s.id) }))}
                                onChange={(target) => change({ exits: scene.exits.map((v, j) => (j === i ? { ...v, target } : v)) })}
                            />
                            <Button size="small" disabled={graph.scenes.length >= 300} onClick={() => setInsertion(i)}>
                                {edge.target ? "插入节点" : "新建并连接"}
                            </Button>
                            {event && (
                                <EventActionEditor
                                    loading={uploading}
                                    onUpload={(file) => onUpload(scene, file, i)}
                                    edge={edge}
                                    onChange={(patch) => change({ exits: scene.exits.map((entry, j) => (j === i ? { ...entry, id: entry.id || nanoid(), ...patch } : entry)) })}
                                />
                            )}
                            {scene.mode === "choice" && scene.exits.length > 2 && (
                                <Button aria-label="移除选项" onClick={() => change({ exits: scene.exits.filter((_, j) => j !== i) })}>
                                    ×
                                </Button>
                            )}
                            <details>
                                <summary>携带条件与效果</summary>
                                {(["requiresItem", "item"] as const).map((field) => (
                                    <label key={field}>
                                        {field === "item" ? "选择后携带" : "需要持有"}
                                        <ItemNameInput
                                            placeholder={field === "item" ? "保留当前物件" : "所有玩家可选"}
                                            value={edge[field] || ""}
                                            onChange={(name) => change({ exits: scene.exits.map((entry, index) => (index === i ? { ...entry, [field]: name } : entry)) })}
                                        />
                                    </label>
                                ))}
                            </details>
                        </div>
                    ))}
                    {scene.mode === "choice" && scene.exits.length < 32 && <Button onClick={() => change({ exits: [...scene.exits, { label: "", target: "" }] })}>添加选项</Button>}
                    {scene.mode === "ending" && (
                        <Button disabled={graph.scenes.length >= 300} onClick={() => setInsertion(-1)}>
                            在结尾后添加节点
                        </Button>
                    )}
                </div>
            )}
            {audition && (
                <AppModal open title={`从这里试玩 · ${scene.title}`} width={820} onCancel={() => setAudition(undefined)} footer={<Button onClick={() => setAudition(undefined)}>返回场次</Button>}>
                    <FilmPlayer graph={graph} episodes={episodes} takes={takes} initialHistory={audition} />
                </AppModal>
            )}
            <AppModal open={insertion !== null} title="插入剧情节点" footer={null} onCancel={() => setInsertion(null)}>
                <p>
                    {scene?.title} → {graph.scenes.find((s) => s.id === scene?.exits[insertion ?? -1]?.target)?.title || "结尾"}
                </p>
                <div className="film-actions">
                    <Button onClick={() => insert("event")}>插入互动事件</Button>
                    <Button onClick={() => insert("clip")}>插入视频片段</Button>
                </div>
            </AppModal>
            {scene && editing !== null && scene.exits[editing] && (
                <ExitEditor
                    key={`${scene.id}:${editing}`}
                    scene={scene}
                    index={editing}
                    graph={graph}
                    takes={takes}
                    episodes={episodes}
                    onApply={change}
                    onClose={closeExit}
                    onOpenTrack={onOpenTrack && (() => onOpenTrack(scene.id))}
                    onInsert={(updated, kind) => insert(kind, editing, { ...graph, scenes: graph.scenes.map((entry) => (entry.id === updated.id ? updated : entry)) })}
                />
            )}
            <AppModal
                open={deleting}
                title={`移除「${scene?.title}」？`}
                okText="移除场次"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onCancel={() => setDeleting(false)}
                onOk={() => {
                    remove();
                    setDeleting(false);
                }}
            >
                <p>{scene?.media && scene.mode === "next" && scene.exits[0]?.target ? "下列出口将接到本场的续播目标。" : "下列出口将变为待连接，保留文案、热点和携带规则。"}</p>
                <ul>
                    {graph.scenes.flatMap((s) =>
                        s.exits.map((e, i) =>
                            e.target === scene?.id ? (
                                <li key={`${s.id}:${i}`}>
                                    {s.title} · {e.label || "继续"}
                                </li>
                            ) : null,
                        ),
                    )}
                </ul>
            </AppModal>
        </section>
    );
}
