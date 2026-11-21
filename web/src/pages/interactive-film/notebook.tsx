import { Grid, Segmented } from "antd";
import { BriefcaseBusiness, Ticket } from "lucide-react";
import { useState } from "react";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import type { FilmCheckpoint } from "@/lib/film-audit";
import type { FilmGraph } from "@/services/api/interactive-films";

export function FilmNotebook({ graph, history, open, onClose }: { graph: FilmGraph; history: FilmCheckpoint[]; open: boolean; onClose: () => void }) {
    const [tab, setTab] = useState("已发现的线索");
    const desktop = Grid.useBreakpoint().md;
    const state = history[history.length - 1].state;
    const discoveries = graph.scenes.flatMap((scene) =>
        (scene.track?.cues || []).filter((cue) => cue.kind === "hotspot" && state.clues.includes(cue.id)).map((cue) => ({ id: cue.id, name: cue.collectionName?.trim() || cue.label, description: cue.feedback, source: scene.title })),
    );
    // A director can inject an item at a checkpoint without acquiring it in a scene.
    const acquisition = history.findLastIndex((point, index) => index > 0 && point.state.item === state.item && history[index - 1].state.item !== state.item);
    const source = acquisition > 0 ? graph.scenes.find((scene) => scene.id === history[acquisition - 1].id)?.title : undefined;
    return (
        <AppDrawer title="线索册" open={open} onClose={onClose} focusable={{ focusTriggerAfterClose: false }} placement={desktop ? "right" : "bottom"} size={desktop ? 392 : "min(65dvh, 480px)"}>
            <Segmented options={["已发现的线索", "当前携带"]} value={tab} onChange={setTab} />
            {tab === "当前携带" ? (
                state.item ? (
                    <article className="film-notebook-entry">
                        <BriefcaseBusiness size={18} />
                        <div>
                            <strong>{state.item}</strong>
                            <small>{source ? `取得于 · ${source}` : "试演带入"}</small>
                        </div>
                    </article>
                ) : (
                    <p className="film-notebook-empty">当前没有携带物。</p>
                )
            ) : discoveries.length ? (
                discoveries.map((entry) => (
                    <article className="film-notebook-entry" key={entry.id}>
                        <Ticket size={18} />
                        <div>
                            <strong>{entry.name}</strong>
                            {entry.description && <p>{entry.description}</p>}
                            <small>发现于 · {entry.source}</small>
                        </div>
                    </article>
                ))
            ) : (
                <p className="film-notebook-empty">这次还没有发现线索。</p>
            )}
        </AppDrawer>
    );
}
