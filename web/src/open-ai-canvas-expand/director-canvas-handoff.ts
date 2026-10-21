import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { resourceStorageKey } from "@/services/api/resources";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { createCanvasProjectWithRemoteSync, loadAssetsForUse, loadCanvasProjectForEditing } from "@/services/user-data-sync";
import { useAssetStore } from "@/stores/use-asset-store";
import { expandResourceFileURL, getExpandResource } from "./generation-api";
import { normalizeDirectorSelection, type DirectorSkillSelection, type DirectorSkillSnapshot } from "./director-skills";

const STORAGE_PREFIX = "director-canvas-handoff-v1";
const STORAGE_INDEX_KEY = `${STORAGE_PREFIX}:contexts`;
const MAX_FOCUS_REFERENCES = 8;
const inFlight = new Map<string, Promise<DirectorHandoffNavigation>>();
const volatileRecords = new Map<string, StoredDirectorHandoff>();
const knownContexts = new Map<string, Set<string>>();
const sessionEpochs = new Map<string, number>();
const indexWrites = new Map<string, Promise<void>>();

export type DirectorHandoffResource = {
    resourceId: string;
    kind: "image" | "video" | "audio";
    title?: string;
};

export type StartDirectorHandoffInput = {
    contextId: string;
    prompt: string;
    language?: string;
    durationSeconds?: number;
    assetIds?: readonly string[];
    resources?: readonly DirectorHandoffResource[];
    expectedUserScope?: string;
    skillSelection?: DirectorSkillSelection;
    skillSnapshots?: readonly DirectorSkillSnapshot[];
};

export type DirectorHandoffNavigation = {
    canvasId: string;
    path: string;
    resumed: boolean;
    syncError?: unknown;
};

export type StoredDirectorHandoff = {
    version: 1;
    contextId: string;
    canvasId: string;
    prompt: string;
    language?: string;
    durationSeconds?: number;
    assetIds: string[];
    resourcePayloads: InsertAssetPayload[];
    createdAt: string;
    preparedAt?: string;
    skillIds?: string[];
    skillSelection?: DirectorSkillSelection;
    skillSnapshots?: DirectorSkillSnapshot[];
};

function cleanId(value: string) {
    return value.trim();
}
function unique(values: Iterable<string>) {
    return Array.from(new Set(Array.from(values, cleanId).filter(Boolean)));
}

function storageKey(contextId: string) {
    return `${STORAGE_PREFIX}:${contextId}`;
}

function sessionEpoch(scope: string) {
    return sessionEpochs.get(scope) || 0;
}

function assertSession(scope: string, epoch: number) {
    if (scope !== getActiveUserScope() || sessionEpoch(scope) !== epoch) throw new DOMException("账号已切换，请重新打开超级编导", "AbortError");
}

function rememberContext(scope: string, contextId: string) {
    const contexts = knownContexts.get(scope) || new Set<string>();
    contexts.add(contextId);
    knownContexts.set(scope, contexts);
}

function parseContextIndex(value: string | null) {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? unique(parsed.filter((item): item is string => typeof item === "string")) : [];
    } catch {
        return [];
    }
}

function assertScope(expected?: string) {
    const scope = getActiveUserScope();
    if (expected && expected !== scope) throw new DOMException("账号已切换，请重新打开超级编导", "AbortError");
    return scope;
}

function normalizeInput(input: StartDirectorHandoffInput) {
    const contextId = cleanId(input.contextId);
    const prompt = input.prompt.trim();
    if (!contextId || contextId.length > 128) throw new Error("超级编导上下文 ID 无效");
    if (!prompt) throw new Error("请先填写创作需求");
    const assetIds = unique(input.assetIds || []);
    const resourceById = new Map<string, DirectorHandoffResource>();
    for (const item of input.resources || []) {
        const resourceId = cleanId(item.resourceId);
        if (!resourceId) throw new Error("存在尚未上传完成的参考素材");
        if (!resourceById.has(resourceId)) resourceById.set(resourceId, { ...item, resourceId });
    }
    if (assetIds.length + resourceById.size > MAX_FOCUS_REFERENCES) throw new Error(`超级编导最多引用 ${MAX_FOCUS_REFERENCES} 个焦点素材`);
    if (!assetIds.length && ![...resourceById.values()].some((item) => item.kind === "image")) throw new Error("超级编导至少需要一张参考图片");
    const durationSeconds = input.durationSeconds;
    if (durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) throw new Error("目标时长必须大于 0 秒");
    const skillSelection = input.skillSelection ? normalizeDirectorSelection(input.skillSelection) : undefined;
    const skillSnapshots = input.skillSnapshots?.map((skill) => ({ ...skill }));
    const skillIds = skillSelection?.skillIds.slice();
    if (skillSelection) directorHandoffSkillIds({ skillSelection, skillSnapshots, skillIds });
    return { contextId, prompt, language: input.language?.trim() || undefined, durationSeconds, assetIds, resources: [...resourceById.values()], skillSelection, skillSnapshots, skillIds };
}

