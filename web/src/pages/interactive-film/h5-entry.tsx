import { createRoot } from "react-dom/client";
import { useState } from "react";
import { FilmPlayer } from "./player";
import { FilmMediaContext } from "./film-media";
import type { FilmPackage } from "./h5-export";
import { filmGraphIssue } from "@/lib/interactive-film";
import { Play } from "lucide-react";

function Work({ story }: { story: FilmPackage }) {
    const [started, start] = useState(false);
    const first = story.graph.scenes.find((s) => s.id === story.graph.start)!;
    const cover = story.assets[story.sceneResources[first.id]];
    return started ? (
        <FilmMediaContext.Provider value={async (id) => story.assets[id] || ""}>
            <FilmPlayer graph={story.graph} takes={{}} episodes={[]} posters={story.posters} stills={story.stills} sceneResources={story.sceneResources} audience />
        </FilmMediaContext.Provider>
    ) : (
        <div className="film-cover">
            {story.stills?.[first.id] ? <img src={story.stills[first.id]} alt="" /> : cover && (first.media?.kind === "event" ? <img src={cover} alt="" /> : <video src={cover + "#t=0.1"} muted playsInline preload="metadata" aria-hidden="true" />)}
            <div className="film-cover-credit">
                <h1>{story.title}</h1>
                <button onClick={() => start(true)}>
                    <Play size={16} fill="currentColor" aria-hidden="true" />
                    进入故事
                </button>
            </div>
        </div>
    );
}
async function openStory() {
    const root = document.getElementById("app")!;
    try {
        const response = await fetch("./story.json");
        if (!response.ok) throw Error("读取 story.json 失败");
        const story: FilmPackage = await response.json();
        if (story.version !== 1) throw Error("工程版本与播放器不匹配");
        const issue = filmGraphIssue(story.graph);
        if (issue) throw Error(issue);
        document.title = story.title;
        createRoot(root).render(<Work story={story} />);
    } catch (error) {
        root.textContent = error instanceof Error ? error.message : "无法打开工程";
    }
}
void openStory();
