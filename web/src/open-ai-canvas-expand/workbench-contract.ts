import type { ReactNode, RefObject } from "react";

import type { CreateTaskInput } from "@/services/api/task-center";
import type { RemoteResource, ResourceUploadMeta } from "@/services/api/resources";
import type { CreateWorkbenchTaskInput, WorkbenchKind, WorkbenchPromptPreset, WorkbenchTool, WorkbenchToolDirectory } from "@/services/api/workbench";
import type { AiConfig } from "@/stores/use-config-store";

import type { ExpandGenerationTask } from "./workbench-task-output";

export type WorkbenchReference = {
    id: string;
    name: string;
    kind: "image" | "video" | "audio";
    resourceId?: string;
    previewUrl: string;
    progress: number;
    uploading: boolean;
    error?: string;
    role: "reference" | "first_frame" | "last_frame";
    slotKey?: string;
};

export type WorkbenchRuntime = {
    listTools(kind: WorkbenchKind, signal?: AbortSignal): Promise<WorkbenchToolDirectory>;
    listTasks(kind: WorkbenchKind, limit?: number, activeOnly?: boolean, signal?: AbortSignal): Promise<ExpandGenerationTask[]>;
    createWorkbenchTask(input: CreateWorkbenchTaskInput): Promise<{ id: string }>;
    createGenerationTask(input: CreateTaskInput): Promise<{ id: string }>;
    getTask(id: string, signal?: AbortSignal): Promise<ExpandGenerationTask>;
    cancelTask(id: string): Promise<ExpandGenerationTask>;
    retryTask(id: string): Promise<ExpandGenerationTask>;
    recoverTaskMedia(id: string): Promise<ExpandGenerationTask>;
    hasPendingSubmission(): boolean;
    recoverPendingSubmission(): Promise<{ id: string }>;
    uploadResource(file: Blob, kind: "image" | "video" | "audio" | "file", meta?: ResourceUploadMeta, onProgress?: (uploaded: number, total: number) => void): Promise<RemoteResource>;
    resolveResourceURL(resourceId: string): Promise<string | undefined>;
};

export type WorkbenchRestoredMetadata = {
    parameters: Record<string, unknown>;
    model?: string;
    toolId?: string;
    presetId?: string;
};

export type WorkbenchSurfaceController = {
    kind: WorkbenchKind;
    config: AiConfig;
    composerConfig: AiConfig;
    tool: WorkbenchTool | null;
    preset: WorkbenchPromptPreset | null;
    presetPending: WorkbenchPromptPreset | null;
    tools: WorkbenchTool[];
    filteredTools: WorkbenchTool[];
    directoryLoading: boolean;
    directoryError: string;
    toolCategory: string;
    toolSearch: string;
    prompt: string;
    references: WorkbenchReference[];
    selectedModel: string;
    models: string[];
    settingsPanel: ReactNode;
    fileRef: RefObject<HTMLInputElement | null>;
    uploadSlotKey?: string;
    busy: boolean;
    taskBusyId: string;
    tasks: ExpandGenerationTask[];
    tasksLoading: boolean;
    tasksError: string;
    activeTask: ExpandGenerationTask | null;
    resultTask: ExpandGenerationTask | null;
    resultUrl: string;
    estimateLabel: string;
    parameters: Record<string, string>;
    draftReady: boolean;
    mobileTab: string;
    setMobileTab(value: string): void;
    setPrompt(value: string | ((current: string) => string)): void;
    setReferences(value: WorkbenchReference[] | ((current: WorkbenchReference[]) => WorkbenchReference[]), markEdited?: boolean): void;
    setToolCategory(value: string): void;
    setToolSearch(value: string): void;
    setUploadSlotKey(value: string | undefined): void;
    selectModel(model: string): void;
    applyParameters(parameters: Record<string, string>): void;
    reloadTools(): Promise<void>;
    reloadTasks(): Promise<void>;
    resetWorkbench(): void;
    chooseTool(tool: WorkbenchTool | null): void;
    choosePreset(preset: WorkbenchPromptPreset): void;
    restorePreset(preset: WorkbenchPromptPreset | null): void;
    applyPreset(mode: "replace" | "append"): void;
    cancelPreset(): void;
    addFiles(files: FileList | File[], slotKey?: string): Promise<void>;
    removeReference(reference: WorkbenchReference): void;
    submit(): Promise<ExpandGenerationTask | void>;
    submitDirectTask(input: CreateTaskInput): Promise<void>;
    recoverPendingSubmission(): Promise<void>;
    hasPendingSubmission: boolean;
    uploadResource(file: Blob, kind: "image" | "video" | "audio" | "file", meta?: ResourceUploadMeta): Promise<RemoteResource>;
    resolveResourceURL(resourceId: string): Promise<string | undefined>;
    cancelTask(task: ExpandGenerationTask): Promise<void>;
    retryTask(task: ExpandGenerationTask, onRestored?: (metadata: WorkbenchRestoredMetadata) => void): Promise<void>;
    recoverTaskMedia(task: ExpandGenerationTask): Promise<void>;
    openTask(task: ExpandGenerationTask): Promise<WorkbenchRestoredMetadata | null>;
    taskModelLabel(task: ExpandGenerationTask): string;
};

export type WorkbenchSurfaceRenderer = (controller: WorkbenchSurfaceController) => ReactNode;
