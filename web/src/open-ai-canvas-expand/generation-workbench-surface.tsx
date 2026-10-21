import { GenerationWorkbench } from "@open-ai-canvas/expand";
import { App, Button, ConfigProvider, Modal, Popover, Select } from "antd";
import { Download, FileImage, Images, RefreshCw, Square, Upload, Video, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { AssetLibraryPickerModal, type AssetLibraryPickerItem, type AssetPickerMediaKind } from "@/components/assets/asset-library-picker-modal";
import { CanvasNodeMaskEditDialog, type CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { CanvasResourceMentionTextarea } from "@/components/canvas/canvas-resource-mention-textarea";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { MediaPreview } from "@/components/media-preview";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { canvasThemes } from "@/lib/canvas-theme";
import { modelCapabilityConfigFor, normalizeImageValue } from "@/lib/model-capabilities";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { resourceStorageKey } from "@/services/api/resources";
import { localSavedRemotePendingMessage, saveRemoteUserDataNow } from "@/services/user-data-sync";
import { workbenchCategories } from "@/pages/workbench/workbench-catalog";
import { workbenchTaskSnapshot } from "@/pages/workbench/image-workbench-page";
import { missingWorkbenchInput, workbenchPromptRequired } from "@/pages/workbench/workbench-input";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { modelOptionName } from "@/stores/use-config-store";

import { useWorkbenchDirector } from "./use-workbench-director";
import { useWorkbenchOutputMetadata } from "./use-workbench-output-metadata";
import { WorkbenchImagePromptTools, useWorkbenchPromptTools, workbenchPromptReferences } from "./workbench-prompt-tools";
import { directorPresetForTool, isDirectorScene } from "./director-skills";
import { WorkbenchDirectorSkills } from "./workbench-director-skills";
import "./workbench-overlays.css";
import { expandResourceFileURL, isExpandSubmissionRejected } from "./generation-api";
import type { WorkbenchReference, WorkbenchRestoredMetadata, WorkbenchSurfaceController } from "./workbench-contract";
import {
    clearWorkbenchMaskPendingSubmission,
    readWorkbenchDraft,
    readWorkbenchMaskPendingSubmission,
    writeWorkbenchDraft,
    writeWorkbenchMaskPendingSubmission,
    workbenchSessionEpoch,
    sameWorkbenchComposerDraft,
    type WorkbenchSessionDraft,
} from "./workbench-session";
import { assetReferenceData, safeWorkbenchDownloadURL, taskOutputPreviews, workbenchDeliveryState } from "./workbench-task-output";
import {
    assignWorkbenchReferenceRole,
    historicalImageParameterIssue,
    historicalVideoParameterIssue,
    normalizedWorkbenchVideoParameters,
    serializedWorkbenchImageParameters,
    workbenchCompatibilityParameters,
    workbenchFrameRoleConflict,
    workbenchVideoOperationIssue,
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
    const [mode, setMode] = useState<"compose" | "director">("compose");
    const [directoryOpen, setDirectoryOpen] = useState(false);
    const [composerExpanded, setComposerExpanded] = useState(false);
    const [tasksCollapsed, setTasksCollapsed] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [promptLibraryOpen, setPromptLibraryOpen] = useState(false);
    const [maskOpen, setMaskOpen] = useState(false);
    const [maskSubmitting, setMaskSubmitting] = useState(false);
    const [maskPending, setMaskPending] = useState(() => readWorkbenchMaskPendingSubmission(userId));
    const [historicalParameters, setHistoricalParameters] = useState<Record<string, unknown> | null>(null);
    const [unavailableIdentity, setUnavailableIdentity] = useState<{ model?: string; toolId?: string }>({});
    const [cleanDraft, setCleanDraft] = useState<WorkbenchSessionDraft | null>(null);
    const directorImageInputRef = useRef<HTMLInputElement>(null);
    const directorAudioInputRef = useRef<HTMLInputElement>(null);
    const workbenchRevisionRef = useRef(0);
    const promptSavePending = useRef(false);
    const maskAttemptRef = useRef(false);
    const maskRecoveryRef = useRef(false);
    const mountedRef = useRef(true);
    const skipHydrationWrite = useRef(false);
    const savedPrompt = useRef<{ content: string; id: string } | null>(null);
    const hydratedDraftKey = useRef("");
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
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
        seconds: controller.parameters.seconds || "6",
        userId,
        workbenchRevisionRef,
    });
    const promptTools = useWorkbenchPromptTools({ enabled: controller.kind === "image", prompt: controller.prompt, userId });
    const promptReferences = useMemo(() => workbenchPromptReferences(controller.prompt, controller.references), [controller.prompt, controller.references]);
    const referenceLimit =
        controller.kind === "image"
            ? profile.image?.references.maxImages || 0
            : (profile.video?.references.maxImages || 0) + (profile.video?.references.maxVideos || 0) + (profile.video?.references.maxAudios || 0);
    const promptLimit = controller.kind === "image" ? profile.image?.references.promptMaxChars || 32000 : profile.video?.references.promptMaxChars || 8000;
    const referenceLimits: Record<MediaKind, number> = controller.kind === "image"
        ? { image: profile.image?.references.maxImages || 0, video: 0, audio: 0 }
        : { image: profile.video?.references.maxImages || 0, video: profile.video?.references.maxVideos || 0, audio: profile.video?.references.maxAudios || 0 };
    const pickerMediaKinds = (Object.entries(referenceLimits) as Array<[MediaKind, number]>).filter(([, limit]) => limit > 0).map(([mediaKind]) => mediaKind) as AssetPickerMediaKind[];
    const inputSlots = controller.tool?.inputContract?.slots || [];
    const activeUploadSlot = inputSlots.find((slot) => slot.key === controller.uploadSlotKey);
    const activePickerKinds = activeUploadSlot ? pickerMediaKinds.filter((mediaKind) => activeUploadSlot.mediaTypes.includes(mediaKind as MediaKind)) : pickerMediaKinds;
    const unsupportedReferenceKind = (Object.entries(referenceLimits) as Array<[MediaKind, number]>).find(([mediaKind, limit]) => controller.references.filter((reference) => reference.kind === mediaKind).length > limit)?.[0];
    const missingInput = missingWorkbenchInput(controller.tool, controller.references);
    const historicalParameterIssue = historicalParameters
        ? controller.kind === "image" && profile.image
            ? historicalImageParameterIssue(profile.image, historicalParameters)
            : controller.kind === "video" && profile.video
              ? historicalVideoParameterIssue(profile.video, historicalParameters)
              : undefined
        : undefined;
    const unavailableToolId = unavailableIdentity.toolId || (!controller.directoryLoading && controller.tool && !controller.tools.some((tool) => tool.id === controller.tool?.id) ? controller.tool.id : undefined);
    const restoreIdentityIssue = unavailableIdentity.model
        ? `原模型“${unavailableIdentity.model}”当前不可用，请明确选择可用模型后继续`
        : unavailableToolId
        ? `原工具“${unavailableToolId}”当前不可用，请重新选择工具或新建普通创作后继续`
        : undefined;
    const validationMessage =
        restoreIdentityIssue
            ? restoreIdentityIssue
            : controller.prompt.length > promptLimit
            ? `提示词超过 ${promptLimit} 字，请缩短后提交`
            : controller.preset?.requiredVariables?.length
            ? "该预设需要当前工作台未接入的模板变量，请选择其他预设"
            : promptTools.issue
            ? promptTools.issue
            : requiresMaskRedraw
            ? "该历史任务是局部编辑，请重新涂抹选区后提交"
            : historicalParameterIssue
              ? historicalParameterIssue
            : controller.references.some((reference) => reference.uploading)
            ? "参考素材仍在上传或核验"
            : controller.references.some((reference) => reference.error || !reference.resourceId)
              ? "请移除或重新上传不可用素材"
              : unsupportedReferenceKind
                ? `当前模型不支持这么多${unsupportedReferenceKind === "image" ? "图片" : unsupportedReferenceKind === "video" ? "视频" : "音频"}素材`
              : missingInput
                ? `请补齐“${missingInput.name || "输入素材"}”`
              : workbenchPromptRequired(controller.tool) && !controller.prompt.trim()
                ? "请填写创作提示词"
              : controller.kind === "video"
                ? workbenchFrameRoleConflict(controller.references) || workbenchVideoOperationIssue(profile.video, controller.references)
                : undefined;
    const draft = useMemo<WorkbenchSessionDraft>(() => ({
        prompt: controller.prompt,
        directorContextId: director.contextId,
        directorLanguage: director.language,
        ...(director.selection ? { directorSelection: director.selection } : {}),
        ...(unavailableToolId || controller.tool ? { toolId: unavailableToolId || controller.tool!.id } : {}),
        ...(controller.preset ? { presetId: controller.preset.id } : {}),
        model: unavailableIdentity.model || controller.selectedModel,
        parameters: controller.parameters,
        references: controller.references.flatMap((reference) => reference.resourceId ? [{ resourceId: reference.resourceId, kind: reference.kind, role: reference.role, ...(reference.slotKey ? { slotKey: reference.slotKey } : {}), name: reference.name }] : []),
    }), [controller.parameters, controller.preset, controller.prompt, controller.references, controller.selectedModel, controller.tool, director.contextId, director.language, director.selection, unavailableIdentity.model, unavailableToolId]);
    const composerDirty = cleanDraft
        ? !sameWorkbenchComposerDraft(cleanDraft, draft)
        : Boolean(controller.prompt.trim() || controller.references.length || controller.tool);

    useEffect(() => {
        setCleanDraft(null);
    }, [controller.kind, userId]);

    useEffect(() => {
        if (!controller.draftReady || cleanDraft) return;
        setCleanDraft(structuredClone(draft));
    }, [cleanDraft, controller.draftReady, draft]);

    useEffect(() => {
        const key = `${userId}:${controller.kind}`;
        if (hydratedDraftKey.current === key || !controller.draftReady) return;
        hydratedDraftKey.current = key;
        const saved = readWorkbenchDraft(userId, controller.kind);
        if (!saved) return;
        skipHydrationWrite.current = true;
        // Preserve the empty/configured composer as the comparison baseline before
        // hydrating the unsaved session draft, so a remount cannot make edits clean.
        setCleanDraft(structuredClone(draft));
        if (saved.directorContextId) director.setContextId(saved.directorContextId);
        if (saved.directorLanguage) director.setLanguage(saved.directorLanguage);
        if (saved.directorSelection) director.setSelection(saved.directorSelection);
        const savedTool = saved.toolId ? controller.tools.find((tool) => tool.id === saved.toolId) || null : null;
        const savedModel = saved.model ? controller.models.find((model) => model === saved.model || modelOptionName(model) === saved.model) : undefined;
        setUnavailableIdentity({ ...(!savedModel && saved.model ? { model: saved.model } : {}), ...(!savedTool && saved.toolId ? { toolId: saved.toolId } : {}) });
        controller.chooseTool(savedTool);
        const savedPreset = savedTool?.presets.find((preset) => preset.id === saved.presetId) || null;
        controller.restorePreset(savedPreset);
        if (saved.presetId && !savedPreset) message.warning("原模板已不可用，已保留提示词正文，请按需重新选择模板");
        controller.setPrompt(saved.prompt);
        if (savedModel) controller.selectModel(savedModel);
        controller.applyParameters(saved.parameters);
        setHistoricalParameters(workbenchCompatibilityParameters(controller.kind, saved.parameters));
        const restoredReferences = saved.references.map((reference): WorkbenchReference => ({
            id: crypto.randomUUID(),
            name: reference.name || "参考素材",
            kind: reference.kind,
            resourceId: reference.resourceId,
            previewUrl: "",
            progress: 0,
            uploading: true,
            role: reference.role || "reference",
            ...(reference.slotKey ? { slotKey: reference.slotKey } : {}),
        }));
        controller.setReferences(restoredReferences);
        const epoch = workbenchSessionEpoch(userId);
        void Promise.all(restoredReferences.map(async (reference) => {
            let previewUrl = "";
            let error: string | undefined;
            try {
                previewUrl = await controller.resolveResourceURL(reference.resourceId!) || "";
                if (!previewUrl) error = "原素材不可用，请移除后重新选择";
            } catch (failure) {
                error = failure instanceof Error ? failure.message : "原素材不可用，请移除后重新选择";
            }
            if (!mountedRef.current || workbenchSessionEpoch(userId) !== epoch || useUserStore.getState().user?.id !== userId) return;
            // Availability acknowledgement is background state, not a new draft edit.
            controller.setReferences((current) => current.map((item) => item.id === reference.id ? { ...item, previewUrl, error, progress: 100, uploading: false } : item), false);
        }));
    }, [controller, director, draft, userId]);

    useEffect(() => {
        if (hydratedDraftKey.current !== `${userId}:${controller.kind}`) return;
        if (skipHydrationWrite.current) {
            skipHydrationWrite.current = false;
            return;
        }
        writeWorkbenchDraft(userId, controller.kind, draft);
    }, [controller.kind, draft, userId]);

    useEffect(() => {
        setMaskPending(readWorkbenchMaskPendingSubmission(userId));
        setMaskOpen(false);
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
            controller.applyParameters(normalizedWorkbenchVideoParameters(profile.video, historicalParameters));
        }
        setHistoricalParameters(null);
    };

    const settingsPanel = controller.kind === "image" ? (
        <div className="oacx-workbench-settings-content space-y-3">
            {historicalParameterIssue ? (
                <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100" role="alert">
                    <p className="m-0">{historicalParameterIssue}</p>
                    <Button size="small" onClick={repairHistoricalParameters}>使用当前模型兼容参数</Button>
                </div>
            ) : null}
            <ImageSettingsPanel
                config={controller.composerConfig}
                className="w-full min-w-0 space-y-3 rounded-2xl px-1 py-0.5"
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

    const addComposerFiles = async (files: FileList | File[], requestedSlotKey?: string) => {
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
            const slot = slots.length ? slots.find((item) => (!requestedSlotKey || item.key === requestedSlotKey) && item.mediaTypes.includes(mediaKind) && (slotCounts.get(item.key) || 0) < item.maxCount) : undefined;
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
        if (maskRecoveryRef.current) return;
        maskRecoveryRef.current = true;
        const epoch = workbenchSessionEpoch(userId);
        const isCurrent = () => mountedRef.current && useUserStore.getState().user?.id === userId && workbenchSessionEpoch(userId) === epoch;
        setMaskSubmitting(true);
        try {
            await controller.submitDirectTask(pending.input);
            if (workbenchSessionEpoch(userId) !== epoch) return;
            clearWorkbenchMaskPendingSubmission(userId, pending.clientOperationId);
            if (isCurrent()) {
                setMaskPending(readWorkbenchMaskPendingSubmission(userId));
                setMaskOpen(false);
                message.success("局部编辑任务已提交");
            }
        } catch (error) {
            if (workbenchSessionEpoch(userId) !== epoch) return;
            if (isExpandSubmissionRejected(error)) {
                clearWorkbenchMaskPendingSubmission(userId, pending.clientOperationId);
                if (isCurrent()) {
                    setMaskPending(readWorkbenchMaskPendingSubmission(userId));
                    message.error(error instanceof Error ? error.message : "局部编辑提交失败");
                }
            } else if (isCurrent()) {
                message.error(error instanceof Error ? `局部编辑提交状态待确认：${error.message}` : "局部编辑提交状态待确认");
            }
        } finally {
            maskRecoveryRef.current = false;
            if (isCurrent()) setMaskSubmitting(false);
        }
    };

    const submitMaskEdit = async (payload: CanvasImageMaskEditPayload) => {
        if (!outputTask || !maskSourceResourceId || maskSubmitting || maskPending || maskAttemptRef.current) return;
        const finalConfig = { ...controller.composerConfig, ...payload.generationConfig };
        const finalModel = finalConfig.imageModel || finalConfig.model;
        if (!modelCapabilityConfigFor(finalConfig, finalModel).image?.references.maskSupported) {
            message.warning("所选模型不支持局部编辑，请选择支持蒙版的图片模型");
            return;
        }
        maskAttemptRef.current = true;
        const clientOperationId = crypto.randomUUID();
        const epoch = workbenchSessionEpoch(userId);
        const assertSession = () => {
            if (!mountedRef.current) throw new DOMException("页面已离开", "AbortError");
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
                config: finalConfig,
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
            if (mountedRef.current && useUserStore.getState().user?.id === userId && workbenchSessionEpoch(userId) === epoch) {
                message.error(error instanceof Error ? error.message : "局部编辑提交失败");
                setMaskSubmitting(false);
            }
        } finally {
            maskAttemptRef.current = false;
        }
    };

    const replaceDraft = (action: () => void, content: string) => {
        const apply = () => {
            workbenchRevisionRef.current += 1;
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

    const changePrompt = (value: string) => {
        workbenchRevisionRef.current += 1;
        controller.setPrompt(value);
    };
    const applyRestoredMetadata = (restored: WorkbenchRestoredMetadata) => {
        setHistoricalParameters(restored.parameters);
        const restoredTool = controller.tools.find((tool) => tool.id === restored.toolId);
        setUnavailableIdentity({
            ...(restored.model && !controller.models.some((model) => model === restored.model || modelOptionName(model) === restored.model) ? { model: restored.model } : {}),
            ...(restored.toolId && !restoredTool ? { toolId: restored.toolId } : {}),
        });
        if (restoredTool && restored.presetId && !restoredTool.presets.some((preset) => preset.id === restored.presetId)) {
            message.warning("原模板已不可用，已保留提示词正文，请按需重新选择模板");
        }
        setCleanDraft(null);
    };
    const submitComposer = () => {
        if (controller.busy || validationMessage || !controller.selectedModel) return;
        const submittedDraft = structuredClone(draft);
        const revision = workbenchRevisionRef.current;
        const epoch = workbenchSessionEpoch(userId);
        void controller.submit().then((task) => {
            if (task && revision === workbenchRevisionRef.current && epoch === workbenchSessionEpoch(userId)) setCleanDraft(submittedDraft);
        });
    };
    const example = controller.tool?.resultExample;
    const exampleImage = example?.imageResourceIds?.[0] ? expandResourceFileURL(example.imageResourceIds[0]) : example?.imageUrls?.[0];
    const exampleVideo = example?.videoResourceId ? expandResourceFileURL(example.videoResourceId) : example?.videoUrl;
    const exampleURL = exampleVideo || exampleImage;
    const directorVideoReferences = controller.references.filter((reference) => reference.kind === "video").map((reference) => <div key={reference.id} className="text-xs"><span>视频素材 · {reference.uploading ? "上传中" : reference.error || reference.name}</span><Button size="small" onClick={() => controller.removeReference(reference)} aria-label={`移除编导视频 ${reference.name}`}>移除</Button></div>);

    const surface = (
        <GenerationWorkbench
            kind={controller.kind}
            mode={mode}
            directoryOpen={directoryOpen}
            onDirectoryOpenChange={setDirectoryOpen}
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
                expanded: composerExpanded,
                onExpandedChange: setComposerExpanded,
                canSavePrompt: Boolean(controller.prompt.trim()),
                canOpenPromptLibrary: true,
                canOpenDirector: controller.kind === "video",
                onPromptChange: changePrompt,
                onNew: () => replaceDraft(() => {
                    setUnavailableIdentity({});
                    director.setContextId(crypto.randomUUID());
                    director.setSelection(null);
                    controller.resetWorkbench();
                    setMode("compose");
                    setCleanDraft(null);
                }, "新建会清空当前提示词和参考素材，历史任务与素材会保留。"),
                onAddReference: () => { controller.setUploadSlotKey(undefined); setAssetPickerOpen(true); },
                onSavePrompt: () => void savePrompt(),
                onOpenPromptLibrary: () => setPromptLibraryOpen(true),
                onOpenDirector: () => setMode("director"),
            }}
            directory={{
                activeItemId: controller.tool?.id,
                categories: [{ id: "all", label: "全部" }, ...workbenchCategories.map((category) => ({ id: category.value, label: category.label }))],
                activeCategoryId: controller.toolCategory,
                searchQuery: controller.toolSearch,
                items: controller.filteredTools.map((tool) => ({ id: tool.id, title: tool.name, description: tool.subtitle || tool.description, categoryId: tool.categoryId, disabled: Boolean(tool.presets[0]?.requiredVariables?.length), disabledReason: tool.presets[0]?.requiredVariables?.length ? "该工具需要尚未接入的模板变量" : undefined, thumbnail: tool.iconUrl ? <img src={tool.iconUrl} alt="" /> : controller.kind === "image" ? <Images /> : <Video /> })),
                loading: controller.directoryLoading,
                error: controller.directoryError,
                onCategoryChange: controller.setToolCategory,
                onSearchQueryChange: controller.setToolSearch,
                onSelectItem: (id) => {
                    if (id === controller.tool?.id) {
                        setDirectoryOpen(false);
                        if (controller.kind === "video" && isDirectorScene(id)) {
                            const sameScene = director.selection?.mode === "scene" && director.selection.sceneToolId === id && director.selection.presetId === directorPresetForTool(id);
                            if (director.hasHandoff || sameScene) setMode("director");
                            else replaceDraft(() => { director.chooseScene(id); setMode("director"); }, "重新选择场景会替换当前编导技能，创作文字与素材会保留。");
                        }
                        return;
                    }
                    replaceDraft(() => {
                    setUnavailableIdentity((current) => ({ ...current, toolId: undefined }));
                    if (director.hasHandoff) director.setContextId(crypto.randomUUID());
                    controller.chooseTool(controller.tools.find((tool) => tool.id === id) || null);
                    setDirectoryOpen(false);
                    setMode(controller.kind === "video" && director.chooseScene(id) ? "director" : "compose");
                    }, "切换工具会替换当前创作设置。");
                },
                onRetry: () => void controller.reloadTools(),
            }}
            preview={{
                status: outputTask ? workbenchDeliveryState(outputTask, outputs).status : "empty",
                heading: outputTask ? workbenchDeliveryState(outputTask, outputs).label : exampleURL ? example?.title || "参考示例" : controller.kind === "image" ? "从左侧开始创作图片" : "从左侧开始创作视频",
                description: outputTask ? outputTask.error || (outputTask.materializationErrorCode ? "作品保存未完成，请查看产物状态；不要重复生成。" : outputTask.stage) : exampleURL ? `参考示例 · ${example?.description || "仅供创作参考，实际效果由模型与素材决定"}` : "生成结果会在这里显示",
                media: activeOutput?.url && activeOutput.status === "ready" ? <MediaPreview key={activeOutput.id} src={activeOutput.url} kind={activeOutput.kind} alt={`生成产物 ${activeOutput.outputIndex + 1}`} controls={activeOutput.kind === "video"} /> : !outputTask && exampleURL ? <MediaPreview src={exampleURL} kind={exampleVideo ? "video" : "image"} alt="工具参考示例" controls={Boolean(exampleVideo)} /> : undefined,
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
                    ...(outputTask && !outputTask.canRecoverMedia && (outputTask.status === "failed" || outputTask.status === "cancelled") ? [{ id: "retry", label: "重新生成", icon: <RefreshCw className="size-4" />, disabled: controller.taskBusyId === outputTask.id, onSelect: () => replaceDraft(() => { void controller.retryTask(outputTask, applyRestoredMetadata); }, "重试任务会恢复原任务配置并覆盖当前修改。") }] : []),
                ],
                onSelectOutput: (id) => setActiveOutputIndex(Math.max(0, outputs.findIndex((output) => output.id === id))),
            }}
            tasks={{
                title: "最近任务",
                currentDraft: composerDirty && !(mode === "director" && director.hasHandoff && !director.handoffNeedsConfirmation) ? { title: "当前草稿 · 未提交", secondaryLabel: controller.prompt || controller.tool?.name || "尚未提交的创作输入", onSelect: () => controller.setMobileTab("generate") } : undefined,
                scopeLabel: `最近 ${Math.min(100, controller.tasks.length)} 项`,
                items: controller.tasks.map((task) => {
                    const taskOutputs = taskOutputPreviews(task);
                    const preview = taskOutputs.find((output) => output.status === "ready");
                    const delivery = workbenchDeliveryState(task, taskOutputs);
                    return { id: task.id, title: controller.taskModelLabel(task), createdAtLabel: new Date(task.createdAt).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false }), status: delivery.status, statusLabel: delivery.label, secondaryLabel: task.prompt, thumbnail: preview?.kind === "image" && preview.url ? <img src={preview.url} alt="" /> : controller.kind === "video" ? <Video /> : <FileImage /> };
                }),
                selectedTaskId: outputTask?.id,
                loading: controller.tasksLoading,
                error: controller.tasksError,
                onRetry: () => void controller.reloadTasks(),
                collapsed: tasksCollapsed,
                onCollapsedChange: setTasksCollapsed,
                onSelectTask: (id) => {
                    const task = controller.tasks.find((item) => item.id === id);
                    if (!task) return;
                    const openTask = () => {
                        workbenchRevisionRef.current += 1;
                        setMode("compose");
                        director.setContextId(crypto.randomUUID());
                        director.setSelection(null);
                        void controller.openTask(task)
                            .then((restored) => {
                                if (!restored) return;
                                applyRestoredMetadata(restored);
                            })
                            .catch((error) => message.error(error instanceof Error ? error.message : "历史任务加载失败"));
                    };
                    if (!composerDirty) {
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
            submit={{ label: controller.kind === "image" ? "立即生成图片" : "立即生成视频", disabled: controller.busy || Boolean(validationMessage) || !controller.selectedModel, pending: controller.busy, disabledReason: validationMessage, onSubmit: submitComposer }}
            director={controller.kind === "video" ? {
                prompt: controller.prompt,
                suggestions: ["口播带货", "品牌广告", "剧情短片"],
                skillInput: <div className="space-y-2"><WorkbenchDirectorSkills director={director} theme={canvasTheme} userId={userId} />{director.handoffNeedsConfirmation ? <p className="text-xs text-muted-foreground">旧交接尚未确认技能，请重新选择场景或主动使用通用编导后继续。</p> : null}{director.handoffError ? <Button size="small" onClick={director.retryHandoff}>重新读取交接状态</Button> : null}</div>,
                validationMessage: director.handoffError || director.skillsError || (!controller.references.some((reference) => reference.kind === "image" && reference.resourceId) ? "至少添加一张图片素材" : controller.references.length > 8 ? "编导最多使用 8 个焦点素材" : undefined),
                submitLabel: director.busy ? "正在进入 Agent…" : "进入 Agent，分析素材与脚本",
                submitDisabled: director.busy || director.handoffLoading || Boolean(director.handoffError) || director.skillsLoading || Boolean(director.skillsError) || !director.selection || !controller.prompt.trim() || !controller.references.some((reference) => reference.kind === "image" && reference.resourceId) || controller.references.length > 8 || controller.references.some((reference) => reference.uploading || reference.error || !reference.resourceId),
                languageInput: <Select aria-label="编导语言" value={director.language} onChange={(language) => { workbenchRevisionRef.current += 1; director.setLanguage(language); }} options={[{ value: "zh-CN", label: "中文" }, { value: "en-US", label: "English" }]} />,
                imageInput: <div className="space-y-2"><div className="flex flex-wrap gap-2">{controller.references.filter((reference) => reference.kind === "image").map((reference) => <div key={reference.id} className="max-w-24 text-xs"><img src={reference.previewUrl} alt={reference.name} className="h-16 w-20 rounded object-cover" /><span>{reference.uploading ? "上传中" : reference.error || reference.name}</span><Button size="small" onClick={() => controller.removeReference(reference)} aria-label={`移除编导图片 ${reference.name}`}>移除</Button></div>)}</div><Button icon={<Upload className="size-4" />} onClick={() => directorImageInputRef.current?.click()}>上传图片</Button><input ref={directorImageInputRef} className="hidden" type="file" accept="image/*" onChange={(event) => { if (event.target.files) void addDirectorFiles(event.target.files, "image"); event.target.value = ""; }} /></div>,
                audioInput: <div className="space-y-2">{directorVideoReferences}{controller.references.filter((reference) => reference.kind === "audio").map((reference) => <div key={reference.id} className="text-xs"><span>{reference.uploading ? "上传中" : reference.error || reference.name}</span><Button size="small" onClick={() => controller.removeReference(reference)} aria-label={`移除编导音频 ${reference.name}`}>移除</Button></div>)}<Button icon={<Upload className="size-4" />} onClick={() => directorAudioInputRef.current?.click()}>上传音频</Button><input ref={directorAudioInputRef} className="hidden" type="file" accept="audio/*" onChange={(event) => { if (event.target.files) void addDirectorFiles(event.target.files, "audio"); event.target.value = ""; }} /></div>,
                durationInput: <Select aria-label="编导目标时长" value={controller.parameters.seconds || "6"} onChange={(seconds) => { workbenchRevisionRef.current += 1; controller.applyParameters({ seconds }); }} options={(profile.video?.duration.values || [6]).map((value) => ({ value: String(value), label: `${value} 秒` }))} />,
                onPromptChange: changePrompt,
                onSuggestionSelect: (suggestion) => replaceDraft(() => changePrompt(suggestion), "应用创作建议会替换当前需求，素材与设置会保留。"),
                onSubmit: () => void director.submit(),
                onExit: () => setMode("compose"),
            } : undefined}
            slots={{
                director: controller.kind === "video" && director.hasHandoff && !director.handoffNeedsConfirmation ? <div className="space-y-4 p-4" aria-label="编导会话恢复" role="status"><h2 className="text-lg font-semibold">{director.handedOff ? "已交接至 Agent" : "编导交接待完成"}</h2><p className="text-sm text-muted-foreground">{director.handedOff ? "创作需求已进入原画布会话。继续会回到同一画布，不会再次发送首轮请求。" : "已有画布交接记录。继续会恢复原交接和已冻结的需求，请在原会话中完成技能确认。"}</p><div className="flex flex-wrap gap-2"><Button type="primary" onClick={director.continueHandoff}>继续原 Agent 会话</Button><Button onClick={() => setMode("compose")}>退出编导</Button></div></div> : undefined,
                promptEditor: <CanvasResourceMentionTextarea value={controller.prompt} references={promptReferences} onChange={changePrompt} onSubmit={submitComposer} sendOnEnter={false} aria-label="生成提示词" placeholder={controller.tool?.inputHint || "描述你想生成的画面、镜头与细节"} maxLength={promptLimit} style={{ color: "var(--oacx-text)" }} className="min-h-40 w-full resize-none bg-transparent" containerClassName="min-w-0 flex-1" />,
                promptTools: <div className="space-y-2">
                    {controller.kind === "image" ? <WorkbenchImagePromptTools prompt={controller.prompt} userId={userId} onChange={changePrompt} /> : null}
                    {promptTools.issue ? <Button size="small" onClick={() => void promptTools.retry()}>重新校验工具</Button> : null}
                    {controller.tool?.presets.length ? <div className="flex flex-wrap gap-2" aria-label="工作台提示词模板">{controller.tool.presets.map((preset) => <Button key={preset.id} size="small" disabled={Boolean(preset.requiredVariables?.length)} title={preset.requiredVariables?.length ? "该模板需要尚未接入的变量" : preset.summary} aria-pressed={controller.preset?.id === preset.id} onClick={() => { if (!controller.prompt.trim()) workbenchRevisionRef.current += 1; controller.choosePreset(preset); }}>{preset.name}</Button>)}</div> : null}
                </div>,
                pendingSubmission: maskPending || controller.hasPendingSubmission ? <div className="flex flex-wrap items-center gap-2" role="status">{controller.hasPendingSubmission ? <Button size="small" onClick={() => void controller.recoverPendingSubmission().catch((error) => message.error(error instanceof Error ? `任务详情仍不可用：${error.message}` : "任务详情仍不可用"))}>恢复待确认生成</Button> : null}{maskPending ? <Button size="small" loading={maskSubmitting} onClick={() => void executeMaskTask(maskPending)}>恢复待确认局部编辑</Button> : null}<span className="text-xs text-muted-foreground">恢复已冻结的原请求，不会创建新的提交。</span></div> : undefined,
                modelPicker: <ModelPicker config={controller.composerConfig} value={unavailableIdentity.model || controller.selectedModel} onChange={(model) => {
                    setUnavailableIdentity((current) => ({ ...current, model: undefined }));
                    setHistoricalParameters(workbenchCompatibilityParameters(controller.kind, controller.parameters));
                    controller.selectModel(model);
                }} capability={controller.kind} showSelectedPrice={false} />,
                settingsPanel: <Popover trigger="click" placement="topLeft" align={{ offset: [0, 0], overflow: { adjustX: true, adjustY: true, shiftX: true, shiftY: true } }} classNames={{ root: "oacx-workbench-popup oacx-workbench-settings-popup" }} content={settingsPanel} arrow={false}><Button>{controller.kind === "image" ? "图片设置" : "视频设置"}</Button></Popover>,
                referenceInput: <div className="space-y-2">
                    {inputSlots.length ? inputSlots.map((slot) => <div key={slot.key} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2" aria-label={`素材槽 ${slot.name}`}><span className="text-xs">{slot.name}{slot.required ? " *" : ""} · {controller.references.filter((reference) => reference.slotKey === slot.key).length}/{slot.maxCount}</span><Button size="small" onClick={() => { controller.setUploadSlotKey(slot.key); setAssetPickerOpen(true); }}>素材库</Button><Button size="small" onClick={() => { controller.setUploadSlotKey(slot.key); controller.fileRef.current?.click(); }}>上传</Button></div>) : <div className="flex gap-2"><Button icon={<Images className="size-4" />} onClick={() => { controller.setUploadSlotKey(undefined); setAssetPickerOpen(true); }}>素材库</Button><Button icon={<Upload className="size-4" />} onClick={() => { controller.setUploadSlotKey(undefined); controller.fileRef.current?.click(); }}>上传</Button></div>}
                    <input ref={controller.fileRef} className="hidden" type="file" multiple accept={activePickerKinds.map((mediaKind) => `${mediaKind}/*`).join(",")} onChange={(event) => { if (event.target.files) void addComposerFiles(event.target.files, controller.uploadSlotKey); event.target.value = ""; }} />
                </div>,
                maskEditor: controller.kind === "image" && maskSourceURL ? <CanvasNodeMaskEditDialog dataUrl={maskSourceURL} config={controller.composerConfig} open={maskOpen} busy={maskSubmitting} confirmDiscard submissionRecovery={maskPending && !maskSubmitting ? <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-sm"><span>局部编辑提交状态待确认，请恢复原操作后继续。</span><Button onClick={() => void executeMaskTask(maskPending)}>恢复待确认局部编辑</Button></div> : undefined} onClose={() => setMaskOpen(false)} onConfirm={(payload) => void submitMaskEdit(payload)} /> : undefined,
            }}
        />
    );

    return (
        <ConfigProvider popover={{ classNames: { root: "oacx-workbench-popup" } }} select={{ classNames: { popup: { root: "oacx-workbench-popup" } } }} tooltip={{ classNames: { root: "oacx-workbench-popup" } }}>
        <WorkspacePage fluid scroll={false}>
            {surface}
            <Modal open={Boolean(controller.presetPending)} title="应用提示词模板" onCancel={controller.cancelPreset} footer={<><Button onClick={controller.cancelPreset}>取消</Button><Button onClick={() => { workbenchRevisionRef.current += 1; controller.applyPreset("append"); }}>追加</Button><Button type="primary" onClick={() => { workbenchRevisionRef.current += 1; controller.applyPreset("replace"); }}>替换</Button></>}>
                <p>将应用“{controller.presetPending?.name}”。选择替换当前文字或追加到末尾，取消会保留原内容。</p>
            </Modal>
            <AssetLibraryPickerModal open={assetPickerOpen} title={activeUploadSlot ? `选择${activeUploadSlot.name}` : "选择参考素材"} items={pickerItems} mediaKinds={activePickerKinds} categoryLabels={{ all: "全部", other: "其他", character: "角色", scene: "场景", prop: "道具", reference: "参考", output: "产物" }} multiple initialSelectedIds={[]} onClose={() => setAssetPickerOpen(false)} onConfirm={(_, selected) => {
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
                        const slot = slots.length ? slots.find((item) => (!controller.uploadSlotKey || item.key === controller.uploadSlotKey) && item.mediaTypes.includes(candidate.kind) && next.filter((reference) => reference.slotKey === item.key).length < item.maxCount) : undefined;
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
        </ConfigProvider>
    );
}
