import { useMemo, useState } from "react";
import { Select } from "antd";
import { filmRoutes } from "@/lib/film-interactions";
import { sceneRehearsal } from "@/lib/film-audit";
import type { FilmGraph } from "@/services/api/interactive-films";
import { RehearsalClues } from "./rehearsal-clues";

export function useSceneRehearsal(graph: FilmGraph, scene: string | undefined, time: number, label: string, requiredItem?: string, routesGraph = graph) {
    const routes = useMemo(() => filmRoutes(routesGraph), [routesGraph]);
    const [preferences, setPreferences] = useState<Record<string, number>>({});
    const [arrivalKey, setArrivalKey] = useState("");
    const [clues, setClues] = useState<string[]>([]);
    const arrivals = scene ? routes.arrivals(scene) : [];
    const allowed = arrivals.filter((a) => !requiredItem || a.item === requiredItem);
    const arrival = allowed.find((a) => JSON.stringify(a) === arrivalKey) || allowed[0];
    const { path, branches } = routes.trace(arrival?.parent ?? -1, preferences);
    const rehearsal = scene && arrival ? sceneRehearsal(graph, path, scene, arrival.item, time, clues) : { history: [], optional: [] };
    const controls = (
        <>
            {(allowed.length > 1 || !!requiredItem) && (
                <label>
                    {label}
                    <Select
                        aria-label={label}
                        disabled={!allowed.length}
                        placeholder="没有满足条件的来路"
                        value={arrival && JSON.stringify(arrival)}
                        options={allowed.map((a) => ({ value: JSON.stringify(a), label: routes.arrivalLabel(a) }))}
                        onChange={setArrivalKey}
                    />
                </label>
            )}
            {branches.map((branch) => {
                const name = `${routes.labels.get(branch.scene) || branch.scene}的上游来路`;
                return (
                    <label key={branch.key}>
                        {name}
                        <Select aria-label={name} value={branch.parent} options={branch.options.map((a) => ({ value: a.parent, label: routes.arrivalLabel(a) }))} onChange={(parent) => setPreferences((prev) => ({ ...prev, [branch.key]: parent }))} />
                    </label>
                );
            })}
            <RehearsalClues cues={rehearsal.optional} selected={clues} onChange={setClues} />
        </>
    );
    return { arrival, arrivals, history: rehearsal.history, controls };
}
