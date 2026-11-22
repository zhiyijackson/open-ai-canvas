import { useState } from "react";
import { Button, Select } from "antd";
import { Settings2 } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { DEFAULT_DRAMA_STYLE_ID, findDramaStyle } from "@/lib/drama/drama-styles";
import { dramaChoiceKey, dramaVideoOptionFits } from "@/lib/drama/model-choice";
import type { FilmSettings, FilmSetup } from "@/services/api/interactive-films";
import type { DramaModels } from "@/services/api/drama";
import { DramaStylePicker } from "@/pages/projects/style-picker";
import { AssetSchemePicker, defaultAssetSettings, useAssetSchemes } from "@/pages/projects/asset-scheme";
import { DramaModelPicker, useDramaModelCatalog } from "@/pages/projects/drama-model-picker";
import { DramaTextSteps, DramaAssetImageModels, VideoResolutionField } from "@/pages/projects/step-settings";
import { StoryboardRules } from "@/pages/projects/storyboard-rules";

const defaultStyle = findDramaStyle(DEFAULT_DRAMA_STYLE_ID);
export const initialFilmSetup: FilmSetup = {
    styleId: DEFAULT_DRAMA_STYLE_ID,
    settings: { styleName: defaultStyle?.name, stylePrompt: defaultStyle?.prompt, aspectRatio: "9:16", language: "中文普通话", episodeSeconds: 90, reviewMode: "every", mediaMode: "manual", videoContinuity: "tail_frame" },
};

export function FilmSetupEditor({ value, onChange }: { value: FilmSetup; onChange: (value: FilmSetup) => void }) {
    const [open, setOpen] = useState(false);
    const settings = { ...initialFilmSetup.settings, ...value.settings };
    const update = (patch: FilmSettings) => onChange({ ...value, settings: { ...settings, ...patch } });
    const catalog = useDramaModelCatalog().data;
    const models = { text: catalog?.defaults.text, image: catalog?.defaults.image, ...settings.models };
    const video = models.video || catalog?.options.video?.find((option) => dramaVideoOptionFits(option, settings.aspectRatio!, settings.videoContinuity!))?.choice;
    const videoOption = catalog?.options.video?.find((option) => dramaChoiceKey(option.choice) === dramaChoiceKey(video));
    const imageOption = catalog?.options.image?.find((option) => dramaChoiceKey(option.choice) === dramaChoiceKey(models.characterImage || models.image));
    const assetSchemes = useAssetSchemes();
    const assets = settings.assets || defaultAssetSettings(assetSchemes.data);
    const patchModels = (patch: Partial<DramaModels>) => update({ models: { ...settings.models, ...patch } });
    return (
        <>
            <Button icon={<Settings2 size={16} />} onClick={() => setOpen(true)}>
                制作设置
            </Button>
            <AppModal
                title="影游制作设置"
                open={open}
                onCancel={() => setOpen(false)}
                width={920}
                footer={
                    <Button type="primary" onClick={() => setOpen(false)}>
                        完成设置
                    </Button>
                }
            >
                <div className="film-setup-form">
                    <section>
                        <h3>作品</h3>
                        <div className="film-actions">
                            <label>
                                画幅 <Select value={settings.aspectRatio} options={["9:16", "16:9", "1:1"].map((value) => ({ value }))} onChange={(aspectRatio) => update({ aspectRatio })} />
                            </label>
                            <label>
                                对白语言 <Select value={settings.language} options={["中文普通话", "粤语", "英语", "日语"].map((value) => ({ value }))} onChange={(language) => update({ language })} />
                            </label>
                        </div>
                        <DramaStylePicker
                            value={value.styleId || DEFAULT_DRAMA_STYLE_ID}
                            onChange={(styleId) => {
                                const style = findDramaStyle(styleId);
                                onChange({ ...value, styleId, settings: { ...settings, styleName: style?.name, stylePrompt: style?.prompt } });
                            }}
                        />
                    </section>
                    <section>
                        <h3>制作模型</h3>
                        {(
                            [
                                ["text", "默认文本"],
                                ["image", "默认图片"],
                                ["video", "剧情段视频"],
                            ] as const
                        ).map(([cap, label]) => (
                            <label key={cap}>
                                {label}
                                <DramaModelPicker
                                    capability={cap}
                                    aspectRatio={cap === "video" ? settings.aspectRatio : undefined}
                                    value={cap === "video" ? video : models[cap]}
                                    onChange={(choice) => (cap === "video" ? update({ models: { ...settings.models, video: choice }, videoResolution: undefined }) : patchModels({ [cap]: choice }))}
                                />
                            </label>
                        ))}
                        <VideoResolutionField value={settings.videoResolution} option={videoOption} options={catalog?.options.video} onChange={(videoResolution) => update({ videoResolution })} />
                    </section>
                    <section>
                        <h3>分镜规则</h3>
                        <StoryboardRules
                            value={settings.storyboard}
                            episodeSeconds={settings.episodeSeconds!}
                            onEpisodeSecondsChange={(episodeSeconds) => update({ episodeSeconds })}
                            onChange={(storyboard) => update({ storyboard })}
                            maxVideoSeconds={videoOption?.maxVideoSeconds}
                            videoModelLabel={video?.label}
                        />
                    </section>
                    <section>
                        <h3>文字步骤</h3>
                        <DramaTextSteps
                            showPlan={false}
                            models={models}
                            onModelsChange={patchModels}
                            skills={{ bible: settings.bibleSkill, script: settings.scriptSkill, prompt: settings.promptSkill }}
                            onSkillChange={(step, skill) => update({ [`${step}Skill`]: skill })}
                            textThinking={settings.textThinking || {}}
                            onThinkingChange={(step, thinking) => update({ textThinking: { ...settings.textThinking, [step]: thinking } })}
                        />
                    </section>
                    <section>
                        <h3>角色、道具与场景参考图</h3>
                        <DramaAssetImageModels assets={assets} models={models} onAssetsChange={(assets) => update({ assets })} onModelsChange={patchModels} />
                        <AssetSchemePicker layout="compact" value={assets} imageModel={imageOption} sample={{ style: settings.stylePrompt || "", characterName: "主角", sceneName: "主场景" }} onChange={(assets) => update({ assets })} />
                    </section>
                    <section className="film-actions">
                        <label>
                            审阅方式{" "}
                            <Select
                                value={settings.reviewMode}
                                options={[
                                    { value: "every", label: "每集确认" },
                                    { value: "sample", label: "先看样片" },
                                    { value: "auto", label: "全自动" },
                                ]}
                                onChange={(reviewMode) => update({ reviewMode })}
                            />
                        </label>
                        <label>
                            生成节奏{" "}
                            <Select
                                value={settings.mediaMode}
                                options={[
                                    { value: "manual", label: "先出剧本与提示词，手动生成" },
                                    { value: "auto", label: "全自动出片" },
                                ]}
                                onChange={(mediaMode) => update({ mediaMode })}
                            />
                        </label>
                        <label>
                            段落衔接{" "}
                            <Select
                                value={settings.videoContinuity}
                                options={[
                                    { value: "tail_frame", label: "尾帧续接" },
                                    { value: "parallel", label: "各段独立" },
                                ]}
                                onChange={(videoContinuity) => update({ videoContinuity })}
                            />
                        </label>
                    </section>
                </div>
            </AppModal>
        </>
    );
}