/** Missing legacy intent must never be interpreted as an explicit no-skill choice. */
export function directorHandoffSkillIds(record: Pick<StoredDirectorHandoff, "skillIds" | "skillSelection" | "skillSnapshots">): readonly string[] {
    if (!record.skillSelection || !Array.isArray(record.skillIds)) throw new Error("此旧编导记录尚未确认技能，请返回视频工作台重新选择并确认，再继续交接");
    const selection = normalizeDirectorSelection(record.skillSelection);
    if (JSON.stringify(selection.skillIds) !== JSON.stringify(record.skillIds)) throw new Error("编导技能记录不一致，请返回工作台重新选择");
    const snapshots = record.skillSnapshots;
    if (!Array.isArray(snapshots) || snapshots.length !== selection.skillIds.length || snapshots.some((skill, index) => !skill || skill.skillId !== selection.skillIds[index] || typeof skill.skillName !== "string" || !skill.skillName.trim())) {
        throw new Error("编导技能身份快照缺失，请返回工作台重新确认");
    }
    return Object.freeze([...selection.skillIds]);
}

async function resourcePayloads(resources: DirectorHandoffResource[], scope: string): Promise<InsertAssetPayload[]> {
    return Promise.all(
        resources.map(async (reference) => {
            const resource = await getExpandResource(reference.resourceId);
            if (scope !== getActiveUserScope()) throw new DOMException("账号已切换，请重新打开超级编导", "AbortError");
            if (resource.status !== "ready") throw new Error(`参考素材“${reference.title || reference.resourceId}”尚未就绪`);
            if (resource.kind !== reference.kind) throw new Error(`参考素材“${reference.title || reference.resourceId}”的媒体类型已变化，请重新选择`);
            const title = reference.title?.trim() || resource.objectKey.split("/").pop() || `${reference.kind} 素材`;
            const url = expandResourceFileURL(resource.id);
            const storageKey = resourceStorageKey(resource.id);
            if (reference.kind === "image") {
                return { kind: "image", dataUrl: url, storageKey, title, width: resource.width, height: resource.height, bytes: resource.size, mimeType: resource.mimeType };
            }
            if (reference.kind === "video") {
                return { kind: "video", url, storageKey, title, width: resource.width, height: resource.height, durationMs: resource.durationMs, bytes: resource.size, mimeType: resource.mimeType };
            }
            return { kind: "audio", url, storageKey, title, durationMs: resource.durationMs, bytes: resource.size, mimeType: resource.mimeType };
        }),
    );
}

async function validateAssetReferences(assetIds: string[], hasResourceImage: boolean, scope: string, epoch: number) {
    if (assetIds.length) {
        await loadAssetsForUse(assetIds);
        assertSession(scope, epoch);
    }
    const byId = new Map(useAssetStore.getState().assets.map((asset) => [asset.id, asset]));
    if (!hasResourceImage && !assetIds.some((assetId) => byId.get(assetId)?.kind === "image")) throw new Error("超级编导至少需要一张参考图片");
}

