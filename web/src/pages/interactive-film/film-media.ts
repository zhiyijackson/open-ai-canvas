import { createContext, useContext, useEffect, useState } from "react";
type Variant = "playback" | "original";
export const FilmMediaContext = createContext<(id: string, variant: Variant, forceRefresh: boolean) => Promise<string>>(async () => "");
export function useFilmMedia(id?: string, variant: Variant = "original", attempt = 0) {
    const resolve = useContext(FilmMediaContext);
    const [media, setMedia] = useState<{ id: string; variant: Variant; attempt: number; url: string }>();
    useEffect(() => {
        let active = true;
        if (id)
            void resolve(id, variant, attempt > 0)
                .catch(() => "")
                .then((url) => {
                    if (active) setMedia({ id, variant, attempt, url });
                });
        return () => {
            active = false;
        };
    }, [id, variant, resolve, attempt]);
    return media && media.id === id && media.variant === variant && media.attempt === attempt ? media : undefined;
}
export function useFilmMediaUrl(id?: string, variant: Variant = "original") {
    return useFilmMedia(id, variant)?.url || "";
}
