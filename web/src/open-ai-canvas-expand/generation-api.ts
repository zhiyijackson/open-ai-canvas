import {
    createExpandOpenApi,
    EXPAND_OPENAPI_PREFIX,
    type ExpandDirectGenerationInput,
    type ExpandGenerationInput,
    type ExpandOpenApiOptions,
} from "@open-ai-canvas/expand";

import { apiBaseURL, http } from "@/services/api/request";
import { getActiveUserScope } from "@/lib/user-scope";
import type { RemoteResource, ResourceUploadMeta } from "@/services/api/resources";
import type { WorkbenchKind, WorkbenchToolDirectory } from "@/services/api/workbench";
import type { WorkbenchRuntime } from "./workbench-contract";
import {
    clearWorkbenchPendingSubmission,
    readWorkbenchPendingSubmission,
    registerWorkbenchSessionAbort,
    workbenchSessionEpoch,
    writeWorkbenchPendingSubmission,
    type WorkbenchPendingSubmission,
} from "./workbench-session";

import type { ExpandGenerationTask } from "./workbench-task-output";

const transport = {
    get: <T,>(path: string, options?: ExpandOpenApiOptions) => http.get<T>(path, options),
    post: <T,>(path: string, data?: unknown, options?: ExpandOpenApiOptions) => http.post<T>(path, data, options),
    put: <T,>(path: string, data?: unknown, options?: ExpandOpenApiOptions) => http.put<T>(path, data, options),
    delete: <T,>(path: string, options?: ExpandOpenApiOptions) => http.delete<T>(path, options),
};

const client = createExpandOpenApi(transport);

function task(record: Record<string, unknown>) {
    return record as ExpandGenerationTask;
}

export async function listExpandWorkbenchTools(kind: WorkbenchKind, signal?: AbortSignal) {
    const response = await client.listTools(kind, { signal });
    const directory = response as WorkbenchToolDirectory;
    return {
        tools: directory.tools.map((tool) => ({
            ...tool,
            iconUrl: tool.iconUrl || (tool.iconResourceId ? expandResourceFileURL(tool.iconResourceId) : undefined),
            coverUrl: tool.coverUrl || (tool.coverResourceId ? expandResourceFileURL(tool.coverResourceId) : undefined),
            presets: Array.isArray(tool.presets) ? tool.presets.filter((preset) => preset.enabled !== false) : [],
        })),
    };
}

export async function listExpandTasks(kind: WorkbenchKind, limit = 100, activeOnly = false, signal?: AbortSignal, clientOperationId?: string) {
    const records = await client.listTasks({ kind, pageSize: Math.max(1, Math.min(100, Math.trunc(limit))), activeOnly, clientOperationId }, { signal });
    return records.map(task);
}

export async function createExpandWorkbenchTask(input: ExpandGenerationInput) {
    return task(await client.createTask(input));
}

export async function createExpandGenerationTask(input: ExpandDirectGenerationInput) {
    return task(await client.createGenerationTask(input));
}

export async function getExpandTask(id: string, signal?: AbortSignal) {
    return task(await client.getTask(id, { signal }));
}

export async function cancelExpandTask(id: string) {
    return task(await client.cancelTask(id));
}

export async function retryExpandTask(id: string) {
    return task(await client.retryTask(id));
}

export async function recoverExpandTaskMedia(id: string) {
    return task(await client.recoverTaskMedia(id));
}

export async function uploadExpandResource(file: Blob, kind: "image" | "video" | "audio" | "file", meta?: ResourceUploadMeta, signal?: AbortSignal) {
    const fileName = meta?.fileName || (file instanceof File ? file.name : `${kind}.bin`);
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", file, fileName);
    if (meta?.width) form.append("width", String(Math.round(meta.width)));
    if (meta?.height) form.append("height", String(Math.round(meta.height)));
    if (meta?.durationMs) form.append("durationMs", String(Math.round(meta.durationMs)));
    const response = await client.uploadResource(form, { signal, idempotencyKey: meta?.idempotencyKey });
    return response.resource as RemoteResource;
}

export async function getExpandResource(resourceId: string, signal?: AbortSignal) {
    const id = encodeURIComponent(resourceId);
    const response = await http.get<{ resource: RemoteResource }>(`${EXPAND_OPENAPI_PREFIX}/resources/${id}`, { signal });
    return response.resource;
}

export function expandResourceFileURL(resourceId: string) {
    const base = String(apiBaseURL).replace(/\/+$/, "");
    return `${base}${EXPAND_OPENAPI_PREFIX}/resources/${encodeURIComponent(resourceId)}/file`;
}

