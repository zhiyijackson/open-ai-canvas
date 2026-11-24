import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { Dropdown } from "antd";
import { ArrowDown, Flag, GitBranch, GitMerge, LogIn } from "lucide-react";
import type { FilmGraph } from "@/services/api/interactive-films";
import { MediaThumb } from "@/pages/projects/drama-shared";
import { filmSceneLabels } from "@/lib/film-interactions";

const exitHeight = 66;
function layout(graph: FilmGraph, vertical: boolean, detailed: boolean) {
    const inbound = new Map(graph.scenes.map((s) => [s.id, 0]));
    for (const s of graph.scenes) for (const exit of s.exits) if (inbound.has(exit.target)) inbound.set(exit.target, inbound.get(exit.target)! + 1);
    const merges = new Set(
        Array.from(inbound)
            .filter(([, count]) => count > 1)
            .map(([id]) => id),
    );
    const depth = new Map<string, number>();
    const queue = graph.scenes.filter((s) => inbound.get(s.id) === 0);
    const byId = new Map(graph.scenes.map((s) => [s.id, s]));
    for (let i = 0; i < queue.length; i++) {
        const s = queue[i];
        for (const e of s.exits) {
            if (!inbound.has(e.target)) continue;
            depth.set(e.target, Math.max(depth.get(e.target) || 0, (depth.get(s.id) || 0) + 1));
            inbound.set(e.target, inbound.get(e.target)! - 1);
            if (inbound.get(e.target) === 0) queue.push(byId.get(e.target)!);
        }
    }
    const levels = new Map<number, string[]>();
    for (const scene of graph.scenes) {
        const level = depth.get(scene.id) || 0;
        const group = levels.get(level) || [];
        group.push(scene.id);
        levels.set(level, group);
    }
    const nodeWidth = detailed ? 234 : vertical ? 120 : 156;
    const nodeHeight = 54;
    const stepX = nodeWidth + (vertical ? 12 : 50);
    const stepY = nodeHeight + 32;
    const ranks = Math.max(0, ...levels.keys()) + 1;
    const lanes = Math.max(1, ...Array.from(levels.values(), (group) => group.length));
    const width = (vertical ? lanes : ranks) * stepX + 12;
    let height = (vertical ? ranks : lanes) * stepY;
    const points = new Map<string, { x: number; y: number }>();
    for (const [level, group] of levels) {
        let top = 12;
        group.forEach((id, lane) => {
            points.set(id, {
                x: 8 + (vertical ? lane + (lanes - group.length) / 2 : level) * stepX,
                y: detailed ? top : 12 + (vertical ? level : lane) * stepY,
            });
            if (detailed) top += stepY + exitHeight * byId.get(id)!.exits.length;
        });
        if (detailed) height = Math.max(height, top);
    }
    return { points, width, height, nodeWidth, nodeHeight, merges };
}

