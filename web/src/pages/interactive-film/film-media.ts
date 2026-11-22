import { createContext, useContext, useEffect, useState } from "react";
type Variant = "playback" | "original";
export const FilmMediaContext = createContext<(id: string, variant: Variant) => Promise<string>>(async () => "");
export function useFilmMediaUrl(id?: string, variant: Variant = "original") {
    const resolve = useContext(FilmMediaContext);
    const [media, setMedia] = useState<{ id: string; url: string }>();
    useEffect(() => {
        let active = true;
        if (id)
            void resolve(id, variant).then((url) => {
                if (active) setMedia({ id, url });
            });
        return () => {
            active = false;
        };
    }, [id, variant, resolve]);
    return media && media.id === id ? media.url : "";
}
