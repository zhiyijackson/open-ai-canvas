import { mock } from "bun:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Skill } from "../../src/services/api/skills";

const window = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window, document: window.document, navigator: window.navigator, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
let resolveInstall!: () => void;
let rejectInstall!: (error: Error) => void;
let changes = 0;
let errors = 0;
let events = 0;
let invalidations = 0;
let install!: (skill: Skill) => Promise<void>;
const Null = () => null;
mock.module("antd", () => ({ App: { useApp: () => ({ message: { warning: () => {}, error: () => { errors++; } } }) }, Alert: Null, Button: Null, Select: Null, Space: Null, Tag: Null }));
mock.module("@tanstack/react-query", () => ({ useQuery: () => ({ data: { categories: [] } }), useInfiniteQuery: () => ({ data: { pages: [] }, isFetching: false }), useQueryClient: () => ({ invalidateQueries: async () => { invalidations++; } }) }));
mock.module("@/components/skills/skill-curation-browser", () => ({ curationQuery: () => ({}), useSkillCuration: () => ({}) }));
mock.module("@/lib/user-scope", () => ({ getActiveUserScope: () => "user-a" }));
mock.module("@/services/api/skills", () => ({ addSkill: () => new Promise<void>((resolve, reject) => { resolveInstall = resolve; rejectInstall = reject; }), listSkillLibraryCategories: async () => ({}), listSkills: async () => ({}) }));
mock.module("@/components/canvas/canvas-agent-skill-library-modal", () => ({ CanvasAgentSkillLibraryModal: (props: { onInstall: typeof install }) => { install = props.onInstall; return null; } }));
window.addEventListener("canvas-skills-changed", () => { events++; });
const { WorkbenchDirectorSkills } = await import("../../src/open-ai-canvas-expand/workbench-director-skills");
type Props = Parameters<typeof WorkbenchDirectorSkills>[0];
const director = { contextId: "original-context", selection: { mode: "custom", skillIds: ["skill-a"] }, skillPickerOpen: true, installedSkills: [], selectedSkills: [], presets: [], setSelection: () => {}, skillsLoading: false, skillsError: "", skillsIssue: "missing", missingSkills: [] } as unknown as Props["director"];
const theme = { node: { muted: "var(--text-muted)" } } as Props["theme"];
const skill = { skillId: "skill-b", isAdded: false } as Skill;
try {
    for (const outcome of ["success", "failure", "mounted"] as const) {
        const element = document.createElement("div");
        document.body.append(element);
        const root = createRoot(element);
        await act(async () => root.render(createElement(WorkbenchDirectorSkills, { director, userId: "user-a", theme, onSelectionChange: () => { changes++; } })));
        let attempt!: Promise<void>;
        await act(async () => { attempt = install(skill); });
        if (outcome !== "mounted") await act(async () => root.unmount());
        await act(async () => { if (outcome === "failure") rejectInstall(new Error("late failure")); else resolveInstall(); await attempt; });
        if (outcome === "mounted") {
            assert.equal(changes, 1);
            assert.equal(invalidations, 2);
            assert.equal(events, 1);
            await act(async () => root.unmount());
        } else {
            assert.equal(changes, 0, "unmounted install cannot open selection confirmation");
            assert.equal(invalidations, 0, "unmounted install cannot refresh old view queries");
            assert.equal(events, 0);
        }
        assert.equal(errors, 0, "unmounted failure cannot notify another page");
        element.remove();
    }
    console.log("workbench-skill-lifecycle: passed");
} finally { await window.happyDOM.abort(); }
