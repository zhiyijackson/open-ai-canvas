import { resolveDramaMedia } from "@/pages/projects/drama-shared";
import { FilmMediaContext } from "./film-media";
import { FilmPlayer as Player, type PlayerProps } from "./player";
export function FilmPlayer(props: PlayerProps) {
    return (
        <FilmMediaContext.Provider value={resolveDramaMedia}>
            <Player {...props} />
        </FilmMediaContext.Provider>
    );
}