async function readStored(contextId: string, scope = getActiveUserScope()) {
    const value = await localForageStorageForScope(scope).getItem(storageKey(contextId));
    if (!value) return volatileRecords.get(`${scope}:${contextId}`) || null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error("超级编导交接记录已损坏，请新建编导任务");
    }
    const record = parsed as Partial<StoredDirectorHandoff>;
    const validPayloads = Array.isArray(record.resourcePayloads) && record.resourcePayloads.every((item) => {
        if (!item || typeof item !== "object") return false;
        const payload = item as Partial<InsertAssetPayload>;
        return ["image", "video", "audio"].includes(payload.kind || "") && typeof payload.title === "string";
    });
    if (
        record.version !== 1 ||
        record.contextId !== contextId ||
        typeof record.canvasId !== "string" ||
        !record.canvasId ||
        typeof record.prompt !== "string" ||
        !Array.isArray(record.assetIds) ||
        !record.assetIds.every((item) => typeof item === "string" && Boolean(item)) ||
        !validPayloads ||
        (record.preparedAt !== undefined && typeof record.preparedAt !== "string")
    ) {
        throw new Error("超级编导交接记录无效，请新建编导任务");
    }
    if (record.skillSelection !== undefined || record.skillIds !== undefined || record.skillSnapshots !== undefined) directorHandoffSkillIds(record);
    rememberContext(scope, contextId);
    return record as StoredDirectorHandoff;
}

async function saveStored(record: StoredDirectorHandoff, scope: string, epoch: number) {
    assertSession(scope, epoch);
    rememberContext(scope, record.contextId);
    volatileRecords.set(`${scope}:${record.contextId}`, record);
    const storage = localForageStorageForScope(scope);
    await storage.setItem(storageKey(record.contextId), JSON.stringify(record));
    try {
        assertSession(scope, epoch);
        const previousIndexWrite = indexWrites.get(scope) || Promise.resolve();
        const nextIndexWrite = previousIndexWrite.catch(() => undefined).then(async () => {
            assertSession(scope, epoch);
            const indexed = parseContextIndex(await storage.getItem(STORAGE_INDEX_KEY));
            assertSession(scope, epoch);
            await storage.setItem(STORAGE_INDEX_KEY, JSON.stringify(unique([...indexed, record.contextId])));
            assertSession(scope, epoch);
        });
        indexWrites.set(scope, nextIndexWrite);
        await nextIndexWrite.finally(() => {
            if (indexWrites.get(scope) === nextIndexWrite) indexWrites.delete(scope);
        });
    } catch (error) {
        volatileRecords.delete(`${scope}:${record.contextId}`);
        await Promise.resolve(storage.removeItem(storageKey(record.contextId))).catch(() => undefined);
        throw error;
    }
}

/** Clears all director handoff state owned by one user scope and invalidates pending async work. */
export async function clearDirectorHandoffSession(scope: string) {
    const cleanScope = cleanId(scope);
    if (!cleanScope) return;
    sessionEpochs.set(cleanScope, sessionEpoch(cleanScope) + 1);
    const operationPrefix = `${cleanScope}:`;
    for (const key of inFlight.keys()) if (key.startsWith(operationPrefix)) inFlight.delete(key);
    const contexts = new Set(knownContexts.get(cleanScope) || []);
    knownContexts.delete(cleanScope);
    for (const key of volatileRecords.keys()) {
        if (!key.startsWith(operationPrefix)) continue;
        contexts.add(key.slice(operationPrefix.length));
        volatileRecords.delete(key);
    }
    await (indexWrites.get(cleanScope) || Promise.resolve()).catch(() => undefined);
    const storage = localForageStorageForScope(cleanScope);
    const persistedIndex = await Promise.resolve(storage.getItem(STORAGE_INDEX_KEY)).catch(() => null);
    for (const contextId of parseContextIndex(persistedIndex)) contexts.add(contextId);
    await Promise.allSettled([...contexts].map((contextId) => Promise.resolve(storage.removeItem(storageKey(contextId)))));
    await Promise.resolve(storage.removeItem(STORAGE_INDEX_KEY)).catch(() => undefined);
    for (const key of volatileRecords.keys()) if (key.startsWith(operationPrefix)) volatileRecords.delete(key);
    for (const key of inFlight.keys()) if (key.startsWith(operationPrefix)) inFlight.delete(key);
}

