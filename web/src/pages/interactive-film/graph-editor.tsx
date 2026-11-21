import { SceneMap } from "./scene-map";
import { useState } from "react";
import { NodeMediaEditor, EventActionEditor } from "./node-media";
import { AppModal } from "@/components/ui/product/app-modal";
import { insertFilmNode } from "@/lib/interactive-film";
import type { DramaEpisodeRow } from "@/services/api/drama";
import { filmArrivals } from "@/lib/film-interactions";
import { Button, Input, Select } from "antd";
import { GitBranch, Plus, Trash2 } from "lucide-react";
import { WorkspaceState } from "@/components/layout/workspace-state";
import { nanoid } from "nanoid";
import type { FilmGraph, FilmScene } from "@/services/api/interactive-films";

export function GraphEditor({
    graph,
    selected,
    onSelect,
    onChange,
    projectId,
    episodes,
    initialInsert,
    uploadingNodes,
    onUpload,
    episodeId,
}: {
    graph: FilmGraph;
    selected: string;
    onSelect: (id: string) => void;
    onChange: (graph: FilmGraph) => void;
    projectId?: string;
    episodes: DramaEpisodeRow[];
    initialInsert: string | null;
    uploadingNodes: string[];
    onUpload: (scene: FilmScene, file: File) => void;
    episodeId?: string;
}) {
    const scene = graph.scenes.find((s) => s.id === selected) || graph.scenes[0];
    const uploading = !!scene && uploadingNodes.includes(scene.id);
    const [insertion, setInsertion] = useState<number | null>(() => (initialInsert !== null && scene?.exits[Number(initialInsert)] ? Number(initialInsert) : null));
    const event = scene?.media?.kind === "event";
    function insert(kind: "event" | "clip") {
        if (insertion === null) return;
        const id = "s_" + nanoid(9);
        const updated = insertFilmNode(graph, scene.id, insertion, id, kind);
        setInsertion(null);
        if (updated !== graph) {
            onChange(updated);
            onSelect(id);
        }
    }
    const options = graph.scenes.map((s) => ({ value: s.id, label: s.title || s.id }));
    function change(patch: Partial<FilmScene>) {
        onChange({ ...graph, scenes: graph.scenes.map((s) => (s.id === scene?.id ? { ...s, ...patch } : s)) });
    }
    function add() {
        const id = "s_" + nanoid(9);
        onChange({ start: graph.start || id, scenes: [...graph.scenes, { id, title: "新场次", script: "", source: "", mode: "ending", exits: [] }] });
        onSelect(id);
    }
    function remove() {
        if (!scene) return;
        const successor = scene.media && scene.mode === "next" ? scene.exits[0]?.target || "" : "";
        const scenes = graph.scenes
            .filter((s) => s.id !== scene.id)
            .map((s): FilmScene => {
                if (!s.exits.some((e) => e.target === scene.id)) return s;
                if (scene.media && scene.mode === "ending" && s.mode === "next" && !s.track?.cues.some((cue) => cue.kind === "choice")) return { ...s, mode: "ending", exits: [] };
                return { ...s, exits: s.exits.map((e) => (e.target === scene.id ? { ...e, target: successor } : e)) };
            });
        const start = graph.start === scene.id ? successor || scenes[0]?.id || "" : graph.start;
        onChange({ start, scenes });
        onSelect(start);
    }
    function setMode(mode: FilmScene["mode"]) {
        const blank = { label: "", target: "" };
        change({ mode, exits: mode === "ending" ? [] : mode === "next" ? [scene.exits[0] || blank] : [scene.exits[0] || blank, scene.exits[1] || blank, ...scene.exits.slice(2)] });
    }
    return (
        <section className="drama-scriptv-brief film-panel">
            <div className="drama-section-title">
                <h2>
                    <GitBranch className="size-4" />
                    剧情图
                </h2>
                <Button size="small" disabled={graph.scenes.length >= 300} onClick={add} icon={<Plus size={15} />}>
                    添加场次
                </Button>
            </div>
            {graph.scenes.length === 0 ? (
                <WorkspaceState compact icon="projects" title="还没有场次" description="确认改编方向后生成剧情图，也可以手动添加第一个场次。" />
            ) : (
                <>
                    <label>
                        入口场次
                        <Select aria-label="入口场次" value={graph.start || undefined} options={options} onChange={(start) => onChange({ ...graph, start })} />
                    </label>
                    <SceneMap graph={graph} selected={scene?.id || ""} onSelect={onSelect} onInsert={graph.scenes.length < 300 ? (_, i) => setInsertion(i) : undefined} />
                </>
            )}
            {scene && (
                <div className="film-scene">
                    <div className="drama-section-title">
                        <h3>{event ? "互动事件" : scene.media ? "视频片段" : "场次剧本"}</h3>
                        <Button size="small" danger type="text" disabled={uploading} onClick={remove} icon={<Trash2 size={15} />}>
                            移除场次
                        </Button>
                    </div>
                    <label>
                        {scene.media ? "节点名称" : "场名"}
                        <Input value={scene.title} maxLength={60} onChange={(e) => change({ title: e.target.value })} />
                    </label>
                    <label>
                        原著出处
                        <Input value={scene.source} onChange={(e) => change({ source: e.target.value })} />
                    </label>
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
                                onMedia={(resourceId) => change({ media: { kind: scene.media!.kind, resourceId } })}
                            />
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
                        {filmArrivals(graph, scene.id).map((entry) => (
                            <p key={JSON.stringify(entry)}>
                                {graph.scenes.find((upstream) => upstream.id === entry.from)?.title} → {entry.item || "空手"}
                            </p>
                        ))}
                        {graph.scenes
                            .filter((entry) => entry.exits.some((exit) => exit.target === scene.id))
                            .map((entry) => (
                                <p key={entry.id}>
                                    <strong>{entry.title}</strong>　{entry.script}
                                </p>
                            ))}
                        <label>
                            发现线索后{" "}
                            <Select
                                allowClear
                                placeholder="选择热点"
                                value={scene.clue || undefined}
                                onChange={(clue) => change({ clue })}
                                options={graph.scenes.flatMap((entry) => (entry.track?.cues || []).filter((cue) => cue.kind === "hotspot").map((cue) => ({ value: cue.id, label: entry.title + " · " + cue.label })))}
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
                                options={options.filter((o) => o.value !== scene.id)}
                                onChange={(target) => change({ exits: scene.exits.map((v, j) => (j === i ? { ...v, target } : v)) })}
                            />
                            <Button size="small" disabled={!edge.target || graph.scenes.length >= 300} onClick={() => setInsertion(i)}>
                                插入节点
                            </Button>
                            {event && <EventActionEditor edge={edge} onChange={(patch) => change({ exits: scene.exits.map((entry, j) => (j === i ? { ...entry, ...patch } : entry)) })} />}
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
                                        <Input
                                            maxLength={60}
                                            placeholder={field === "item" ? "保留当前物件" : "所有玩家可选"}
                                            value={edge[field] || ""}
                                            onChange={(event) => change({ exits: scene.exits.map((entry, index) => (index === i ? { ...entry, [field]: event.target.value.trim() } : entry)) })}
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
            <AppModal open={insertion !== null} title="插入剧情节点" footer={null} onCancel={() => setInsertion(null)}>
                <p>
                    {scene?.title} → {graph.scenes.find((s) => s.id === scene?.exits[insertion ?? -1]?.target)?.title || "结尾"}
                </p>
                <div className="film-actions">
                    <Button onClick={() => insert("event")}>插入互动事件</Button>
                    <Button onClick={() => insert("clip")}>插入视频片段</Button>
                </div>
            </AppModal>
        </section>
    );
}
