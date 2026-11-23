import { useState } from "react";
import { Alert, Button, Input, InputNumber, Select } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getDramaEpisode, type DramaEpisodeRow } from "@/services/api/drama";
import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { useResourceMediaUrl } from "@/pages/projects/drama-shared";
import { AssetLibraryPickerModal } from "@/components/assets/asset-library-picker-modal";
import { ASSET_CATEGORY_LABELS } from "@/lib/asset-category";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { importOfficialAssetToLibrary } from "@/services/api/official-assets";
import type { Asset } from "@/stores/use-asset-store";
import type { FilmExit, FilmScene } from "@/services/api/interactive-films";

export function NodeMediaEditor({
    scene,
    projectId,
    episodes,
    onMedia,
    onPosition,
    initialEpisode,
    loading,
    onUpload,
}: {
    scene: FilmScene;
    projectId?: string;
    episodes: DramaEpisodeRow[];
    onMedia: (resourceId: string) => void;
    onPosition: (index: number, x: number, y: number) => void;
    initialEpisode?: string;
    loading: boolean;
    onUpload: (file: File) => void;
}) {
    const clip = scene.media?.kind === "clip";
    const [picking, setPicking] = useState(false);
    function pickedResource(asset?: Asset | { kind: string; data: { storageKey: string } }) {
        if ((clip && asset?.kind === "video") || (!clip && asset?.kind === "image")) return resourceIdFromStorageKey(asset.data.storageKey);
    }
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
            <Button disabled={loading} onClick={() => setPicking(true)}>
                {clip ? "从素材库选视频" : "从素材库选底图"}
            </Button>
            {picking && (
                <AssetLibraryPickerModal
                    open
                    remoteLibrary
                    remoteKind={clip ? "video" : "image"}
                    acceptRemoteItems
                    multiple={false}
                    items={[]}
                    categoryLabels={ASSET_CATEGORY_LABELS}
                    remoteItemDisabledReason={(asset) => (pickedResource(asset) ? undefined : "请选择已同步的对应类型素材")}
                    onClose={() => setPicking(false)}
                    onConfirm={async ([id], items) => {
                        const item = items?.find((entry) => entry.id === id);
                        const asset = item?.officialAsset ? (await importOfficialAssetToLibrary(item.officialAsset.id)).asset : item?.asset;
                        const resource = pickedResource(asset);
                        if (!resource) throw Error("请选择已同步的对应类型素材");
                        onMedia(resource);
                        setPicking(false);
                    }}
                />
            )}
            {loading && <span role="status">正在上传…</span>}
            {clip ? (
                url && <video src={url} controls playsInline />
            ) : (
                <div className="film-event-frame" data-image={!!url} aria-label="事件画面布局">
                    {url && <img className="film-event-background" src={url} alt="事件底图" />}
                    <p className="film-screen-caption">{scene.script}</p>
                    {scene.exits.map(
                        (edge, i) =>
                            edge.spot && (
                                <button
                                    type="button"
                                    className="film-event-spot"
                                    key={edge.id || i}
                                    aria-label={"移动热点 · " + edge.label}
                                    style={{ left: edge.spot.x + "%", top: edge.spot.y + "%", touchAction: "none" }}
                                    onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
                                    onPointerMove={(e) => {
                                        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                                        const box = e.currentTarget.parentElement!.getBoundingClientRect();
                                        const percent = (n: number) => Math.round(Math.min(100, Math.max(0, n * 100)));
                                        onPosition(i, percent((e.clientX - box.left) / box.width), percent((e.clientY - box.top) / box.height));
                                    }}
                                >
                                    {edge.label || "继续"}
                                </button>
                            ),
                    )}
                </div>
            )}
            {scene.media?.resourceId && (
                <Button disabled={loading} onClick={() => onMedia("")}>
                    移除素材
                </Button>
            )}
        </section>
    );
}

export function EventActionEditor({ edge, onChange, onUpload, loading }: { onUpload: (f: File) => void; loading: boolean; edge: FilmExit; onChange: (patch: Partial<FilmExit>) => void }) {
    return (
        <div className="film-event-action">
            <Input aria-label="点击后的反馈" placeholder="点击后的线索或反馈（可选）" maxLength={500} value={edge.feedback} onChange={(e) => onChange({ feedback: e.target.value })} />
            {edge.spot ? (
                <>
                    <label>
                        热点外观
                        <Select
                            value={edge.spot.appearance || "glow"}
                            options={[
                                { value: "glow", label: "呼吸光圈" },
                                { value: "static", label: "静态标记" },
                            ]}
                            onChange={(appearance) => onChange({ spot: { ...edge.spot!, appearance } })}
                        />
                    </label>
                    <label>
                        热点图片 / GIF
                        <input
                            type="file"
                            disabled={loading}
                            accept="image/png,image/jpeg,image/webp,image/gif"
                            onChange={(e) => {
                                const f = e.target.files?.[0];
                                e.target.value = "";
                                if (f) onUpload(f);
                            }}
                        />
                    </label>
                    {edge.spot.resourceId && <Button onClick={() => onChange({ spot: { ...edge.spot!, resourceId: undefined } })}>移除贴图</Button>}
                    {(["width", "height"] as const).map((k) => (
                        <label key={k}>
                            {k === "width" ? "热区宽度 %" : "热区高度 %"}
                            <InputNumber min={1} max={100} placeholder="自动" value={edge.spot?.[k]} onChange={(n) => onChange({ spot: { ...edge.spot!, [k]: n ?? undefined } })} />
                        </label>
                    ))}
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
