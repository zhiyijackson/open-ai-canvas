import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Input, Segmented } from "antd";
import { BranchImport } from "./branch-import";
import { ArrowLeft, FileText, FileUp, GitBranch, Play, Plus } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useBlocker, useLinkClickHandler, useNavigate, useParams, useSearchParams } from "react-router";
import { nanoid } from "nanoid";
import { AppModal } from "@/components/ui/product/app-modal";
import { uploadResourceFile } from "@/services/api/resources";
import { getDrama } from "@/services/api/drama";
import { analyzeNovel } from "@/lib/drama/novel-parse";
import { DEFAULT_SELECTED_CHAPTERS, defaultChapterSelection } from "@/lib/drama/chapter-selection";
import { ChapterPickList } from "@/pages/projects/chapter-pick-list";
import { FilmSetupEditor, initialFilmSetup } from "./film-setup";
import { ApiError } from "@/services/api/request";
import { getInteractiveFilm, listInteractiveFilms, saveInteractiveFilm, type FilmDraft, type FilmScene, type InteractiveFilm } from "@/services/api/interactive-films";
import { appendFilmScenes, filmGraphIssue, filmNovelFits, missingFilmScenes, parseFilmGraph, recoverFilmGraph } from "@/lib/interactive-film";
import { decodeNovelText, MAX_NOVEL_FILE_BYTES } from "@/lib/canvas/canvas-document";
import { dramaChoiceToModel } from "@/lib/drama/model-choice";
import { adaptFilm } from "@/services/interactive-film-adaptation";
import { isGenerationTaskTerminalError } from "@/services/api/task-center";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { DramaModelPicker, useDramaModelCatalog } from "@/pages/projects/drama-model-picker";
import { PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { WorkspaceLoadingState, WorkspaceErrorState, WorkspaceState } from "@/components/layout/workspace-state";
import { RelativeTime } from "@/components/ui/product/relative-time";
import { FilmProduction } from "./production";
import { GraphEditor } from "./graph-editor";
import { ExportDialog } from "./export-dialog";
import { FilmPlayer } from "./studio-player";
import { FilmSample } from "./sample";
import "./studio.css";

const blank: FilmDraft = { title: "", novel: "", direction: "", graph: { start: "", scenes: [] }, revision: 0, setup: initialFilmSetup };
const base = "/interactive-films";
const newFilmPath = base + "/new";
export default function InteractiveFilmPage() {
    const { filmId } = useParams();
    const [params] = useSearchParams();
    const openNewFilm = useLinkClickHandler<HTMLAnchorElement | HTMLButtonElement>(newFilmPath);
    const owner = useUserStore((state) => state.user?.id);
    const listing = useQuery({ queryKey: ["interactive-films", owner], queryFn: ({ signal }) => listInteractiveFilms(signal), enabled: !!owner && !filmId });
    const record = useQuery({ queryKey: ["interactive-film", owner, filmId], queryFn: ({ signal }) => getInteractiveFilm(filmId!, signal), enabled: !!owner && !!filmId && filmId !== "new" && filmId !== "sample" });
    if (!owner) return null;
    if (filmId === "sample") return <FilmSample />;
    if (!filmId) {
        const create = (
            <Button type="primary" href={newFilmPath} onClick={openNewFilm} icon={<Plus className="size-4" />}>
                新建影游
            </Button>
        );
        return (
            <WorkspacePage className="studio-collection-page drama-library">
                <div className="drama-root">
                    <div className="studio-band">
                        <PageHeader
                            title="互动影游"
                            description="从小说、分支剧本或已有视频制作互动影游。"
                            meta={listing.data && <span className="app-projects-header-meta">{listing.data.length} 部</span>}
                            actions={
                                <div className="film-actions">
                                    <Link to={base + "/sample"}>体验《闭馆之后》</Link>
                                    {listing.data?.length !== 0 && create}
                                </div>
                            }
                        />
                    </div>
                    {listing.isError ? (
                        <WorkspaceErrorState description={listing.error.message} onRetry={() => void listing.refetch()} />
                    ) : listing.isPending ? (
                        <WorkspaceLoadingState label="正在读取作品" />
                    ) : listing.data.length ? (
                        <div className="drama-library-grid">
                            {listing.data.map((f) => (
                                <article className="drama-library-card" key={f.id}>
                                    <Link className="drama-library-open" to={base + "/" + f.id} aria-label={`打开《${f.title}》`}>
                                        <div className="drama-library-cover is-empty" aria-hidden="true">
                                            <span className="drama-library-glyph">{Array.from(f.title)[0]}</span>
                                            <GitBranch className="drama-library-empty-icon" />
                                        </div>
                                        <div className="drama-library-body">
                                            <h3 title={f.title}>{f.title}</h3>
                                            <div className="drama-library-meta">
                                                <RelativeTime value={f.updatedAt} />
                                            </div>
                                        </div>
                                    </Link>
                                </article>
                            ))}
                        </div>
                    ) : (
                        <WorkspaceState icon="projects" title="创建第一部互动影游" description="改编小说、导入剧本，或用已有视频搭建剧情。" action={create} />
                    )}
                </div>
            </WorkspacePage>
        );
    }
    if (filmId !== "new" && !record.data) return <WorkspacePage>{record.error ? <WorkspaceErrorState description={record.error.message} onRetry={() => void record.refetch()} /> : <WorkspaceLoadingState label="正在打开影游" />}</WorkspacePage>;
    const film = record.data;
    const mode = params.get("mode");
    if (film && mode !== "edit") {
        if (!filmGraphIssue(film.graph, !film.setup?.manualGraph)) return <FilmProduction key={owner + ":" + film.id} film={film} owner={owner} />;
        const editParams = new URLSearchParams(params);
        editParams.set("mode", "edit");
        return <Navigate replace to={{ pathname: base + "/" + film.id, search: editParams.toString() }} />;
    }
    return <FilmStudio key={JSON.stringify([owner, filmId, filmId === "new" && mode])} owner={owner} initial={film} sceneId={params.get("scene")} />;
}

function DraftLeaveGuard({ changed, createdPath, busy, uploads, canSave, save }: { changed: boolean; createdPath: React.RefObject<string>; busy: boolean; uploads: number; canSave: boolean; save: (onSaved: () => void) => Promise<boolean> }) {
    const blocker = useBlocker(({ nextLocation }) => changed && nextLocation.pathname !== createdPath.current);
    useEffect(() => {
        if (!changed) return;
        const warn = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [changed]);
    if (blocker.state !== "blocked") return null;
    return (
        <AppModal
            open
            title="离开剧情编辑？"
            onCancel={() => {
                if (!busy) blocker.reset();
            }}
            footer={[
                <Button key="discard" disabled={busy} onClick={() => blocker.proceed()}>
                    放弃修改
                </Button>,
                <Button key="stay" disabled={busy} onClick={() => blocker.reset()}>
                    继续编辑
                </Button>,
                <Button
                    key="save"
                    type="primary"
                    disabled={!canSave}
                    onClick={async () => {
                        if (!(await save(blocker.proceed))) blocker.reset();
                    }}
                >
                    保存并离开
                </Button>,
            ]}
        >
            {uploads ? `还有 ${uploads} 个节点正在上传素材，上传完成后可保存。` : "剧情修改尚未保存。"}
        </AppModal>
    );
}

function FilmStudio({ initial, owner, sceneId }: { initial?: InteractiveFilm; owner: string; sceneId: string | null }) {
    const { message, modal } = App.useApp(),
        navigate = useNavigate(),
        cache = useQueryClient();
    const back = useLinkClickHandler<HTMLAnchorElement | HTMLButtonElement>(base);
    const [saved, setSaved] = useState(initial);
    const [conflict, setConflict] = useState<InteractiveFilm>();
    const [studioParams, setStudioParams] = useSearchParams();
    const [draft, setDraft] = useState<FilmDraft>(() => initial || (studioParams.get("mode") === "manual" ? { ...blank, setup: { manualGraph: true } } : blank)),
        [dirty, setDirty] = useState(false);
    const createdPath = useRef("");
    const firstSubmission = useRef<{ key: string; draft: FilmDraft } | null>(null);
    const [uploadingNodes, setUploadingNodes] = useState<string[]>([]);
    const [selected, setSelected] = useState(draft.graph.scenes.some((s) => s.id === sceneId) ? sceneId! : draft.graph.start),
        [playing, setPlaying] = useState(false);
    const [busy, setBusy] = useState(""),
        [error, setError] = useState("");
    const [outputLength, setOutputLength] = useState(0);
    const [generationError, setGenerationError] = useState("");
    const setup = draft.setup || initialFilmSetup;
    const manual = !!setup.manualGraph;
    const [previewIndex, setPreviewIndex] = useState(0);
    const hasSelection = Array.isArray(setup.chapterIndexes);
    const analysis = useMemo(() => (hasSelection ? analyzeNovel(draft.novel, { keepShortChapters: true }) : undefined), [hasSelection, draft.novel]);
    const selection = useMemo(() => new Set(setup.chapterIndexes), [setup.chapterIndexes]);
    const canAdaptSource = hasSelection ? selection.size > 0 : !!draft.novel.trim();
    const chapterItems = useMemo(() => analysis?.chapters.map((chapter, index) => ({ key: String(index), title: chapter.title, words: chapter.words })) || [], [analysis]);
    function splitNovel() {
        const result = analyzeNovel(draft.novel, { keepShortChapters: true });
        if (!result.chapters.length) {
            setGenerationError("未识别到可改编正文，请在原著中补充故事内容。");
            return;
        }
        const indexes = defaultChapterSelection(result.chapters.length);
        setPreviewIndex(0);
        edit({ setup: { ...setup, chapterIndexes: [...indexes] } });
        return { chapters: result.chapters, indexes };
    }

    const active = useRef<AbortController | null>(null),
        fileInput = useRef<HTMLInputElement>(null);
    useEffect(() => () => active.current?.abort(), []);
    const catalog = useDramaModelCatalog(!manual),
        config = useEffectiveConfig();
    const choice = setup.settings?.models?.text || catalog.data?.defaults.text;

    const issue = filmGraphIssue(draft.graph);
    const canContinueGraph = missingFilmScenes(draft.graph).length > 0;
    const drama = useQuery({ queryKey: ["film-production", owner, saved?.projectId], queryFn: ({ signal }) => getDrama(saved!.projectId, signal), enabled: !!saved?.projectId, refetchOnWindowFocus: true });
    function edit(patch: Partial<FilmDraft>) {
        setDraft((d) => ({ ...d, ...patch }));
        setDirty(true);
        setError("");
        setGenerationError("");
    }
    async function uploadNodeMedia(scene: FilmScene, file: File, exitIndex?: number) {
        const kind = scene.media?.kind;
        if (!kind || uploadingNodes.includes(scene.id)) return;
        const exitId = exitIndex === undefined ? undefined : scene.exits[exitIndex]?.id || crypto.randomUUID();
        if (exitId && !scene.exits[exitIndex!]?.id)
            setDraft((current) => ({
                ...current,
                graph: { ...current.graph, scenes: current.graph.scenes.map((node) => (node.id === scene.id ? { ...node, exits: node.exits.map((edge, i) => (i === exitIndex ? { ...edge, id: exitId } : edge)) } : node)) },
            }));
        setUploadingNodes((ids) => [...ids, scene.id]);
        setError("");
        try {
            const resource = await uploadResourceFile(file, kind === "clip" ? "video" : "image");
            setDraft((current) => ({
                ...current,
                graph: {
                    ...current.graph,
                    scenes: current.graph.scenes.map((node) =>
                        node.id !== scene.id || node.media?.kind !== kind
                            ? node
                            : exitId
                              ? { ...node, exits: node.exits.map((edge) => (edge.id === exitId && edge.spot ? { ...edge, spot: { ...edge.spot, resourceId: resource.id } } : edge)) }
                              : { ...node, media: { ...node.media, kind, resourceId: resource.id } },
                    ),
                },
            }));
            setDirty(true);
        } catch (cause) {
            setError(`「${scene.title}」素材上传失败：${cause instanceof Error ? cause.message : "请重试"}`);
        } finally {
            setUploadingNodes((ids) => ids.filter((id) => id !== scene.id));
        }
    }
    function editNovel(novel: string, fileName?: string) {
        if (!filmNovelFits(novel)) {
            setError("单部原著最多 600 万字");
            return;
        }
        edit({ novel, setup: { ...setup, chapterIndexes: undefined }, title: draft.title || (fileName || "").replace(/\.txt$/i, "").slice(0, 100) });
    }
    async function execute(label: string, fn: (signal: AbortSignal) => Promise<void>) {
        if (active.current) return false;
        const controller = new AbortController();
        active.current = controller;
        setBusy(label);
        setError("");
        try {
            await fn(controller.signal);
            return !controller.signal.aborted;
        } catch (e) {
            if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "操作失败");
            return false;
        } finally {
            if (!controller.signal.aborted) setBusy("");
            active.current = null;
        }
    }
    function accept(f: InteractiveFilm, onSaved?: () => void) {
        cache.setQueryData(["interactive-film", owner, f.id], f);
        void cache.invalidateQueries({ queryKey: ["interactive-films", owner] });
        setSaved(f);
        setDraft(f);
        setDirty(false);
        if (onSaved) onSaved();
        else if (!initial) {
            createdPath.current = base + "/" + f.id;
            navigate(createdPath.current + (f.setup?.manualGraph ? "?mode=edit" : ""), { replace: true });
        }
    }
    function save(onSaved?: () => void) {
        if (uploadingNodes.length) return Promise.resolve(false);
        return execute("save", async (signal) => {
            let f: InteractiveFilm;
            let updatingId = saved?.id;
            try {
                if (updatingId) f = await saveInteractiveFilm(draft, updatingId);
                else {
                    firstSubmission.current ??= { key: nanoid(), draft };
                    f = await saveInteractiveFilm({ ...draft, creationKey: firstSubmission.current.key });
                    // A lost create response may return the original draft after the author has edited it.
                    if (firstSubmission.current.draft !== draft) {
                        updatingId = f.id;
                        f = await saveInteractiveFilm({ ...draft, revision: 1 }, updatingId);
                    }
                }
            } catch (error) {
                setPlaying(false);
                if (updatingId && error instanceof ApiError && error.status === 409) setConflict(await getInteractiveFilm(updatingId, signal));
                throw error;
            }
            if (signal.aborted) return;
            accept(f, onSaved);
            message.success("已保存到作品库");
        });
    }
    function generate(stage: "direction" | "graph", extend = false) {
        void execute(stage, async (signal) => {
            setGenerationError("");
            setOutputLength(0);
            let received = "";
            let output = "";
            const existing = extend ? draft.graph : undefined;
            const model = dramaChoiceToModel(config, "text", choice);
            const range = analysis ? { chapters: analysis.chapters, indexes: selection } : splitNovel();
            if (!range) return;
            const selectedSource = range.chapters
                .filter((_, index) => range.indexes.has(index))
                .map((chapter) => `${chapter.title}\n${chapter.text}`)
                .join("\n\n");
            if (!selectedSource) throw new Error("请先拆分原著并选择要改编的剧情段");
            try {
                output = await adaptFilm(
                    stage,
                    selectedSource,
                    draft.direction,
                    config,
                    model,
                    signal,
                    (text) => {
                        if (signal.aborted || !text) return;
                        received = text;
                        setOutputLength(text.length);
                    },
                    existing,
                );
                if (signal.aborted) return;
                if (stage === "direction") {
                    edit({ direction: output });
                    return;
                }
                const generated = parseFilmGraph(output);
                const graph = existing ? appendFilmScenes(existing, generated) : generated;
                edit({ graph });
                setSelected(existing ? generated.scenes[0].id : graph.start);
            } catch (e) {
                if (signal.aborted) return;
                let detail = e instanceof Error ? e.message : "生成失败";
                const finished = !!output || isGenerationTaskTerminalError(e);
                const partial = finished && stage === "graph" && (existing || !draft.graph.scenes.length) ? recoverFilmGraph(output || received) : undefined;
                if (partial) {
                    try {
                        const graph = existing ? appendFilmScenes(existing, partial) : partial;
                        edit({ graph });
                        setSelected(partial.scenes[0].id);
                        detail += `。已取回 ${partial.scenes.length} 个完整场次，可保存作品。`;
                    } catch (mergeError) {
                        if (mergeError instanceof Error) detail += "。" + mergeError.message;
                    }
                }
                setGenerationError(detail);
            }
        });
    }
    const importing = !initial && studioParams.get("mode") === "import";
    function openWorkbench() {
        if (saved) navigate(base + "/" + saved.id + "?" + new URLSearchParams({ scene: selected || draft.graph.start, tab: studioParams.get("tab") || "board" }));
    }
    function requestGraph(extend = false) {
        if (!extend && draft.graph.scenes.length) {
            modal.confirm({ title: "重新生成整部剧情图？", content: `将发起一次改编任务，替换当前 ${draft.graph.scenes.length} 场及其手工出口和互动轨。`, okText: "重新生成", onOk: () => generate("graph") });
        } else generate("graph", extend);
    }
    const hasUploads = uploadingNodes.length > 0;
    const canSave = !busy && !hasUploads && !!draft.title.trim() && dirty;
    const workbenchReady = saved && !dirty && !hasUploads && !(manual ? issue : filmGraphIssue(draft.graph, true));
    return (
        <WorkspacePage fluid scroll={false}>
            <div className="drama-root film-editor">
                {!importing && <DraftLeaveGuard changed={dirty || hasUploads} createdPath={createdPath} busy={!!busy} canSave={canSave} uploads={uploadingNodes.length} save={save} />}
                <header className="drama-topbar film-editor-bar">
                    <Button type="text" shape="circle" href={base} onClick={back} icon={<ArrowLeft className="size-4" />} aria-label="返回影游作品库" />
                    <div className="drama-topbar-title">
                        <h1 title={draft.title}>{draft.title || "新建互动影游"}</h1>
                    </div>
                    <div className="drama-topbar-actions">
                        {playing ? (
                            <Button onClick={() => setPlaying(false)}>返回编辑</Button>
                        ) : importing ? null : (
                            <>
                                <span className="film-save-status" role="status">
                                    {hasUploads ? `正在上传 ${uploadingNodes.length} 个节点素材` : dirty || !saved ? "尚未保存" : "已保存"}
                                </span>
                                <Button type={workbenchReady ? "default" : "primary"} disabled={!canSave} loading={busy === "save"} onClick={() => void save()}>
                                    保存作品
                                </Button>
                                {workbenchReady && (
                                    <Button type="primary" onClick={() => openWorkbench()}>
                                        进入制作台
                                    </Button>
                                )}
                            </>
                        )}
                    </div>
                </header>
                <div className="film-editor-scroll thin-scrollbar">
                    {!initial && !playing && (
                        <Segmented
                            className="film-import-mode"
                            aria-label="新建方式"
                            disabled={!!busy || hasUploads}
                            value={importing ? "import" : manual ? "manual" : "novel"}
                            options={[
                                { label: "从小说改编", value: "novel" },
                                { label: "导入分支剧本", value: "import" },
                                { label: "用已有视频搭建", value: "manual" },
                            ]}
                            onChange={(value) => setStudioParams(value === "novel" ? {} : { mode: value }, { replace: true })}
                        />
                    )}
                    {importing ? (
                        <BranchImport onSaved={accept} />
                    ) : playing ? (
                        <>
                            {drama.isError && <Alert type="warning" title={drama.error.message} />}
                            <FilmPlayer
                                graph={draft.graph}
                                takes={saved?.takes || {}}
                                episodes={drama.data?.episodes || []}
                                start={manual ? draft.graph.start : selected}
                                onLocate={(id) => {
                                    setSelected(id);
                                    setPlaying(false);
                                }}
                            />
                        </>
                    ) : (
                        <>
                            {error && <Alert type="error" showIcon title={error} />}
                            {conflict && (
                                <section className="drama-scriptv-brief film-panel">
                                    <h2>作品已有新版本 · {conflict.revision}</h2>
                                    <details>
                                        <summary>查看服务器原著、方向与剧情</summary>
                                        <p className="film-script">
                                            {conflict.title}
                                            {"\n"}
                                            {conflict.novel}
                                            {"\n"}
                                            {conflict.direction}
                                        </p>
                                        <pre className="film-script">{JSON.stringify(conflict.graph, null, 2)}</pre>
                                    </details>
                                    <p>对照后可采用服务器版本，或保留当前整部草稿并再次保存。</p>
                                    <div className="film-actions">
                                        <Button
                                            disabled={hasUploads || !!busy}
                                            onClick={() => {
                                                accept(conflict);
                                                setConflict(undefined);
                                                setError("");
                                            }}
                                        >
                                            载入服务器版本
                                        </Button>
                                        <Button
                                            disabled={hasUploads || !!busy}
                                            onClick={() => {
                                                setDraft({ ...draft, revision: conflict.revision });
                                                setSaved(conflict);
                                                setConflict(undefined);
                                                setDirty(true);
                                                setError("");
                                            }}
                                        >
                                            保留当前草稿继续编辑
                                        </Button>
                                    </div>
                                </section>
                            )}
                            <fieldset className="film-workspace" disabled={!!busy}>
                                <div className="film-right">
                                    <section className="drama-scriptv-brief film-panel">
                                        <div className="drama-section-title">
                                            <h2>
                                                <FileText className="size-4" />
                                                {manual ? "作品信息" : "原著分段"}
                                            </h2>
                                        </div>
                                        <label>
                                            作品名称
                                            <Input value={draft.title} maxLength={100} onChange={(e) => edit({ title: e.target.value })} />
                                        </label>
                                        {!manual && (
                                            <>
                                                <div className="film-bar">
                                                    <strong>原著</strong>
                                                    <Button size="small" icon={<FileUp className="size-3.5" />} onClick={() => fileInput.current?.click()}>
                                                        上传 TXT
                                                    </Button>
                                                    <input
                                                        ref={fileInput}
                                                        type="file"
                                                        hidden
                                                        accept=".txt,text/plain"
                                                        onChange={(e) => {
                                                            const file = e.target.files?.[0];
                                                            e.target.value = "";
                                                            if (!file) return;
                                                            void execute("upload", async (signal) => {
                                                                if (file.size > MAX_NOVEL_FILE_BYTES) throw new Error("TXT 文件超过 40 MB");
                                                                const novel = decodeNovelText(await file.arrayBuffer());
                                                                if (!signal.aborted) editNovel(novel, file.name);
                                                            });
                                                        }}
                                                    />
                                                </div>
                                                <Input.TextArea aria-label="小说原文" aria-describedby="film-novel-limit" placeholder="粘贴小说，或上传 TXT" rows={6} value={draft.novel} onChange={(e) => editNovel(e.target.value)} />
                                                <small id="film-novel-limit">原著最多 600 万字，TXT 最大 40 MB。只将选中的章节交给改编模型。</small>
                                                {!analysis && (
                                                    <Button disabled={!draft.novel.trim()} onClick={splitNovel}>
                                                        识别章节与剧情段
                                                    </Button>
                                                )}
                                                {analysis && (
                                                    <>
                                                        <ChapterPickList
                                                            items={chapterItems}
                                                            selected={selection}
                                                            onChange={(next) => edit({ setup: { ...setup, chapterIndexes: [...next].sort((a, b) => a - b) } })}
                                                            previewIndex={previewIndex}
                                                            onPreview={setPreviewIndex}
                                                        />
                                                        <details>
                                                            <summary>原文预览 · {chapterItems[previewIndex]?.title}</summary>
                                                            <p className="film-script">{analysis.chapters[previewIndex]?.text.slice(0, 6000)}</p>
                                                        </details>
                                                    </>
                                                )}
                                            </>
                                        )}
                                    </section>
                                    {!manual && (
                                        <section className="drama-scriptv-brief film-panel">
                                            <div className="drama-section-title">
                                                <h2>剧情拆解与改编</h2>
                                                {!saved?.projectId && <FilmSetupEditor value={setup} onChange={(setup) => edit({ setup })} />}
                                            </div>
                                            <label>
                                                改编模型
                                                <DramaModelPicker capability="text" value={choice} onChange={(text) => edit({ setup: { ...setup, settings: { ...setup.settings, models: { ...setup.settings?.models, text } } } })} />
                                            </label>
                                            <Button loading={busy === "direction"} disabled={!canAdaptSource} onClick={() => generate("direction")}>
                                                按剧情拆解选段
                                            </Button>
                                            <label>
                                                分段剧情与改编方向
                                                <Input.TextArea placeholder="玩家扮演谁？哪些决定交给观众？" autoSize={{ minRows: 4, maxRows: 12 }} value={draft.direction} onChange={(e) => edit({ direction: e.target.value })} />
                                            </label>
                                            <Button type="primary" loading={busy === "graph"} disabled={hasUploads || !draft.direction.trim() || !canAdaptSource} onClick={() => requestGraph(canContinueGraph)}>
                                                {canContinueGraph ? "续写缺失场次" : draft.graph.scenes.length ? "按方向重新生成剧情图" : "确认方向并生成剧情图"}
                                            </Button>
                                            {canContinueGraph && (
                                                <Button disabled={!!busy || hasUploads || !draft.direction.trim() || !canAdaptSource} onClick={() => requestGraph()}>
                                                    按方向重新生成剧情图
                                                </Button>
                                            )}
                                            {!hasSelection && <small>可直接生成，系统会自动识别章节，默认最多选前 {DEFAULT_SELECTED_CHAPTERS} 章。也可先识别并自行选章。</small>}
                                            {hasSelection && !selection.size && <small role="status">请在上方勾选至少一个剧情段。</small>}
                                            {(busy === "direction" || busy === "graph") && (
                                                <p role="status">
                                                    {busy === "direction" ? "正在生成改编方向" : "正在生成剧情图"} · {outputLength ? `已收到 ${outputLength.toLocaleString()} 个字符` : "等待模型输出"}
                                                </p>
                                            )}
                                            {generationError && <Alert type="warning" showIcon title={generationError} />}
                                        </section>
                                    )}
                                </div>
                                <div className="film-right">
                                    <GraphEditor
                                        manual={manual}
                                        graph={draft.graph}
                                        selected={selected}
                                        onSelect={setSelected}
                                        onChange={(graph) => edit({ graph })}
                                        projectId={saved?.projectId}
                                        episodes={drama.data?.episodes || []}
                                        episodeId={saved?.takes[selected]?.episodeId}
                                        initialInsert={studioParams.get("insert")}
                                        uploadingNodes={uploadingNodes}
                                        onUpload={uploadNodeMedia}
                                    />
                                    {!!draft.graph.scenes.length && (
                                        <section className="drama-scriptv-brief film-panel">
                                            {issue && <Alert type="warning" title={issue} />}
                                            <div className="film-actions">
                                                <Button disabled={hasUploads || !!issue} icon={<Play size={16} />} onClick={() => setPlaying(true)}>
                                                    {manual ? "从入口试玩" : "互动试玩"}
                                                </Button>
                                                {manual && saved && !dirty && !hasUploads && !issue && <ExportDialog film={saved} episodes={drama.data?.episodes || []} />}
                                            </div>
                                            {dirty && <small>{manual ? "保存作品后可导出 H5 工程。" : "保存作品后即可送入制作台。"}</small>}
                                        </section>
                                    )}
                                </div>
                            </fieldset>
                        </>
                    )}
                </div>
            </div>
        </WorkspacePage>
    );
}