function submissionPayload(input: object) {
    const { clientOperationId: _clientOperationId, ...payload } = input as Record<string, unknown>;
    return payload;
}

function fingerprint(input: object) {
    return JSON.stringify(submissionPayload(input));
}

export function createExpandWorkbenchRuntime(kind: WorkbenchKind, scope: string): WorkbenchRuntime {
    const epoch = workbenchSessionEpoch(scope);
    const assertScope = () => {
        const current = getActiveUserScope();
        if (current !== scope || workbenchSessionEpoch(scope) !== epoch) throw new DOMException("账号已切换", "AbortError");
    };
    const inSession = async <T,>(operation: (signal: AbortSignal) => Promise<T>) => {
        assertScope();
        const controller = new AbortController();
        const unregister = registerWorkbenchSessionAbort(scope, controller);
        try {
            const result = await operation(controller.signal);
            assertScope();
            return result;
        } finally {
            unregister();
        }
    };
    const submit = async (transportKind: WorkbenchPendingSubmission["transport"], input: object) => {
        assertScope();
        const inputFingerprint = fingerprint(input);
        const existing = readWorkbenchPendingSubmission(scope, kind);
        if (existing && (existing.transport !== transportKind || existing.fingerprint !== inputFingerprint)) {
            throw new Error("已有生成提交状态待确认，请先使用原参数再次提交以恢复该任务");
        }
        if (existing?.acceptedTaskId) return { id: existing.acceptedTaskId };
        const requestedOperationId = "clientOperationId" in input && typeof input.clientOperationId === "string" ? input.clientOperationId : "";
        const clientOperationId = existing?.clientOperationId || requestedOperationId || crypto.randomUUID();
        const pending = (existing || { transport: transportKind, fingerprint: inputFingerprint, clientOperationId, input: { ...input, clientOperationId } }) as WorkbenchPendingSubmission;
        writeWorkbenchPendingSubmission(scope, kind, pending);
        try {
            const created = await inSession((signal) =>
                transportKind === "workbench"
                    ? client.createTask({ ...input, clientOperationId } as ExpandGenerationInput, { signal }).then(task)
                    : client.createGenerationTask({ ...input, clientOperationId } as ExpandDirectGenerationInput, { signal }).then(task),
            );
            writeWorkbenchPendingSubmission(scope, kind, { ...pending, acceptedTaskId: created.id });
            return { id: created.id };
        } catch (error) {
            assertScope();
            const [accepted] = await inSession((signal) => listExpandTasks(kind, 1, false, signal, clientOperationId)).catch(() => []);
            if (accepted) {
                writeWorkbenchPendingSubmission(scope, kind, { ...pending, acceptedTaskId: accepted.id });
                return { id: accepted.id };
            }
            throw error;
        }
    };

    return {
        listTools: listExpandWorkbenchTools,
        listTasks: (taskKind, limit, activeOnly, signal) => listExpandTasks(taskKind, limit, activeOnly, signal),
        createWorkbenchTask: (input) => submit("workbench", input),
        createGenerationTask: (input) => submit("generation", input),
        getTask: async (id, signal) => {
            const result = await inSession((sessionSignal) => getExpandTask(id, signal ? AbortSignal.any([signal, sessionSignal]) : sessionSignal));
            const pending = readWorkbenchPendingSubmission(scope, kind);
            if (pending?.acceptedTaskId === id) clearWorkbenchPendingSubmission(scope, kind);
            return result;
        },
        cancelTask: (id) => inSession((signal) => client.cancelTask(id, { signal }).then(task)),
        retryTask: (id) => inSession((signal) => client.retryTask(id, { signal }).then(task)),
        recoverTaskMedia: (id) => inSession((signal) => client.recoverTaskMedia(id, { signal }).then(task)),
        hasPendingSubmission: () => Boolean(readWorkbenchPendingSubmission(scope, kind)),
        recoverPendingSubmission: async () => {
            const pending = readWorkbenchPendingSubmission(scope, kind);
            if (!pending) throw new Error("没有待确认的生成请求");
            return submit(pending.transport, pending.input);
        },
        uploadResource: async (file, mediaKind, meta, onProgress) => {
            onProgress?.(0, file.size);
            const resource = await inSession((signal) => uploadExpandResource(file, mediaKind, meta, signal));
            onProgress?.(file.size, file.size);
            return resource;
        },
        resolveResourceURL: async (resourceId) => expandResourceFileURL(resourceId),
    };
}