function preparedInputChanged(record: StoredDirectorHandoff, normalized: ReturnType<typeof normalizeInput>) {
    const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value, index) => value === right[index]);
    const storedResources = record.resourcePayloads.map((payload) => `${payload.kind}:${"storageKey" in payload ? payload.storageKey || "" : ""}`);
    const requestedResources = normalized.resources.map((resource) => `${resource.kind}:${resourceStorageKey(resource.resourceId)}`);
    return (
        record.prompt !== normalized.prompt ||
        record.language !== normalized.language ||
        record.durationSeconds !== normalized.durationSeconds ||
        JSON.stringify(record.skillSelection) !== JSON.stringify(normalized.skillSelection) ||
        JSON.stringify(record.skillIds) !== JSON.stringify(normalized.skillIds) ||
        !same(record.assetIds, normalized.assetIds) ||
        !same(storedResources, requestedResources)
    );
}

export function directorHandoffNavigationPath(record: StoredDirectorHandoff) {
    if (record.preparedAt) return `/canvas/${encodeURIComponent(record.canvasId)}?agent=1`;
    const params = new URLSearchParams({ mode: "director", director: record.contextId });
    return `/canvas/${encodeURIComponent(record.canvasId)}?${params.toString()}`;
}

export async function startOrResumeDirectorHandoff(input: StartDirectorHandoffInput): Promise<DirectorHandoffNavigation> {
    const normalized = normalizeInput(input);
    const scope = assertScope(input.expectedUserScope);
    const epoch = sessionEpoch(scope);
    const operationKey = `${scope}:${normalized.contextId}`;
    const pending = inFlight.get(operationKey);
    if (pending) return pending;

    const operation = (async () => {
        const stored = await readStored(normalized.contextId, scope);
        assertSession(scope, epoch);
        if (stored?.canvasId) {
            if (stored.preparedAt && preparedInputChanged(stored, normalized)) {
                throw new Error(`该编导任务已进入原 Agent 会话；修改需求请前往画布 ${stored.canvasId} 的 Agent 继续对话`);
            }
            await validateAssetReferences(normalized.assetIds, normalized.resources.some((item) => item.kind === "image"), scope, epoch);
            // 创建后的 flush 失败时画布仍在当前 store；优先复用，避免远端尚未观察到该画布时重复创建。
            const localProject = stored.preparedAt ? null : useCanvasStore.getState().openProject(stored.canvasId);
            const project = localProject || (await loadCanvasProjectForEditing(stored.canvasId));
            assertSession(scope, epoch);
            if (!project) throw new Error("关联画布已不存在，请恢复画布或新建编导任务");
            const next = stored.preparedAt
                ? stored
                : {
                      ...stored,
                      prompt: normalized.prompt,
                      language: normalized.language,
                      durationSeconds: normalized.durationSeconds,
                      skillIds: normalized.skillIds,
                      skillSelection: normalized.skillSelection,
                      skillSnapshots: normalized.skillSnapshots,
                      assetIds: normalized.assetIds,
                      resourcePayloads: await resourcePayloads(normalized.resources, scope),
                  };
            assertSession(scope, epoch);
            if (next !== stored) await saveStored(next, scope, epoch);
            if (localProject) {
                await flushCanvasStorePersistence();
                assertSession(scope, epoch);
            }
            return { canvasId: next.canvasId, path: directorHandoffNavigationPath(next), resumed: true };
        }

        if (!useCanvasStore.getState().hydrated) throw new Error("画布资料正在加载，请稍后继续");
        await validateAssetReferences(normalized.assetIds, normalized.resources.some((item) => item.kind === "image"), scope, epoch);
        const payloads = await resourcePayloads(normalized.resources, scope);
        assertSession(scope, epoch);
        const title = normalized.prompt.replace(/\s+/gu, " ").slice(0, 28) || "超级编导";
        const created = await createCanvasProjectWithRemoteSync(title);
        assertSession(scope, epoch);
        const record: StoredDirectorHandoff = {
            version: 1,
            contextId: normalized.contextId,
            canvasId: created.id,
            prompt: normalized.prompt,
            language: normalized.language,
            durationSeconds: normalized.durationSeconds,
            skillIds: normalized.skillIds,
            skillSelection: normalized.skillSelection,
            skillSnapshots: normalized.skillSnapshots,
            assetIds: normalized.assetIds,
            resourcePayloads: payloads,
            createdAt: new Date().toISOString(),
        };
        await saveStored(record, scope, epoch);
        await flushCanvasStorePersistence();
        assertSession(scope, epoch);
        return { canvasId: record.canvasId, path: directorHandoffNavigationPath(record), resumed: false, syncError: created.syncError };
    })().finally(() => {
        if (inFlight.get(operationKey) === operation) inFlight.delete(operationKey);
    });
    inFlight.set(operationKey, operation);
    return operation;
}

