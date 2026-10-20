import type { CreateTaskInput } from "@/services/api/task-center";
import type { CreateWorkbenchTaskInput, WorkbenchKind } from "@/services/api/workbench";

export type WorkbenchDraftReference = {
    resourceId: string;
    kind: "image" | "video" | "audio";
    role?: "reference" | "first_frame" | "last_frame";
    slotKey?: string;
    name?: string;
};

export type WorkbenchSessionDraft = {
    prompt: string;
    directorContextId?: string;
    directorLanguage?: string;
    toolId?: string;
    presetId?: string;
    model: string;
    parameters: Record<string, string>;
    references: WorkbenchDraftReference[];
};

export type WorkbenchPendingSubmission =
    | { transport: "workbench"; fingerprint: string; clientOperationId: string; acceptedTaskId?: string; input: CreateWorkbenchTaskInput & { clientOperationId: string } }
    | { transport: "generation"; fingerprint: string; clientOperationId: string; acceptedTaskId?: string; input: CreateTaskInput & { clientOperationId: string } };

export type WorkbenchMaskPendingSubmission = {
    fingerprint: string;
    clientOperationId: string;
    input: CreateTaskInput & { clientOperationId: string };
};

const sessionDrafts = new Map<string, WorkbenchSessionDraft>();
const pendingSubmissions = new Map<string, WorkbenchPendingSubmission>();
const pendingMaskSubmissions = new Map<string, WorkbenchMaskPendingSubmission>();
const submissionLocks = new Map<string, string>();
const sessionAbortControllers = new Map<string, Set<AbortController>>();
const sessionEpochs = new Map<string, number>();

function draftKey(scope: string, kind: WorkbenchKind) {
    return `${scope.trim() || "guest"}:${kind}`;
}

function cloneDraft(draft: WorkbenchSessionDraft): WorkbenchSessionDraft {
    return { ...draft, parameters: { ...draft.parameters }, references: draft.references.map((reference) => ({ ...reference })) };
}

function clonePendingSubmission(submission: WorkbenchPendingSubmission): WorkbenchPendingSubmission {
    return structuredClone(submission);
}

export function readWorkbenchDraft(scope: string, kind: WorkbenchKind) {
    const draft = sessionDrafts.get(draftKey(scope, kind));
    return draft ? cloneDraft(draft) : null;
}

export function writeWorkbenchDraft(scope: string, kind: WorkbenchKind, draft: WorkbenchSessionDraft) {
    sessionDrafts.set(draftKey(scope, kind), cloneDraft(draft));
}

export function clearWorkbenchDraft(scope: string, kind: WorkbenchKind) {
    sessionDrafts.delete(draftKey(scope, kind));
}

export function readWorkbenchPendingSubmission(scope: string, kind: WorkbenchKind) {
    const submission = pendingSubmissions.get(draftKey(scope, kind));
    return submission ? clonePendingSubmission(submission) : null;
}

export function writeWorkbenchPendingSubmission(scope: string, kind: WorkbenchKind, submission: WorkbenchPendingSubmission) {
    pendingSubmissions.set(draftKey(scope, kind), clonePendingSubmission(submission));
}

export function clearWorkbenchPendingSubmission(scope: string, kind: WorkbenchKind) {
    pendingSubmissions.delete(draftKey(scope, kind));
}

export function readWorkbenchMaskPendingSubmission(scope: string) {
    const submission = pendingMaskSubmissions.get(draftKey(scope, "image"));
    return submission ? structuredClone(submission) : null;
}

export function writeWorkbenchMaskPendingSubmission(scope: string, submission: WorkbenchMaskPendingSubmission) {
    pendingMaskSubmissions.set(draftKey(scope, "image"), structuredClone(submission));
}

export function clearWorkbenchMaskPendingSubmission(scope: string) {
    pendingMaskSubmissions.delete(draftKey(scope, "image"));
}

export function tryLockWorkbenchSubmission(scope: string, kind: WorkbenchKind, clientOperationId: string) {
    const key = draftKey(scope, kind);
    if (submissionLocks.has(key)) return false;
    submissionLocks.set(key, clientOperationId);
    return true;
}

export function unlockWorkbenchSubmission(scope: string, kind: WorkbenchKind, clientOperationId: string) {
    const key = draftKey(scope, kind);
    if (submissionLocks.get(key) === clientOperationId) submissionLocks.delete(key);
}

export function registerWorkbenchSessionAbort(scope: string, controller: AbortController) {
    const key = scope.trim() || "guest";
    const controllers = sessionAbortControllers.get(key) || new Set<AbortController>();
    controllers.add(controller);
    sessionAbortControllers.set(key, controllers);
    return () => {
        controllers.delete(controller);
        if (!controllers.size) sessionAbortControllers.delete(key);
    };
}

export function workbenchSessionEpoch(scope: string) {
    return sessionEpochs.get(scope.trim() || "guest") || 0;
}

export function clearWorkbenchDraftsForScope(scope: string) {
    const normalizedScope = scope.trim() || "guest";
    const prefix = `${normalizedScope}:`;
    sessionEpochs.set(normalizedScope, workbenchSessionEpoch(normalizedScope) + 1);
    for (const controller of sessionAbortControllers.get(normalizedScope) || []) controller.abort();
    sessionAbortControllers.delete(normalizedScope);
    for (const key of sessionDrafts.keys()) {
        if (key.startsWith(prefix)) sessionDrafts.delete(key);
    }
    for (const key of pendingSubmissions.keys()) {
        if (key.startsWith(prefix)) pendingSubmissions.delete(key);
    }
    for (const key of pendingMaskSubmissions.keys()) {
        if (key.startsWith(prefix)) pendingMaskSubmissions.delete(key);
    }
    for (const key of submissionLocks.keys()) {
        if (key.startsWith(prefix)) submissionLocks.delete(key);
    }
}

export function sameWorkbenchDraft(left: WorkbenchSessionDraft, right: WorkbenchSessionDraft) {
    return JSON.stringify(left) === JSON.stringify(right);
}