export function SceneMap({
    graph,
    selected,
    onSelect,
    onInsert,
    vertical = false,
    status,
    onEditExit,
    onConnect,
    related = false,
    fit = false,
    thumbnail,
}: {
    graph: FilmGraph;
    selected: string;
    onSelect: (id: string) => void;
    onInsert?: (id: string, exit: number) => void;
    vertical?: boolean;
    status?: (id: string) => string;
    onEditExit?: (id: string, index: number) => void;
    onConnect?: (source: string, index: number, target: string) => void;
    related?: boolean;
    fit?: boolean;
    thumbnail?: (id: string) => string | undefined;
}) {
    const detailed = !!onEditExit;
    const { points, width, height, nodeWidth, nodeHeight, merges } = useMemo(() => layout(graph, vertical, detailed), [graph, vertical, detailed]);
    const titles = useMemo(() => filmSceneLabels(graph), [graph]);
    const drag = useRef<{ id: string; index: number } | null>(null);
    const [viewportWidth, setViewportWidth] = useState(0);
    const marker = useId();
    const source = graph.scenes.find((scene) => scene.id === selected);
    const exitsByTarget = new Map<string, number[]>();
    if (onInsert && source)
        source.exits.forEach((exit, index) => {
            const group = exitsByTarget.get(exit.target);
            if (group) group.push(index);
            else exitsByTarget.set(exit.target, [index]);
        });
    const current = useRef<HTMLButtonElement>(null);
    const viewport = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = viewport.current;
        if (!el || !fit) return;
        const observer = new ResizeObserver(() => setViewportWidth(el.clientWidth));
        observer.observe(el);
        return () => observer.disconnect();
    }, [fit]);
    const ratio = fit && viewportWidth ? Math.min(1, viewportWidth / width) : 1;
    const overview = fit && ratio < 0.7;
    useEffect(() => {
        const el = current.current,
            box = viewport.current;
        if (!el || !box || !vertical) return;
        const reveal = () => {
            if (!box.clientWidth) return;
            const node = el.getBoundingClientRect();
            const view = box.getBoundingClientRect();
            box.scrollLeft += node.left - view.left - (box.clientWidth - node.width) / 2;
            if (node.top < view.top || node.bottom > view.bottom) box.scrollTop += node.top - view.top - (box.clientHeight - node.height) / 2;
        };
        reveal();
        const observer = new ResizeObserver(reveal);
        observer.observe(box);
        return () => observer.disconnect();
    }, [selected, vertical, points]);
    return (
        <div ref={viewport} className="film-map" aria-label="场次连线图">
            <div className="film-map-sheet" data-overview={overview} style={overview ? undefined : { width, height, zoom: ratio }}>
                <svg className="film-connectors" width={width} height={height} aria-hidden="true">
                    <defs>
                        <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                            <path d="M0 0 L10 5 L0 10z" fill="currentColor" />
                        </marker>
                    </defs>
                    {graph.scenes.flatMap((scene) =>
                        scene.exits.map((exit, i) => {
                            const from = points.get(scene.id)!,
                                to = points.get(exit.target);
                            if (!to || (related && scene.id !== selected && exit.target !== selected)) return null;
                            const x = from.x + (vertical ? nodeWidth / 2 : nodeWidth),
                                y = from.y + (detailed ? nodeHeight + (i + 0.5) * exitHeight : vertical ? nodeHeight : nodeHeight / 2);
                            const endX = to.x + (vertical ? nodeWidth / 2 : 0),
                                endY = to.y + (vertical ? 0 : nodeHeight / 2);
                            const midX = (x + endX) / 2,
                                midY = (y + endY) / 2;
                            const curve = vertical ? `C${x},${midY} ${endX},${midY} ${endX},${endY}` : `C${midX},${y} ${midX},${endY} ${endX},${endY}`;
                            return (
                                <path key={scene.id + i} data-active={scene.id === selected || exit.target === selected} d={`M${x},${y} ${curve}`} fill="none" stroke="currentColor" markerEnd={`url(#${marker})`}>
                                    <title>{exit.label || "续播"}</title>
                                </path>
                            );
                        }),
                    )}
                </svg>
                {onInsert &&
                    source &&
                    Array.from(exitsByTarget, ([target, indices]) => {
                        const a = points.get(source.id)!,
                            b = points.get(target);
                        if (!b) return null;
                        const name = graph.scenes.find((node) => node.id === target)?.title || target;
                        const shared = indices.length > 1;
                        const label = shared ? `选择通往「${name}」的出口以插入节点` : `在「${source.exits[indices[0]].label || source.title} → ${name}」插入节点`;
                        const button = (
                            <button
                                key={target}
                                type="button"
                                className="film-edge-add"
                                aria-label={label}
                                title={label}
                                aria-haspopup={shared ? "menu" : undefined}
                                style={{ left: (a.x + b.x + nodeWidth) / 2, top: (a.y + b.y + nodeHeight) / 2 }}
                                onClick={shared ? undefined : () => onInsert(source.id, indices[0])}
                            >
                                ＋
                            </button>
                        );
                        if (!shared) return button;
                        return (
                            <Dropdown key={target} trigger={["click"]} menu={{ items: indices.map((i) => ({ key: i, label: `出口 ${i + 1} · ${source.exits[i].label || "继续"}` })), onClick: ({ key }) => onInsert(source.id, Number(key)) }}>
                                {button}
                            </Dropdown>
                        );
                    })}
                {graph.scenes.map((scene) => {
                    const point = points.get(scene.id)!;
                    const kind = scene.id === graph.start ? "入口" : scene.mode === "choice" ? "选择" : scene.mode === "ending" ? "结局" : merges.has(scene.id) ? "汇合" : "续播";
                    const Icon = { 入口: LogIn, 选择: GitBranch, 结局: Flag, 汇合: GitMerge, 续播: ArrowDown }[kind];
                    const choice = scene.track?.cues.find((c) => c.kind === "choice");
                    const image = thumbnail?.(scene.id);
                    return (
                        <Fragment key={scene.id}>
                            <button
                                type="button"
                                key={scene.id}
                                ref={scene.id === selected ? current : undefined}
                                className="film-node"
                                onDragOver={(e) => {
                                    if (drag.current) e.preventDefault();
                                }}
                                onDrop={(e) => {
                                    if (drag.current) {
                                        e.preventDefault();
                                        onConnect?.(drag.current.id, drag.current.index, scene.id);
                                        drag.current = null;
                                    }
                                }}
                                aria-pressed={scene.id === selected}
                                onClick={() => onSelect(scene.id)}
                                style={{ left: point.x, top: point.y, width: nodeWidth, height: nodeHeight }}
                                title={titles.get(scene.id)}
                            >
                                <small>
                                    <Icon className="size-3 shrink-0" aria-hidden="true" />
                                    {image && <MediaThumb className="film-map-thumb" resourceId={image} alt="" />}
                                    {scene.media ? (scene.media.kind === "event" ? "图片 / GIF 事件" : "视频片段") : kind}
                                    {detailed && scene.media && (scene.id === graph.start ? " · 入口" : scene.mode === "ending" ? " · 结局" : merges.has(scene.id) ? " · 汇合" : "")}
                                    {detailed && scene.mode === "choice" && (scene.media?.kind === "event" ? " · 入场选择" : choice ? ` · 第 ${choice.atMs / 1000} 秒选择` : " · 片尾选择")}
                                    {status && " · " + status(scene.id)}
                                </small>
                                <strong>{titles.get(scene.id)}</strong>
                            </button>
                            {onEditExit &&
                                scene.exits.map((exit, i) => {
                                    const rules = [exit.requiresItem && `需持有 ${exit.requiresItem}`, exit.item && `获得 ${exit.item}`, choice?.timeoutMs && exit.id && exit.id === choice.defaultExit ? `${choice.timeoutMs / 1000} 秒默认` : ""]
                                        .filter(Boolean)
                                        .join(" · ");
                                    return (
                                        <button
                                            type="button"
                                            className="film-map-exit"
                                            key={i}
                                            data-scene={scene.id}
                                            data-exit={i}
                                            style={{ left: point.x, top: point.y + nodeHeight + i * exitHeight, width: nodeWidth, height: exitHeight }}
                                            draggable
                                            onDragStart={(e) => {
                                                drag.current = { id: scene.id, index: i };
                                                e.dataTransfer.setData("text/plain", exit.label || "出口");
                                                e.dataTransfer.effectAllowed = "link";
                                            }}
                                            onDragEnd={() => {
                                                drag.current = null;
                                            }}
                                            onClick={() => onEditExit(scene.id, i)}
                                            title={[exit.label, titles.get(exit.target), rules].filter(Boolean).join(" · ")}
                                        >
                                            <strong>{exit.label || (scene.mode === "choice" ? `选项 ${i + 1}` : "继续")}</strong>
                                            <span>→ {titles.get(exit.target) || "待连接"}</span>
                                            {rules && <small>{rules}</small>}
                                            <b aria-hidden="true">＋</b>
                                        </button>
                                    );
                                })}
                        </Fragment>
                    );
                })}
            </div>
        </div>
    );
}
