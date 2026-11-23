import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FilmExit, FilmScene } from "@/services/api/interactive-films";
import { useFilmMediaUrl } from "./film-media";

function SpotButton({ edge, choose }: { edge: FilmExit; choose: () => void }) {
    const image = useFilmMediaUrl(edge.spot?.resourceId);
    const spot = edge.spot!;
    return (
        <button
            type="button"
            data-glow={spot.appearance !== "static"}
            className="film-event-spot"
            style={{ left: spot.x + "%", top: spot.y + "%", width: spot.width ? spot.width + "%" : undefined, height: spot.height ? spot.height + "%" : undefined }}
            onClick={choose}
        >
            {image && <img className="film-button-art" src={image} alt="" />}
            <span>{edge.label || "继续"}</span>
        </button>
    );
}

export function EventFrame({
    scene,
    exits,
    onAction,
    background,
    backdropVideo,
    suspended,
    noTimer,
    onReplay,
}: {
    scene: FilmScene;
    exits: FilmExit[];
    onAction: (edge: FilmExit) => void;
    background?: string;
    backdropVideo?: string;
    suspended?: boolean;
    noTimer?: boolean;
    onReplay?: () => void;
}) {
    const url = useFilmMediaUrl(scene.media?.resourceId) || background;
    const [feedback, setFeedback] = useState<FilmExit>();
    const [broken, setBroken] = useState("");
    const [stack, setStack] = useState(false);
    const frame = useRef<HTMLDivElement>(null);
    const submit = useRef(false);
    const act = useRef(() => {});
    act.current = () => {
        if (exits[0]) choose(exits[0]);
    };
    const elapsed = useRef(0);
    useEffect(() => {
        if (!scene.media?.advanceMs || scene.mode !== "next" || noTimer || suspended || feedback) return;
        let previous = performance.now();
        const reset = () => {
            previous = performance.now();
        };
        document.addEventListener("visibilitychange", reset);
        const timer = setInterval(() => {
            const now = performance.now();
            if (!document.hidden) elapsed.current += now - previous;
            previous = now;
            if (elapsed.current >= scene.media!.advanceMs!) {
                clearInterval(timer);
                act.current();
            }
        }, 100);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", reset);
        };
    }, [scene, noTimer, suspended, feedback]);
    const next = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (feedback) next.current?.focus({ preventScroll: true });
    }, [feedback]);
    // Measure natural hotspot rectangles, including the real touch target. When
    // labels overlap or run off the frame, keep every action reachable in-frame.
    useLayoutEffect(() => {
        const element = frame.current;
        if (!element) return;
        function measure() {
            if (!element) return;
            const bounds = element.getBoundingClientRect();
            const spots = Array.from(element.querySelectorAll<HTMLElement>(".film-event-spot"));
            const boxes = spots.map((b) => b.getBoundingClientRect());
            setStack(boxes.some((r, i) => r.left < bounds.left || r.right > bounds.right || r.top < bounds.top || r.bottom > bounds.bottom || boxes.slice(0, i).some((p) => p.left < r.right && p.right > r.left && p.top < r.bottom && p.bottom > r.top)));
        }
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        for (const spot of element.querySelectorAll(".film-event-spot")) observer.observe(spot);
        measure();
        return () => observer.disconnect();
    }, [exits.length, feedback]);
    function commit(edge: FilmExit) {
        if (submit.current) return;
        submit.current = true;
        onAction(edge);
    }
    function choose(edge: FilmExit) {
        if (feedback) return;
        if (edge.feedback) setFeedback(edge);
        else commit(edge);
    }
    const textOnly = scene.media?.presentation === "text";
    const options = exits.filter((edge) => textOnly || !edge.spot || stack);
    return (
        <div className="film-event-frame" ref={frame} data-stack={stack} data-image={!!(url || backdropVideo) && broken !== (url || backdropVideo)}>
            {!url && backdropVideo && broken !== backdropVideo && (
                <video
                    muted
                    playsInline
                    className="film-event-background"
                    src={backdropVideo}
                    onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        frame.current?.style.setProperty("--film-aspect", String(v.videoWidth / v.videoHeight));
                        v.currentTime = Math.max(0, v.duration - 0.05);
                    }}
                    onError={() => setBroken(backdropVideo)}
                />
            )}
            {url && broken !== url && (
                <img
                    className="film-event-background"
                    alt={scene.title}
                    src={url}
                    onLoad={(e) => {
                        const img = e.currentTarget;
                        frame.current?.style.setProperty("--film-aspect", String(img.naturalWidth / img.naturalHeight));
                    }}
                    onError={() => setBroken(url)}
                />
            )}
            <div className="film-event-content">
                <p className="film-event-prompt">{scene.script}</p>
                {!feedback && !textOnly && exits.map((edge, i) => edge.spot && <SpotButton key={edge.id || i} edge={edge} choose={() => choose(edge)} />)}
                <div className="film-event-options">
                    {scene.mode === "ending" && <strong>已抵达结局 · {scene.title}</strong>}
                    {scene.mode === "ending" && onReplay && (
                        <button type="button" onClick={onReplay}>
                            重新选择
                        </button>
                    )}
                    {feedback ? (
                        <>
                            <p role="status">{feedback.feedback}</p>
                            <button ref={next} type="button" onClick={() => commit(feedback)}>
                                继续剧情
                            </button>
                        </>
                    ) : (
                        options.map((edge, i) => (
                            <button type="button" key={edge.id || i} onClick={() => choose(edge)}>
                                {edge.label || "继续"}
                            </button>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
