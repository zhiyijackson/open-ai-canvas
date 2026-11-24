import { Checkbox } from "antd";
import type { FilmCue } from "@/services/api/interactive-films";

export function RehearsalClues({ cues, selected, onChange }: { cues: FilmCue[]; selected: string[]; onChange: (ids: string[]) => void }) {
    return cues.map((cue) => (
        <Checkbox key={cue.id} checked={selected.includes(cue.id)} onChange={(e) => onChange(e.target.checked ? [...selected, cue.id] : selected.filter((id) => id !== cue.id))}>
            带入「{cue.label}」线索
        </Checkbox>
    ));
}