export async function loadDirectorHandoff(contextId: string, canvasId: string) {
    const scope = getActiveUserScope();
    const epoch = sessionEpoch(scope);
    const record = await readStored(cleanId(contextId), scope);
    if (!record || record.canvasId !== canvasId) throw new Error("超级编导交接记录与当前画布不匹配");
    assertSession(scope, epoch);
    return record;
}

export async function findDirectorHandoff(contextId: string, expectedUserScope?: string) {
    const scope = assertScope(expectedUserScope);
    const epoch = sessionEpoch(scope);
    const record = await readStored(cleanId(contextId), scope);
    assertSession(scope, epoch);
    return record;
}

export async function markDirectorHandoffPrepared(contextId: string, canvasId: string) {
    const scope = getActiveUserScope();
    const epoch = sessionEpoch(scope);
    const record = await readStored(cleanId(contextId), scope);
    if (!record || record.canvasId !== canvasId) throw new Error("超级编导交接记录与当前画布不匹配");
    assertSession(scope, epoch);
    if (record.preparedAt) return record;
    const next = { ...record, preparedAt: new Date().toISOString() };
    await saveStored(next, scope, epoch);
    return next;
}

export function directorAgentPrompt(record: StoredDirectorHandoff) {
    const constraints = [record.language ? `成片语言：${record.language}` : "", record.durationSeconds ? `目标时长：${record.durationSeconds} 秒` : ""].filter(Boolean);
    return [
        "请作为本项目的超级编导，先分析已选焦点素材和创作需求，再提出可执行的脚本、镜头与制作步骤。",
        `创作需求：${record.prompt}`,
        ...constraints,
        ...(record.skillSelection?.mode === "general" ? ["本轮模式：通用 Agent（未预选场景技能）"] : []),
        ...(record.skillSelection?.presetName ? [`本轮技能场景：${record.skillSelection.presetName}`] : []),
        ...(record.skillSnapshots?.length ? [`本轮真实技能：${record.skillSnapshots.map((skill) => `${skill.skillName}（${skill.skillId}）`).join("、")}`] : []),
        "涉及模型生成或付费操作时，继续使用当前 Agent 的审批与费用确认流程。",
    ].join("\n");
}

export function directorHandoffStorageKeys(record: StoredDirectorHandoff) {
    return new Set(record.resourcePayloads.flatMap((payload) => ("storageKey" in payload && payload.storageKey ? [payload.storageKey] : [])));
}

type DirectorHandoffNode = { id: string; metadata?: { assetId?: unknown; storageKey?: unknown } };

export function uninsertedDirectorHandoffPayloads(nodes: Iterable<DirectorHandoffNode>, payloads: InsertAssetPayload[]) {
    const assetIds = new Set<string>();
    const storageKeys = new Set<string>();
    for (const node of nodes) {
        if (typeof node.metadata?.assetId === "string") assetIds.add(node.metadata.assetId);
        if (typeof node.metadata?.storageKey === "string") storageKeys.add(node.metadata.storageKey);
    }
    return payloads.filter((payload) => {
        if (payload.assetId && assetIds.has(payload.assetId)) return false;
        return !("storageKey" in payload && payload.storageKey && storageKeys.has(payload.storageKey));
    });
}

export function directorHandoffNodeIds(nodes: Iterable<DirectorHandoffNode>, record: StoredDirectorHandoff) {
    const values = Array.from(nodes);
    const selected = new Set<string>();
    const ids: string[] = [];
    for (const assetId of record.assetIds) {
        const node = values.find((candidate) => !selected.has(candidate.id) && candidate.metadata?.assetId === assetId);
        if (node) {
            selected.add(node.id);
            ids.push(node.id);
        }
    }
    for (const storageKey of directorHandoffStorageKeys(record)) {
        const node = values.find((candidate) => !selected.has(candidate.id) && candidate.metadata?.storageKey === storageKey);
        if (node) {
            selected.add(node.id);
            ids.push(node.id);
        }
    }
    return ids;
}
