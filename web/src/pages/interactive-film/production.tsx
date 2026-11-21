import { useState } from "react";
import { FilmAudit } from "./audit";
import { App, Button, Dropdown, Select } from "antd";
import { ArrowLeft, Clapperboard, ClipboardCheck, GitBranch, Pencil, Play } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLinkClickHandler, useSearchParams } from "react-router";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { ApiError } from "@/services/api/request";
import type { DramaEpisodeRow, DramaModels } from "@/services/api/drama";
import { produceFilmScenes, saveInteractiveFilm, type InteractiveFilm } from "@/services/api/interactive-films";
import { InteractionTrack } from "./interaction-track";
import { ProductionStudio } from "@/pages/projects/detail";
import { STAGE_LABEL } from "@/pages/projects/drama-shared";
import { DramaModelPicker, useDramaModelCatalog } from "@/pages/projects/drama-model-picker";
import { StudioBody, StudioTabs, studioTab } from "@/pages/projects/studio/studio-layout";
import { useDramaSummary } from "@/pages/projects/studio/use-studio";
import { SceneMap } from "./scene-map";
import { filmRulesIssue } from "@/lib/film-interactions";

export function FilmProduction({ film, owner }: { film: InteractiveFilm; owner: string }) {
    const [params, setParams] = useSearchParams();
    const { message, modal } = App.useApp();
    const cache = useQueryClient();
    const catalog = useDramaModelCatalog();
    const summaryQuery = useDramaSummary(film.projectId);
    const projectMissing = summaryQuery.error instanceof ApiError && summaryQuery.error.reason === "not_found";
    const projectId = projectMissing ? "" : film.projectId;
    const [choices, setChoices] = useState<Partial<DramaModels>>({});
    const { graph } = film;
    const scene = graph.scenes.find((s) => s.id === params.get("scene")) || graph.scenes.find((s) => s.id === graph.start)!;
    const path = "/interactive-films/" + film.id;
    const tab = studioTab(params.get("tab"));
    const mode = params.get("mode");
    const auditOpen = mode === "audit" || mode === "play";
    const initialPlay = mode === "play" ? scene.id : params.get("play") || undefined;
    const [playingAudit, setPlayingAudit] = useState(false);
    const origin = { scene: params.get("originScene") || scene.id, tab: studioTab(params.get("originTab") || tab) };
    const episodes = new Set(summaryQuery.data?.episodes.map((episode) => episode.id));
    const sceneForEpisode = new Map<string, string>();
    const missing = graph.scenes.filter((s) => {
        if (s.media) return false;
        const take = film.takes[s.id];
        if (!projectId || take?.script !== s.script || !episodes.has(take.episodeId)) return true;
        sceneForEpisode.set(take.episodeId, s.id);
        return false;
    });
    const take = film.takes[scene.id];
    const episodeId = take && sceneForEpisode.has(take.episodeId) ? take.episodeId : "";
    function choose(id: string) {
        setParams({ scene: id, ...(tab === "board" ? {} : { tab }) });
    }
    const produce = useMutation({
        mutationFn: (ids: string[]) => produceFilmScenes(film.id, film.revision, ids, projectId ? undefined : { ...catalog.data?.defaults, ...choices }),
        onSuccess: async (updated) => {
            cache.setQueryData(["interactive-film", owner, film.id], updated);
            await cache.invalidateQueries({ queryKey: dramaKeys.summary(updated.projectId) });
        },
        onError: (err) => {
            message.error(err instanceof Error ? err.message : "启动制作失败");
            void cache.invalidateQueries({ queryKey: ["interactive-film", owner, film.id] });
        },
    });
    const start = (ids: string[]) => {
        if (produce.isPending) return;
        const issue = filmRulesIssue(graph);
        if (issue) {
            message.warning(issue);
            return;
        }
        if (ids.length === 1) {
            produce.mutate(ids);
            return;
        }
        modal.confirm({
            title: `开始制作 ${ids.length} 个场次？`,
            content: graph.scenes
                .filter((entry) => ids.includes(entry.id))
                .map((entry) => entry.title)
                .join("、"),
            okText: "开始制作",
            onOk: () => produce.mutateAsync(ids),
        });
    };
    const editPath = path + "?" + new URLSearchParams({ mode: "edit", scene: scene.id, tab }),
        playPath = path + "?" + new URLSearchParams({ ...origin, mode: "audit", play: scene.id });
    const editLink = useLinkClickHandler<HTMLAnchorElement | HTMLButtonElement>(editPath);
    const playLink = useLinkClickHandler<HTMLAnchorElement | HTMLButtonElement>(playPath);
    const back = useLinkClickHandler<HTMLAnchorElement | HTMLButtonElement>("/interactive-films");
    const sceneActions = projectId ? (
        <Dropdown
            trigger={["click"]}
            menu={{
                items: [
                    { key: "edit", icon: <Pencil size={15} />, label: <Link to={editPath}>编辑剧情</Link> },
                    ...(missing.length > 1 ? [{ key: "produce", icon: <Clapperboard size={15} />, label: "制作全部待制作场次", disabled: produce.isPending, onClick: () => start(missing.map((s) => s.id)) }] : []),
                ],
            }}
        >
            <Button icon={<GitBranch size={16} />} aria-label="剧情操作">
                <span className="drama-topbar-action-label">剧情</span>
            </Button>
        </Dropdown>
    ) : (
        <>
            <Button href={editPath} onClick={editLink} icon={<Pencil size={15} />}>
                编辑剧情
            </Button>
            {missing.length > 1 && (
                <Button disabled={produce.isPending} onClick={() => start(missing.map((s) => s.id))}>
                    制作全部场次
                </Button>
            )}
        </>
    );
    const actions = (
        <>
            <Button icon={<ClipboardCheck size={15} />} onClick={() => setParams({ ...origin, mode: "audit" })}>
                {params.has("originScene") ? "返回作品体检" : "作品体检"}
            </Button>
            <Button href={playPath} onClick={playLink} icon={<Play size={15} />}>
                互动试玩
            </Button>
            {sceneActions}
        </>
    );
    function rail(episodes: DramaEpisodeRow[], showProduction: () => void) {
        const stages = new Map(episodes.map((e) => [e.id, STAGE_LABEL[e.stage]]));
        const select = (id: string) => {
            choose(id);
            showProduction();
        };
        return (
            <aside className="drama-rail film-dag-rail" aria-label="场次导航">
                <div className="drama-rail-head">
                    <div className="film-rail-title">
                        <GitBranch size={16} />
                        <strong>剧情图</strong>
                        <span>{graph.scenes.length} 场</span>
                    </div>
                    <Select aria-label="查找场次" placeholder="查找场名或编号" value={null} showSearch={{ optionFilterProp: "label" }} onChange={select} options={graph.scenes.map((s) => ({ value: s.id, label: s.title + " · " + s.id }))} />
                </div>
                <SceneMap
                    graph={graph}
                    selected={scene.id}
                    onSelect={select}
                    onInsert={graph.scenes.length < 300 ? (id, i) => setParams({ mode: "edit", scene: id, tab, insert: String(i) }) : undefined}
                    vertical
                    status={(id) => {
                        const media = graph.scenes.find((s) => s.id === id)?.media;
                        if (media) return media.kind === "event" ? "可试玩" : media.resourceId ? "已绑定" : "待绑定";
                        const version = film.takes[id];
                        if (!projectId || !version || !stages.has(version.episodeId)) return "待制作";
                        if (!sceneForEpisode.has(version.episodeId)) return "已改稿";
                        return stages.get(version.episodeId) || "待制作";
                    }}
                />
            </aside>
        );
    }
    const pendingScene = scene.media ? (
        <main className="drama-main">
            <div className="drama-scroll film-scene-preview">
                <section className="drama-scriptv-brief film-panel">
                    <small>{scene.media.kind === "event" ? "互动事件" : "视频片段"}</small>
                    <h2>{scene.title}</h2>
                    <p className="film-script">{scene.script}</p>
                    <div className="film-actions">
                        <Button href={editPath} onClick={editLink}>
                            编辑节点
                        </Button>
                        <Button href={playPath} onClick={playLink}>
                            从这里试玩
                        </Button>
                        {take && projectId && <Link to={`/projects/${projectId}/e/${take.episodeId}`}>打开本集分镜</Link>}
                    </div>
                </section>
            </div>
        </main>
    ) : (
        <main className="drama-main">
            <div className="drama-ep-header">
                <div className="drama-ep-heading">
                    <div className="drama-eyebrow">{scene.id === graph.start ? "入口场次" : scene.mode === "ending" ? "结局场次" : "当前场次"} · 待制作</div>
                    <h2>{scene.title}</h2>
                </div>
                <StudioTabs tab={tab} onChange={(value) => setParams({ scene: scene.id, ...(value === "board" ? {} : { tab: value }) }, { replace: true })} />
            </div>
            <div className="drama-scroll film-scene-preview">
                <section className="drama-scriptv-brief film-panel">
                    <div className="drama-section-title">
                        <h2>{tab === "script" ? "场次剧本" : tab === "final" ? "本场尚未生成成片" : "本场分镜待生成"}</h2>
                        {tab !== "final" && scene.source && <span>{scene.source}</span>}
                    </div>
                    {tab === "final" ? <p>本场的剧情段生成视频后，可在这里合成并预览成片。</p> : <p className={tab === "board" ? "film-script film-script-excerpt" : "film-script"}>{scene.script}</p>}
                    {tab !== "final" && scene.exits.length > 0 && (
                        <div className="film-actions">
                            {scene.exits.map((exit, i) => (
                                <Button key={i} size="small" onClick={() => choose(exit.target)}>
                                    {exit.label || "续播"} → {graph.scenes.find((s) => s.id === exit.target)?.title}
                                </Button>
                            ))}
                        </div>
                    )}
                </section>
                {!projectId && (
                    <details className="drama-compose-models film-models">
                        <summary>制作模型</summary>
                        {(["text", "image", "video"] as const).map((cap, i) => (
                            <label key={cap}>
                                {["分镜模型", "参考图模型", "视频模型"][i]}
                                <DramaModelPicker capability={cap} value={choices[cap] || catalog.data?.defaults[cap]} onChange={(value) => setChoices((old) => ({ ...old, [cap]: value }))} />
                            </label>
                        ))}
                    </details>
                )}
                <Button type="primary" icon={<Clapperboard size={16} />} loading={produce.isPending} onClick={() => start([scene.id])}>
                    {take && take.script !== scene.script ? "按新剧本制作本场" : "开始制作本场分镜"}
                </Button>
            </div>
        </main>
    );
    if (auditOpen) {
        const audit =
            projectId && summaryQuery.isError ? (
                <main className="film-panel">
                    <p>{summaryQuery.error.message}</p>
                    <Button onClick={() => void summaryQuery.refetch()}>重试读取成片</Button>
                    <Button onClick={() => setParams(origin)}>返回制作</Button>
                </main>
            ) : projectId && summaryQuery.isPending ? (
                <p role="status">正在读取成片版本…</p>
            ) : (
                <FilmAudit
                    key={initialPlay || "audit"}
                    owner={owner}
                    film={film}
                    episodes={summaryQuery.data?.episodes || []}
                    initialPlay={initialPlay}
                    onPlaying={setPlayingAudit}
                    onBack={() => setParams(origin)}
                    onLocate={(id, time) => setParams({ scene: id, tab: "final", at: String(time), originScene: origin.scene, originTab: origin.tab })}
                />
            );
        return (
            <WorkspacePage className="!overflow-hidden" fluid scroll={false}>
                <div className="drama-root drama-studio film-production-studio" data-audition={playingAudit}>
                    <header className="drama-topbar">
                        <Button type="text" shape="circle" href="/interactive-films" onClick={back} icon={<ArrowLeft size={16} />} aria-label="返回影游作品库" />
                        <div className="drama-topbar-title">
                            <h1>{film.title}</h1>
                        </div>
                    </header>
                    <StudioBody label={`剧情图 · ${graph.scenes.length} 场`} rail={(show) => rail(summaryQuery.data?.episodes || [], show)}>
                        {audit}
                    </StudioBody>
                </div>
            </WorkspacePage>
        );
    }
    if (projectId)
        return (
            <ProductionStudio
                projectId={projectId}
                routeEpisodeId={episodeId}
                summaryQuery={summaryQuery}
                film={{
                    title: film.title,
                    sceneTitle: scene.title,
                    sceneCount: graph.scenes.length,
                    currentEpisodeIds: new Set(sceneForEpisode.keys()),
                    rail,
                    actions,
                    pendingScene,
                    interactionTrack: (episode) => (
                        <InteractionTrack
                            key={scene.id + episode.finalResourceId}
                            initialTime={Number(params.get("at"))}
                            film={film}
                            scene={scene}
                            episodes={summaryQuery.data?.episodes || []}
                            resourceId={!episode.finalStale ? episode.finalResourceId || "" : ""}
                            save={async (updated, base) => {
                                const record = await saveInteractiveFilm({ ...base, graph: { ...base.graph, scenes: base.graph.scenes.map((entry) => (entry.id === updated.id ? updated : entry)) } }, base.id);
                                cache.setQueryData(["interactive-film", owner, base.id], record);
                                return record;
                            }}
                        />
                    ),
                    episodePath: (id, search) => {
                        const match = sceneForEpisode.get(id);
                        if (!match) return `/projects/${projectId}/e/${id}${search}`;
                        const query = new URLSearchParams(search);
                        query.set("scene", match);
                        return path + "?" + query.toString();
                    },
                }}
            />
        );
    return (
        <WorkspacePage className="!overflow-hidden" fluid scroll={false}>
            <div className="drama-root drama-studio film-production-studio film-unstarted">
                <header className="drama-topbar">
                    <Button type="text" shape="circle" href="/interactive-films" onClick={back} icon={<ArrowLeft className="size-4" />} aria-label="返回影游作品库" />
                    <div className="drama-topbar-title">
                        <h1>{film.title}</h1>
                    </div>
                    <div className="drama-topbar-actions">{actions}</div>
                </header>
                <StudioBody label={`剧情图 · ${graph.scenes.length} 场`} rail={(show) => rail([], show)}>
                    {pendingScene}
                </StudioBody>
            </div>
        </WorkspacePage>
    );
}
