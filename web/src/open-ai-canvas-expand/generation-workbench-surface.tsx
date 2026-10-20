import { GenerationWorkbench } from "@open-ai-canvas/expand";
import { App, Button, Popover, Select } from "antd";
import { Download, FileImage, Images, Mic, RefreshCw, Square, Upload, Video, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { AssetLibraryPickerModal, type AssetLibraryPickerItem, type AssetPickerMediaKind } from "@/components/assets/asset-library-picker-modal";
import { VoiceRecordingInline } from "@/components/conversation/voice-recording-inline";
import { CanvasNodeMaskEditDialog, type CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { MediaPreview } from "@/components/media-preview";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { canvasThemes } from "@/lib/canvas-theme";
import { modelCapabilityConfigFor, normalizeImageValue, normalizeVideoValue } from "@/lib/model-capabilities";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { resourceStorageKey } from "@/services/api/resources";
import { localSavedRemotePendingMessage, saveRemoteUserDataNow } from "@/services/user-data-sync";
import { workbenchCategories } from "@/pages/workbench/workbench-catalog";
import { workbenchTaskSnapshot } from "@/pages/workbench/image-workbench-page";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

import { useWorkbenchDirector } from "./use-workbench-director";
import { useWorkbenchOutputMetadata } from "./use-workbench-output-metadata";
import { expandResourceFileURL } from "./generation-api";
import type { WorkbenchReference, WorkbenchSurfaceController } from "./workbench-contract";
import {
    clearWorkbenchMaskPendingSubmission,
    readWorkbenchDraft,
    readWorkbenchMaskPendingSubmission,
    writeWorkbenchDraft,
    writeWorkbenchMaskPendingSubmission,
    workbenchSessionEpoch,
    type WorkbenchSessionDraft,
} from "./workbench-session";
import { assetReferenceData, safeWorkbenchDownloadURL, taskOutputPreviews, workbenchDeliveryState } from "./workbench-task-output";
import {
    assignWorkbenchReferenceRole,
    historicalImageParameterIssue,
    historicalVideoParameterIssue,
    serializedWorkbenchImageParameters,
    workbenchFrameRoleConflict,
} from "./workbench-support";

type MediaKind = "image" | "video" | "audio";

function referenceFromAsset(asset: Asset): WorkbenchReference | null {
    const media = assetReferenceData(asset);
    if (!media) return null;
    return {
        id: crypto.randomUUID(),
        name: asset.title,
        kind: media.kind,
        resourceId: media.resourceId,
        previewUrl: media.previewUrl,
        progress: 100,
        uploading: false,
        role: "reference",
    };
}

export function GenerationWorkbenchSurface({ controller }: { controller: WorkbenchSurfaceController }) {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);
    const canvasTheme = canvasThemes[useThemeStore((state) => state.theme)];
    const userId = useUserStore((state) => state.user?.id || "guest");
    const [mode, setMode] = useState<"compose" | "directory" | "director">("compose");
    const [tasksCollapsed, setTasksCollapsed] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [promptLibraryOpen, setPromptLibraryOpen] = useState(false);
    const [voiceOpen, setVoiceOpen] = useState(false);
    const [maskOpen, setMaskOpen] = useState(false);
    const [maskSubmitting, setMaskSubmitting] = useState(false);
    const [maskPending, setMaskPending] = useState(() => readWorkbenchMaskPendingSubmission(userId));
    const [historicalParameters, setHistoricalParameters] = useState<Record<string, unknown> | null>(null);
    const directorImageInputRef = useRef<HTMLInputElement>(null);
    const directorAudioInputRef = useRef<HTMLInputElement>(null);
    const workbenchRevisionRef = useRef(0);
    const promptSavePending = useRef(false);
    const savedPrompt = useRef<{ content: string; id: string } | null>(null);
    const hydratedDraftKey = useRef("");
    const profile = useMemo(() => modelCapabilityConfigFor(controller.config, controller.selectedModel), [controller.config, controller.selectedModel]);
    const outputTask = controller.resultTask;
    const outputs = outputTask ? taskOutputPreviews(outputTask) : [];
    const [activeOutputIndex, setActiveOutputIndex] = useState(0);
    const activeOutput = outputs[Math.min(activeOutputIndex, Math.max(0, outputs.length - 1))];
    const outputMetadata = useWorkbenchOutputMetadata(activeOutput?.status === "ready" ? activeOutput.resourceId : undefined, userId);
    const historicalSnapshot = outputTask ? workbenchTaskSnapshot(outputTask) : null;
    const requiresMaskRedraw = controller.kind === "image" && historicalSnapshot?.edit === "mask";
    const maskSourceResourceId = requiresMaskRedraw ? historicalSnapshot.sourceResourceId : activeOutput?.resourceId;
    const maskSourceURL = maskSourceResourceId ? expandResourceFileURL(maskSourceResourceId) : activeOutput?.url;
    const mediaAssets = assets.filter((asset) => asset.status !== "archived" && (asset.kind === "image" || asset.kind === "video" || asset.kind === "audio"));
    const textAssets = assets.filter((asset): asset is Extract<Asset, { kind: "text" }> => asset.status !== "archived" && asset.kind === "text");
    const director = useWorkbenchDirector({
        kind: controller.kind,
        prompt: controller.prompt,
        references: controller.references,
        seconds: controller.config.videoSeconds || "6",
        userId,
        workbenchRevisionRef,
    });
    const referenceLimit =
        controller.kind === "image"
            ? profile.image?.references.maxImages || 0
            : (profile.video?.references.maxImages || 0) + (profile.video?.references.maxVideos || 0) + (profile.video?.references.maxAudios || 0);
    const promptLimit = controller.kind === "image" ? profile.image?.references.promptMaxChars || 32000 : profile.video?.references.promptMaxChars || 8000;
    const referenceLimits: Record<MediaKind, number> = controller.kind === "image"
        ? { image: profile.image?.references.maxImages || 0, video: 0, audio: 0 }
        : { image: profile.video?.references.maxImages || 0, video: profile.video?.references.maxVideos || 0, audio: profile.video?.references.maxAudios || 0 };
    const pickerMediaKinds = (Object.entries(referenceLimits) as Array<[MediaKind, number]>).filter(([, limit]) => limit > 0).map(([mediaKind]) => mediaKind) as AssetPickerMediaKind[];
    const unsupportedReferenceKind = (Object.entries(referenceLimits) as Array<[MediaKind, number]>).find(([mediaKind, limit]) => controller.references.filter((reference) => reference.kind === mediaKind).length > limit)?.[0];
    const historicalParameterIssue = historicalParameters
        ? controller.kind === "image" && profile.image
            ? historicalImageParameterIssue(profile.image, historicalParameters)
            : controller.kind === "video" && profile.video
              ? historicalVideoParameterIssue(profile.video, historicalParameters)
              : undefined
        : undefined;
    const composerDirty = Boolean(controller.prompt.trim() || controller.references.length || controller.tool);
    const validationMessage =
        controller.prompt.length > promptLimit
            ? `提示词超过 ${promptLimit} 字，请缩短后提交`
            : requiresMaskRedraw
            ? "该历史任务是局部编辑，请重新涂抹选区后提交"
            : historicalParameterIssue
              ? historicalParameterIssue
            : controller.references.some((reference) => reference.uploading)
            ? "参考素材仍在上传"
            : controller.references.some((reference) => reference.error || !reference.resourceId)
              ? "请移除或重新上传不可用素材"
              : unsupportedReferenceKind
                ? `当前模型不支持这么多${unsupportedReferenceKind === "image" ? "图片" : unsupportedReferenceKind === "video" ? "视频" : "音频"}素材`
              : controller.kind === "video"
                ? workbenchFrameRoleConflict(controller.references)
                : undefined;
    const draft = useMemo<WorkbenchSessionDraft>(() => ({
        prompt: controller.prompt,
        directorContextId: director.contextId,
        directorLanguage: director.language,
        ...(controller.tool ? { toolId: controller.tool.id } : {}),
        ...(controller.preset ? { presetId: controller.preset.id } : {}),
        model: controller.selectedModel,
        parameters: controller.parameters,
        references: controller.references.flatMap((reference) => reference.resourceId ? [{ resourceId: reference.resourceId, kind: reference.kind, role: reference.role, ...(reference.slotKey ? { slotKey: reference.slotKey } : {}), name: reference.name }] : []),
    }), [controller.parameters, controller.preset, controller.prompt, controller.references, controller.selectedModel, controller.tool, director.contextId, director.language]);

    useEffect(() => {
        const key = `${userId}:${controller.kind}`;
        if (hydratedDraftKey.current === key || controller.directoryLoading) return;
        hydratedDraftKey.current = key;
        const saved = readWorkbenchDraft(userId, controller.kind);
        if (!saved) return;
        if (saved.directorContextId) director.setContextId(saved.directorContextId);
        if (saved.directorLanguage) director.setLanguage(saved.directorLanguage);
        controller.chooseTool(saved.toolId ? controller.tools.find((tool) => tool.id === saved.toolId) || null : null);
        controller.setPrompt(saved.prompt);
        if (saved.model && controller.models.includes(saved.model)) controller.selectModel(saved.model);
        controller.applyParameters(saved.parameters);
        controller.setReferences(saved.references.map((reference) => ({
            id: crypto.randomUUID(),
            name: reference.name || "参考素材",
            kind: reference.kind,
            resourceId: reference.resourceId,
            previewUrl: expandResourceFileURL(reference.resourceId),
            progress: 100,
            uploading: false,
            role: reference.role || "reference",
            ...(reference.slotKey ? { slotKey: reference.slotKey } : {}),
        })));
    }, [controller, director, userId]);

    useEffect(() => {
        if (hydratedDraftKey.current !== `${userId}:${controller.kind}`) return;
        writeWorkbenchDraft(userId, controller.kind, draft);
    }, [controller.kind, draft, userId]);

    useEffect(() => {
        setMaskPending(readWorkbenchMaskPendingSubmission(userId));
        setMaskOpen(false);
        setHistoricalParameters(null);
    }, [userId]);

    const repairHistoricalParameters = () => {
        if (!historicalParameters) return;
        if (controller.kind === "image" && profile.image) {
            const normalized = normalizeImageValue(profile.image, {
                size: typeof historicalParameters.size === "string" ? historicalParameters.size : undefined,
                quality: typeof historicalParameters.quality === "string" ? historicalParameters.quality : undefined,
                imageResolution: typeof historicalParameters.imageResolution === "string" ? historicalParameters.imageResolution : undefined,
                count: historicalParameters.count != null ? String(historicalParameters.count) : undefined,
                transparentBackground:
                    typeof historicalParameters.transparentBackground === "boolean" || typeof historicalParameters.transparentBackground === "string"
                        ? String(historicalParameters.transparentBackground)
                        : undefined,
                imageParameters: serializedWorkbenchImageParameters(historicalParameters),
            });
            controller.applyParameters({
                ratio: normalized.size,
                quality: normalized.quality,
                imageResolution: normalized.imageResolution || "auto",
                count: normalized.count,
                transparentBackground: normalized.transparentBackground,
                imageParameters: normalized.imageParameters || "",
            });
        } else if (controller.kind === "video" && profile.video) {
            const normalized = normalizeVideoValue(profile.video, {
                seconds: historicalParameters.seconds != null ? String(historicalParameters.seconds) : undefined,
                ratio: typeof historicalParameters.ratio === "string" ? historicalParameters.ratio : undefined,
                resolution: typeof historicalParameters.resolution === "string" ? historicalParameters.resolution : undefined,
            });
            controller.applyParameters({ seconds: normalized.seconds, ratio: normalized.ratio, videoQuality: normalized.resolution.replace(/p$/i, "") });
        }
        setHistoricalParameters(null);
    };

    const settingsPanel = controller.kind === "image" ? (
        <div className="w-[320px] space-y-3">
            {historicalParameterIssue ? (
                <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100" role="alert">
                    <p className="m-0">{historicalParameterIssue}</p>
                    <Button size="small" onClick={repairHistoricalParameters}>使用当前模型兼容参数</Button>
                </div>
            ) : null}
            <ImageSettingsPanel
                config={controller.composerConfig}
                onConfigChange={(key, value) => {
                    controller.applyParameters({ [key === "size" ? "ratio" : key]: value });
                    setHistoricalParameters((current) => current ? { ...current, [key]: value } : current);
                }}
                theme={canvasTheme}
                showTitle={false}
                maxCount={profile.image?.maxOutputs || 1}
                bypassPriceGuard
            />
        </div>
    ) : (
        <div className="space-y-3">
            {historicalParameterIssue ? (
                <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100" role="alert">
                    <p className="m-0">{historicalParameterIssue}</p>
                    <Button size="small" onClick={repairHistoricalParameters}>使用当前模型兼容参数</Button>
                </div>
            ) : null}
            {controller.settingsPanel}
        </div>
    );

    const pickerItems: AssetLibraryPickerItem[] = mediaAssets.flatMap((asset) => {
        const media = assetReferenceData(asset);
        if (!media) return [];
        return [{ id: asset.id, title: asset.title, category: asset.category || "other", kindLabel: media.kind === "image" ? "图片" : media.kind === "video" ? "视频" : "音频", mediaKind: media.kind, asset, imageUrl: media.previewUrl }];
    });
    const promptItems: AssetLibraryPickerItem[] = textAssets.map((asset) => ({ id: asset.id, title: asset.title, category: asset.category || "other", kindLabel: "文本", mediaKind: "text", asset, description: asset.data.content, searchText: asset.data.content }));

    const addComposerFiles = async (files: FileList | File[]) => {
        const groups = new Map<string, File[]>();
        const kindCounts = new Map<MediaKind, number>((Object.keys(referenceLimits) as MediaKind[]).map((mediaKind) => [mediaKind, controller.references.filter((reference) => reference.kind === mediaKind).length]));
        const slotCounts = new Map((controller.tool?.inputContract?.slots || []).map((slot) => [slot.key, controller.references.filter((reference) => reference.slotKey === slot.key).length]));
        let rejected = 0;
        for (const file of Array.from(files)) {
            const mediaKind: MediaKind | null = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : null;
            if (!mediaKind || (kindCounts.get(mediaKind) || 0) >= referenceLimits[mediaKind]) {
                rejected += 1;
                continue;
            }
            const slots = controller.tool?.inputContract?.slots || [];
            const slot = slots.length ? slots.find((item) => item.mediaTypes.includes(mediaKind) && (slotCounts.get(item.key) || 0) < item.maxCount) : undefined;
            if (slots.length && !slot) {
                rejected += 1;
                continue;
            }
            kindCounts.set(mediaKind, (kindCounts.get(mediaKind) || 0) + 1);
            if (slot) slotCounts.set(slot.key, (slotCounts.get(slot.key) || 0) + 1);
            const groupKey = slot?.key || "";
            groups.set(groupKey, [...(groups.get(groupKey) || []), file]);
        }
        if (rejected) message.warning(`${rejected} 个文件不符合当前模型或工具的类型/数量限制，未上传`);
        for (const [slotKey, accepted] of groups) await controller.addFiles(accepted, slotKey || undefined);
    };

    const addDirectorFiles = async (files: FileList | File[], mediaKind: "image" | "audio") => {
        const accepted = Array.from(files).filter((file) => file.type.startsWith(`${mediaKind}/`));
        const pending = accepted.map((file): WorkbenchReference => ({ id: crypto.randomUUID(), name: file.name, kind: mediaKind, previewUrl: URL.createObjectURL(file), progress: 0, uploading: true, role: "reference" }));
        controller.setReferences((current) => [...current, ...pending]);
        await Promise.all(pending.map(async (reference, index) => {
            try {
                const resource = await controller.uploadResource(accepted[index], mediaKind, { fileName: accepted[index].name });
                controller.setReferences((current) => current.map((item) => item.id === reference.id ? { ...item, resourceId: resource.id, uploading: false, progress: 100 } : item));
            } catch (error) {
                controller.setReferences((current) => current.map((item) => item.id === reference.id ? { ...item, uploading: false, error: error instanceof Error ? error.message : "上传失败" } : item));
            }
        }));
    };

    const executeMaskTask = async (pending: NonNullable<typeof maskPending>) => {
        setMaskSubmitting(true);
        try {
            await controller.submitDirectTask(pending.input);
            clearWorkbenchMaskPendingSubmission(userId);
            setMaskPending(null);
            setMaskOpen(false);
            message.success("局部编辑任务已提交");
        } catch (error) {
            message.error(error instanceof Error ? `局部编辑提交状态待确认：${error.message}` : "局部编辑提交状态待确认");
        } finally {
            setMaskSubmitting(false);
        }
    };

    const submitMaskEdit = async (payload: CanvasImageMaskEditPayload) => {
        if (!outputTask || !maskSourceResourceId || maskSubmitting) return;
        const clientOperationId = crypto.randomUUID();
        const epoch = workbenchSessionEpoch(userId);
        const assertSession = () => {
            if (useUserStore.getState().user?.id !== userId || workbenchSessionEpoch(userId) !== epoch) throw new DOMException("账号已切换", "AbortError");
        };
        setMaskSubmitting(true);
        try {
            const maskBlob = await fetch(payload.maskDataUrl).then((response) => response.blob());
            assertSession();
            const maskResource = await controller.uploadResource(maskBlob, "image", { fileName: "mask.png", idempotencyKey: `${clientOperationId}:mask` });
            assertSession();
            const prepared = await prepareBackendGenerationTask({
                mode: "image",
                prompt: payload.prompt,
                config: { ...controller.composerConfig, ...payload.generationConfig },
                referenceImages: [{ id: `${outputTask.id}-source`, name: "局部编辑原图", type: "image/*", dataUrl: "", storageKey: resourceStorageKey(maskSourceResourceId) }],
                mask: { id: `${outputTask.id}-mask`, name: "mask.png", type: "image/png", dataUrl: "", storageKey: resourceStorageKey(maskResource.id) },
                metadata: { source: "workbench", workbenchKind: "image", edit: "mask", sourceTaskId: requiresMaskRedraw ? historicalSnapshot.sourceTaskId || outputTask.id : outputTask.id, sourceResourceId: maskSourceResourceId,
                    workbench: { kind: "image", parameters: { size: controller.parameters.ratio, quality: controller.parameters.quality, imageResolution: controller.parameters.imageResolution, count: controller.parameters.count, ...payload.generationConfig }, references: [{ resourceId: maskSourceResourceId, kind: "image", role: "reference" }] },
                },
            });
            assertSession();
            const pending = { fingerprint: JSON.stringify(prepared), clientOperationId, input: { ...prepared, clientOperationId } };
            writeWorkbenchMaskPendingSubmission(userId, pending);
            setMaskPending(pending);
            await executeMaskTask(pending);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "局部编辑提交失败");
            setMaskSubmitting(false);
        }
    };

    const replaceDraft = (action: () => void, content: string) => {
        const apply = () => {
            workbenchRevisionRef.current += 1;
            setVoiceOpen(false);
            setHistoricalParameters(null);
            action();
        };
        if (!composerDirty) return apply();
        modal.confirm({ title: "放弃当前修改？", content, okText: "放弃修改并继续", cancelText: "继续编辑", onOk: apply });
    };

    const savePrompt = async () => {
        const content = controller.prompt.trim();
        if (!content || promptSavePending.current) return;
        const epoch = workbenchSessionEpoch(userId);
        const isCurrent = () => useUserStore.getState().user?.id === userId && workbenchSessionEpoch(userId) === epoch;
        promptSavePending.current = true;
        try {
            if (savedPrompt.current?.content !== content || !useAssetStore.getState().assets.some((asset) => asset.id === savedPrompt.current?.id)) {
                const id = addAsset({ kind: "text", title: content.slice(0, 24), category: "other", coverUrl: "", tags: [], source: "生成工作台", data: { content } });
                savedPrompt.current = { content, id };
            }
            // The host owns local persistence, remote acknowledgement and retries.
            await saveRemoteUserDataNow([]);
            if (isCurrent()) message.success("提示词已保存到素材库");
        } catch (error) {
            if (isCurrent()) message.warning(localSavedRemotePendingMessage("提示词已本地保存", error));
        } finally {
            promptSavePending.current = false;
        }
    };

    const surface = (
        <GenerationWorkbench
            kind={controller.kind}
            mode={mode}
            mobileView={controller.mobileTab === "result" ? "preview" : controller.mobileTab === "tasks" ? "tasks" : "compose"}
            onModeChange={setMode}
            onMobileViewChange={(view) => controller.setMobileTab(view === "preview" ? "result" : view)}
            composer={{
                title: controller.tool?.name || (controller.kind === "image" ? "图片创作" : "视频创作"),
                presetLabel: controller.preset?.name,
                prompt: controller.prompt,
                promptPlaceholder: controller.tool?.inputHint || "描述你想生成的画面、镜头与细节",
                promptMaxLength: promptLimit,
                referenceItems: controller.references.map((reference) => ({
                    id: reference.id,
                    label: reference.name,
                    preview: reference.kind === "image" ? <img src={reference.previewUrl} alt="" /> : reference.kind === "video" ? <video src={reference.previewUrl} muted /> : <span>音频</span>,
                    status: reference.uploading ? "uploading" : reference.error ? "failed" : "ready",
                    statusLabel: reference.error,
                    controls:
                        controller.kind === "video" && reference.kind === "image" ? (
                            <Select
                                aria-label={`素材角色 ${reference.name}`}
                                size="small"
                                value={reference.role}
                                onChange={(role) => controller.setReferences((current) => assignWorkbenchReferenceRole(current, reference.id, role))}
                                options={[{ label: "参考图", value: "reference" }, { label: "首帧", value: "first_frame" }, { label: "尾帧", value: "last_frame" }]}
                            />
                        ) : undefined,
                    onRemove: () => controller.removeReference(reference),
                })),
                referenceCountLabel: `${controller.references.length} / ${referenceLimit}`,
                referenceLimit,
                validationMessage,
                dirty: composerDirty,
                canSavePrompt: Boolean(controller.prompt.trim()),
                canOpenPromptLibrary: true,
                canOpenDirector: controller.kind === "video",
                onPromptChange: controller.setPrompt,
                onNew: () => replaceDraft(() => {
                    director.setContextId(crypto.randomUUID());
                    controller.resetWorkbench();
                }, "新建会清空当前提示词和参考素材，历史任务与素材会保留。"),
                onAddReference: () => setAssetPickerOpen(true),
                onSavePrompt: () => void savePrompt(),
                onOpenPromptLibrary: () => setPromptLibraryOpen(true),
                onOpenDirector: () => setMode("director"),
            }}
            directory={{
                categories: [{ id: "all", label: "全部" }, ...workbenchCategories.map((category) => ({ id: category.value, label: category.label }))],
                activeCategoryId: controller.toolCategory,
                searchQuery: controller.toolSearch,
                items: controller.filteredTools.map((tool) => ({ id: tool.id, title: tool.name, description: tool.subtitle || tool.description, categoryId: tool.categoryId, thumbnail: tool.iconUrl ? <img src={tool.iconUrl} alt="" /> : controller.kind === "image" ? <Images /> : <Video /> })),
                loading: controller.directoryLoading,
                error: controller.directoryError,
                onCategoryChange: controller.setToolCategory,
                onSearchQueryChange: controller.setToolSearch,
                onSelectItem: (id) => replaceDraft(() => {
                    controller.chooseTool(controller.tools.find((tool) => tool.id === id) || null);
                    setMode("compose");
                }, "切换工具会替换当前创作设置。"),
                onRetry: () => void controller.reloadTools(),
            }}
            preview={{
                status: outputTask ? workbenchDeliveryState(outputTask, outputs).status : "empty",
                heading: outputTask ? workbenchDeliveryState(outputTask, outputs).label : controller.kind === "image" ? "从左侧开始创作图片" : "从左侧开始创作视频",
                description: outputTask?.error || (outputTask?.materializationErrorCode ? "作品保存未完成，请查看产物状态；不要重复生成。" : outputTask?.stage) || "生成结果会在这里显示",
                media: activeOutput?.url && activeOutput.status === "ready" ? <MediaPreview key={activeOutput.id} src={activeOutput.url} kind={activeOutput.kind} alt={`生成产物 ${activeOutput.outputIndex + 1}`} controls={activeOutput.kind === "video"} /> : undefined,
                outputs: outputs.map((output) => ({ id: output.id, label: `产物 ${output.outputIndex + 1}`, thumbnail: output.kind === "image" && output.url ? <img src={output.url} alt="" /> : <Video />, status: output.status })),
                activeOutputId: activeOutput?.id,
                metadata: outputTask ? [{ label: "模型", value: controller.taskModelLabel(outputTask) }, ...outputMetadata,
                    ...(historicalSnapshot?.parameters ? [{ label: "生成参数", value: [historicalSnapshot.parameters.size || historicalSnapshot.parameters.ratio, historicalSnapshot.parameters.quality, historicalSnapshot.parameters.imageResolution || historicalSnapshot.parameters.resolution, historicalSnapshot.parameters.seconds ? `目标 ${historicalSnapshot.parameters.seconds} 秒` : undefined].filter(Boolean).join(" · ") }].filter((item) => item.value) : []),
                ] : [],
                actions: [
                    ...(activeOutput?.url && activeOutput.status === "ready" ? [{ id: "download", label: "下载", icon: <Download className="size-4" />, onSelect: () => {
                        const href = safeWorkbenchDownloadURL(activeOutput.url);
                        if (!href) {
                            message.error("该产物地址不允许下载");
                            return;
                        }
                        const anchor = document.createElement("a");
                        anchor.href = href;
                        anchor.download = `${controller.kind}-${outputTask?.id || "output"}-${activeOutput.outputIndex + 1}`;
                        anchor.rel = "noopener noreferrer";
                        anchor.click();
                    } }] : []),
                    ...(controller.kind === "image" && maskSourceResourceId && (requiresMaskRedraw || activeOutput?.status === "ready") && profile.image?.references.maskSupported ? [{ id: "mask", label: requiresMaskRedraw ? "重新涂抹选区" : "局部编辑", icon: <WandSparkles className="size-4" />, onSelect: () => setMaskOpen(true) }] : []),
                    ...(outputTask?.canRecoverMedia ? [{ id: "recover", label: "重试保存", icon: <RefreshCw className="size-4" />, disabled: controller.taskBusyId === outputTask.id, onSelect: () => void controller.recoverTaskMedia(outputTask) }] : []),
                    ...(outputTask && (outputTask.status === "queued" || outputTask.status === "running") ? [{ id: "cancel", label: "取消任务", icon: <Square className="size-4" />, disabled: controller.taskBusyId === outputTask.id, onSelect: () => void controller.cancelTask(outputTask) }] : []),
                    ...(outputTask && !outputTask.canRecoverMedia && (outputTask.status === "failed" || outputTask.status === "cancelled") ? [{ id: "retry", label: "重新生成", icon: <RefreshCw className="size-4" />, disabled: controller.taskBusyId === outputTask.id, onSelect: () => void controller.retryTask(outputTask) }] : []),
                ],
                onSelectOutput: (id) => setActiveOutputIndex(Math.max(0, outputs.findIndex((output) => output.id === id))),
            }}
            tasks={{
                title: "最近任务",
                scopeLabel: `最近 ${Math.min(100, controller.tasks.length)} 项`,
                items: controller.tasks.map((task) => {
                    const taskOutputs = taskOutputPreviews(task);
                    const preview = taskOutputs.find((output) => output.status === "ready");
                    const delivery = workbenchDeliveryState(task, taskOutputs);
                    return { id: task.id, title: controller.taskModelLabel(task), createdAtLabel: new Date(task.createdAt).toLocaleString(), status: delivery.status, statusLabel: delivery.label, secondaryLabel: task.prompt, thumbnail: preview?.kind === "image" && preview.url ? <img src={preview.url} alt="" /> : controller.kind === "video" ? <Video /> : <FileImage /> };
                }),
                selectedTaskId: outputTask?.id,
                loading: controller.tasksLoading,
                collapsed: tasksCollapsed,
                onCollapsedChange: setTasksCollapsed,
                onSelectTask: (id) => {
                    const task = controller.tasks.find((item) => item.id === id);
                    if (!task) return;
                    const openTask = () => {
                        workbenchRevisionRef.current += 1;
                        setVoiceOpen(false);
                        const snapshot = workbenchTaskSnapshot(task);
                        const parameters = snapshot?.kind === controller.kind ? snapshot.parameters : null;
                        void controller.openTask(task)
                            .then(() => {
                                if (controller.kind === "image" && parameters) {
                                    controller.applyParameters({
                                        imageParameters: serializedWorkbenchImageParameters(parameters),
                                        transparentBackground:
                                            typeof parameters.transparentBackground === "boolean" || typeof parameters.transparentBackground === "string"
                                                ? String(parameters.transparentBackground)
                                                : "false",
                                    });
                                }
                                setHistoricalParameters(parameters);
                            })
                            .catch((error) => message.error(error instanceof Error ? error.message : "历史任务加载失败"));
                    };
                    if (!composerDirty || outputTask?.id === task.id) {
                        openTask();
                        return;
                    }
                    modal.confirm({
                        title: "放弃当前修改？",
                        content: "切换历史任务会覆盖当前提示词、参数和参考素材。",
                        okText: "放弃修改并继续",
                        cancelText: "继续编辑",
                        onOk: openTask,
                    });
                },
                onOpenHistory: () => navigate("/tasks"),
            }}
            quote={{ status: controller.estimateLabel ? "estimated" : "idle", label: controller.estimateLabel }}
            submit={{ label: controller.kind === "image" ? "立即生成图片" : "立即生成视频", disabled: controller.busy || Boolean(validationMessage) || !controller.selectedModel, pending: controller.busy, disabledReason: validationMessage, onSubmit: () => void controller.submit() }}
            director={controller.kind === "video" ? {
                prompt: controller.prompt,
                suggestions: ["口播带货", "品牌广告", "剧情短片"],
                validationMessage: !controller.references.some((reference) => reference.kind === "image" && reference.resourceId) ? "至少添加一张图片素材" : undefined,
                submitLabel: director.busy ? "正在进入 Agent…" : "进入 Agent，分析素材与脚本",
                submitDisabled: director.busy || !controller.prompt.trim() || !controller.references.some((reference) => reference.kind === "image" && reference.resourceId),
                languageInput: <Select value={director.language} onChange={director.setLanguage} options={[{ value: "zh-CN", label: "中文" }, { value: "en-US", label: "English" }]} />,
                imageInput: <><Button icon={<Upload className="size-4" />} onClick={() => directorImageInputRef.current?.click()}>上传图片</Button><input ref={directorImageInputRef} className="hidden" type="file" accept="image/*" onChange={(event) => { if (event.target.files) void addDirectorFiles(event.target.files, "image"); event.target.value = ""; }} /></>,
                audioInput: <><Button icon={<Upload className="size-4" />} onClick={() => directorAudioInputRef.current?.click()}>上传音频</Button><input ref={directorAudioInputRef} className="hidden" type="file" accept="audio/*" onChange={(event) => { if (event.target.files) void addDirectorFiles(event.target.files, "audio"); event.target.value = ""; }} /></>,
                durationInput: <Select value={controller.parameters.seconds || "6"} onChange={(seconds) => controller.applyParameters({ seconds })} options={(profile.video?.duration.values || [6]).map((value) => ({ value: String(value), label: `${value} 秒` }))} />,
                onPromptChange: controller.setPrompt,
                onSuggestionSelect: (suggestion) => controller.setPrompt((current) => current.trim() ? `${current.trim()}，${suggestion}` : suggestion),
                onSubmit: () => void director.submit(),
                onExit: () => setMode("compose"),
            } : undefined}
            slots={{
                pendingSubmission: maskPending || controller.hasPendingSubmission ? <div className="flex flex-wrap items-center gap-2" role="status">{controller.hasPendingSubmission ? <Button size="small" onClick={() => void controller.recoverPendingSubmission().catch((error) => message.error(error instanceof Error ? `任务详情仍不可用：${error.message}` : "任务详情仍不可用"))}>恢复待确认生成</Button> : null}{maskPending ? <Button size="small" loading={maskSubmitting} onClick={() => void executeMaskTask(maskPending)}>恢复待确认局部编辑</Button> : null}<span className="text-xs text-muted-foreground">恢复已冻结的原请求，不会创建新的提交。</span></div> : undefined,
                modelPicker: <ModelPicker config={controller.composerConfig} value={controller.selectedModel} onChange={controller.selectModel} capability={controller.kind} showSelectedPrice={false} />,
                settingsPanel: <Popover trigger="click" placement="topLeft" content={settingsPanel} arrow={false}><Button>{controller.kind === "image" ? "图片设置" : "视频设置"}</Button></Popover>,
                referenceInput: <div className="flex gap-2"><Button icon={<Images className="size-4" />} onClick={() => setAssetPickerOpen(true)}>素材库</Button><Button icon={<Upload className="size-4" />} onClick={() => controller.fileRef.current?.click()}>上传</Button><input ref={controller.fileRef} className="hidden" type="file" multiple accept={pickerMediaKinds.map((mediaKind) => `${mediaKind}/*`).join(",")} onChange={(event) => { if (event.target.files) void addComposerFiles(event.target.files); event.target.value = ""; }} /></div>,
                voiceInput: voiceOpen ? <VoiceRecordingInline onTranscribed={(text) => { controller.setPrompt((current) => `${current}${current.trim() ? "\n" : ""}${text}`); setVoiceOpen(false); }} onCancel={() => setVoiceOpen(false)} /> : <Button type="text" icon={<Mic className="size-4" />} onClick={() => setVoiceOpen(true)} />,
                maskEditor: controller.kind === "image" && maskSourceURL ? <CanvasNodeMaskEditDialog dataUrl={maskSourceURL} config={controller.composerConfig} open={maskOpen && !maskSubmitting} onClose={() => setMaskOpen(false)} onConfirm={(payload) => void submitMaskEdit(payload)} /> : undefined,
            }}
        />
    );

    return (
        <WorkspacePage fluid scroll={false}>
            {surface}
            <AssetLibraryPickerModal open={assetPickerOpen} title="选择参考素材" items={pickerItems} mediaKinds={pickerMediaKinds} categoryLabels={{ all: "全部", other: "其他", character: "角色", scene: "场景", prop: "道具", reference: "参考", output: "产物" }} multiple initialSelectedIds={[]} onClose={() => setAssetPickerOpen(false)} onConfirm={(_, selected) => {
                const candidates = (selected || []).flatMap((item) => item.asset ? [referenceFromAsset(item.asset)] : []).filter((item): item is WorkbenchReference => Boolean(item));
                let rejected = 0;
                controller.setReferences((current) => {
                    const next = [...current];
                    for (const candidate of candidates) {
                        const kindCount = next.filter((reference) => reference.kind === candidate.kind).length;
                        if (kindCount >= referenceLimits[candidate.kind]) {
                            rejected += 1;
                            continue;
                        }
                        const slots = controller.tool?.inputContract?.slots || [];
                        const slot = slots.length ? slots.find((item) => item.mediaTypes.includes(candidate.kind) && next.filter((reference) => reference.slotKey === item.key).length < item.maxCount) : undefined;
                        if (slots.length && !slot) {
                            rejected += 1;
                            continue;
                        }
                        next.push(slot ? { ...candidate, slotKey: slot.key } : candidate);
                    }
                    return next;
                });
                if (rejected) message.warning(`${rejected} 个素材不符合当前模型或工具的类型/数量限制，未添加`);
                setAssetPickerOpen(false);
            }} />
            <AssetLibraryPickerModal open={promptLibraryOpen} title="我的提示词" items={promptItems} categoryLabels={{ all: "全部", other: "其他" }} mediaKinds={["text"]} multiple={false} initialSelectedIds={[]} onClose={() => setPromptLibraryOpen(false)} onConfirm={(_, selected) => {
                const asset = selected?.[0]?.asset;
                if (asset?.kind === "text") replaceDraft(() => controller.setPrompt(asset.data.content), "应用提示词会替换当前输入的文字。");
                setPromptLibraryOpen(false);
            }} />
        </WorkspacePage>
    );
}
