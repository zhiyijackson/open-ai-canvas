import localforage from "localforage";
import { nanoid } from "nanoid";
import type { FilmDraft } from "@/services/api/interactive-films";
import type { TrackDraft } from "./interaction-track";

const store = localforage.createInstance({ name: "yingce-film-editor", storeName: "drafts", driver: localforage.INDEXEDDB });
const tabKey = "yingce:film-editor-tab";
let session: Promise<string> | undefined;

// sessionStorage survives reload, but duplicating a tab also copies its ID.
// The document owns the lock until the browser unloads it.
function tabId() {
    session ??= (async () => {
        let id = sessionStorage.getItem(tabKey) || nanoid();
        if (navigator.locks) {
            const claim = (candidate: string) =>
                new Promise<boolean>((resolve, reject) => {
                    void navigator.locks
                        .request(`${tabKey}:${candidate}`, { ifAvailable: true }, (lock) => {
                            resolve(!!lock);
                            if (lock) return new Promise<void>(() => {});
                        })
                        .catch(reject);
                });
            while (!(await claim(id))) id = nanoid();
        } else if (window.opener && performance.getEntriesByType("navigation").some((e) => (e as PerformanceNavigationTiming).type === "navigate")) id = nanoid();
        sessionStorage.setItem(tabKey, id);
        return id;
    })();
    return session;
}

type DraftLocation = { key: string; tab: string; scope: string; scene?: string; title: string; preview: string; savedAt?: number };

export const filmDraftStorage = {
    async list(owner: string, film: string, kind?: string, scene?: string | null) {
        const tab = await tabId();
        const held = new Set((await navigator.locks?.query())?.held?.map((lock) => lock.name));
        const drafts: DraftLocation[] = [];
        for (const key of await store.keys()) {
            const parts = JSON.parse(key);
            if (parts.length !== 2) continue;
            const [source, scope] = parts;
            if (source !== tab && held.has(`${tabKey}:${source}`)) continue;
            const [account, project, type, id] = JSON.parse(scope);
            if (account !== owner || project !== film || (kind && kind !== type) || (scene && id && scene !== id)) continue;
            // The editor already restores its own canonical key automatically.
            if (source === tab && kind && (kind !== "track" || (scene && scene === id))) continue;
            const entry = await store.getItem<(TrackDraft | { draft: FilmDraft }) & { savedAt?: number }>(key);
            if (!entry) continue;
            if ("scene" in entry) {
                if (scene && scene !== entry.scene.id) continue;
                drafts.push({ key, tab: source, scope, scene: entry.scene.id, title: entry.scene.title, preview: entry.scene.track?.cues.find((cue) => cue.kind === "choice")?.question || "成片互动轨", savedAt: entry.savedAt });
            } else drafts.push({ key, tab: source, scope, title: entry.draft.title, preview: entry.draft.graph.scenes[0]?.exits[0]?.label || "剧情草稿", savedAt: entry.savedAt });
        }
        return drafts.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    },
    async restore(source: DraftLocation, scope: string) {
        const tab = await tabId();
        const destination = JSON.stringify([tab, scope]);
        const transfer = async () => {
            const draft = await store.getItem(source.key);
            if (!draft) throw new Error("这份草稿已在其他页面恢复，请重新选择。");
            if (source.key !== destination) {
                if (await store.getItem(destination)) throw new Error("本页已有待同步草稿，请先处理。");
                await store.setItem(destination, draft);
                // Without a lock the original tab may still be editing its copy.
                if (navigator.locks || tab === source.tab) await store.removeItem(source.key);
            }
        };
        if (!navigator.locks || tab === source.tab) return transfer();
        return navigator.locks.request(`${tabKey}:${source.tab}`, { ifAvailable: true }, (lock) => {
            if (!lock) throw new Error("原标签页正在编辑这份草稿，请在那里继续。");
            return transfer();
        });
    },
    async getItem<T>(scope: string, migrate = false) {
        const key = JSON.stringify([await tabId(), scope]);
        const current = await store.getItem<T>(key);
        if (current || !migrate) return current;
        const legacy = await store.getItem<T>(scope);
        if (legacy) {
            await store.setItem(key, legacy);
            await store.removeItem(scope);
        }
        return legacy;
    },
    async setItem<T extends object>(scope: string, entry: T) {
        await store.setItem(JSON.stringify([await tabId(), scope]), { ...entry, savedAt: Date.now() });
    },
    async removeItem(scope: string) {
        await store.removeItem(JSON.stringify([await tabId(), scope]));
    },
};
