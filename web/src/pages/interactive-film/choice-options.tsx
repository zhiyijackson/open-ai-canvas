import { Button } from "antd";
import type { FilmExit } from "@/services/api/interactive-films";

export function ChoiceOptions({ question, exits, onChoose, markedExit }: { question?: string; exits: FilmExit[]; onChoose?: (exit: FilmExit) => void; markedExit?: string }) {
    return (
        <>
            {question?.trim() && <strong className="film-choice-question">{question}</strong>}
            {exits.map((exit, i) => (
                <Button
                    key={exit.id || i}
                    aria-label={exit.label || "继续"}
                    aria-description={markedExit && markedExit === exit.id ? "本次试玩的出口" : undefined}
                    data-rehearsal-target={(!!markedExit && markedExit === exit.id) || undefined}
                    onClick={onChoose && (() => onChoose(exit))}
                >
                    {exit.label || "继续"}
                </Button>
            ))}
        </>
    );
}
