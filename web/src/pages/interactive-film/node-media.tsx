import { useState } from "react";
import { Alert, Button, Input, InputNumber, Select } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getDramaEpisode, type DramaEpisodeRow } from "@/services/api/drama";
import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { useResourceMediaUrl } from "@/pages/projects/drama-shared";
import type { FilmExit, FilmScene } from "@/services/api/interactive-films";

export function EventFrame({ scene, exits, onAction }: { scene: FilmScene; exits: FilmExit[]; onAction: (edge: FilmExit) => void }) {
    const url = useResourceMediaUrl(scene.media?.resourceId);
    const [feedback, setFeedback] = useState<FilmExit>();
    function choose(edge: FilmExit) {
        if (edge.feedback) setFeedback(edge);
        else onAction(edge);
    }
    return (
        <>
            <p className="film-script">{scene.script}</p>
            {url && (
                <div className="film-event-frame">
                    <img src={url} alt={scene.title} />
                    {!feedback &&
                        exits.map(
                            (edge, i) =>
                                edge.spot && (
                                    <Button key={i} className="film-event-spot" style={{ left: edge.spot.x + "%", top: edge.spot.y + "%" }} onClick={() => choose(edge)} aria-label={edge.label || "继续"}>
                                        {i + 1}
                                    </Button>
                                ),
                        )}
                </div>
            )}
            {feedback ? (
                <>
                    <p role="status">{feedback.feedback}</p>
                    <Button onClick={() => onAction(feedback)}>继续剧情</Button>
                </>
            ) : (
                <div className="film-actions">
                    {exits.map((edge, i) => (
                        <Button key={i} onClick={() => choose(edge)}>
                            {edge.label || "继续"}
                        </Button>
                    ))}
                </div>
            )}
        </>
    );
}

export function NodeMediaEditor({
    scene,
    projectId,
    episodes,
    onMedia,
    initialEpisode,
    loading,
    onUpload,
}: {
    scene: FilmScene;
    projectId?: string;
    episodes: DramaEpisodeRow[];
    onMedia: (resourceId: string) => void;
    initialEpisode?: string;
    loading: boolean;
    onUpload: (file: File) => void;
}) {
    const clip = scene.media?.kind === "clip";
    const [episode, setEpisode] = useState(initialEpisode || "");
    const episodeId = episode || episodes[0]?.id;
    const query = useQuery({ queryKey: dramaKeys.episode(projectId || "", episodeId || ""), enabled: !!(clip && projectId && episodeId), queryFn: ({ signal }) => getDramaEpisode(projectId!, episodeId!, signal) });
    const segments = (query.data?.segments || []).filter((s) => s.videoResourceId && s.videoStatus === "ready");
    const url = useResourceMediaUrl(scene.media?.resourceId, clip ? "playback" : "original");
    return (
        <section className="film-media-config">
            {clip && episodes.length > 0 && (
                <>
                    <label>
                        制作集
                        <Select value={episodeId} onChange={setEpisode} options={episodes.map((e) => ({ value: e.id, label: `第 ${e.number} 集 · ${e.title}` }))} />
                    </label>
                    <label>
                        使用本集已生成的分镜视频
                        <Select
                            placeholder="选择剧情段视频"
                            disabled={loading}
                            loading={query.isFetching}
                            value={segments.find((s) => s.videoResourceId === scene.media?.resourceId)?.videoResourceId}
                            onChange={onMedia}
                            notFoundContent="本集还没有生成完成的剧情段视频"
                            options={segments.map((s) => ({ key: s.id, value: s.videoResourceId!, label: `${s.index + 1} · ${s.title}` }))}
                        />
                    </label>
                    {query.isError && <Alert type="error" title="读取本集剧情段失败" action={<Button onClick={() => void query.refetch()}>重试</Button>} />}
                </>
            )}
            <label>
                {clip ? "上传视频片段" : "事件图片或 GIF（可选）"}
                <input
                    type="file"
                    disabled={loading}
                    accept={clip ? "video/*" : "image/png,image/jpeg,image/webp,image/gif"}
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f) onUpload(f);
                    }}
                />
            </label>
            {loading && <span role="status">正在上传…</span>}
            {url && (clip ? <video src={url} controls playsInline /> : <img src={url} alt="事件底图" />)}
            {scene.media?.resourceId && (
                <Button disabled={loading} onClick={() => onMedia("")}>
                    移除素材
                </Button>
            )}
        </section>
    );
}

export function EventActionEditor({ edge, onChange }: { edge: FilmExit; onChange: (patch: Partial<FilmExit>) => void }) {
    return (
        <div className="film-event-action">
            <Input aria-label="点击后的反馈" placeholder="点击后的线索或反馈（可选）" maxLength={500} value={edge.feedback} onChange={(e) => onChange({ feedback: e.target.value })} />
            {edge.spot ? (
                <>
                    {(["x", "y"] as const).map((axis) => (
                        <label key={axis}>
                            {axis === "x" ? "水平位置" : "垂直位置"}
                            <InputNumber
                                aria-label={axis === "x" ? "水平位置" : "垂直位置"}
                                min={0}
                                max={100}
                                suffix="%"
                                value={edge.spot![axis]}
                                onChange={(n) => {
                                    if (n != null) onChange({ spot: { ...edge.spot!, [axis]: n } });
                                }}
                            />
                        </label>
                    ))}
                    <Button onClick={() => onChange({ spot: undefined })}>移除点击位置</Button>
                </>
            ) : (
                <Button onClick={() => onChange({ spot: { x: 50, y: 50 } })}>设置画面点击位置</Button>
            )}
        </div>
    );
}
