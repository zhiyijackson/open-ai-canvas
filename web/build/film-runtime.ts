import { resolve } from "node:path";
import { build, type Plugin } from "vite";

// Export the very same player as one self-contained browser module. Dev exports
// must also work away from Vite, including on machines without node_modules.
export function filmRuntime(root: string): Plugin {
    const fileName = "film-runtime/player.js";
    async function bundle() {
        const result = await build({
            root,
            configFile: false,
            oxc: { jsx: { development: false } },
            mode: "production",
            publicDir: false,
            logLevel: "warn",
            resolve: { alias: { "@": resolve(root, "src") } },
            define: { "process.env.NODE_ENV": '"production"' },
            build: { write: false, lib: { entry: resolve(root, "src/pages/interactive-film/h5-entry.tsx"), name: "YingceFilm", formats: ["iife"] }, minify: true },
        });
        const chunks = (Array.isArray(result) ? result : [result]).flatMap((output) => ("output" in output ? output.output : []));
        if (chunks.length !== 1 || chunks[0].type !== "chunk") throw new Error("H5 播放器构建必须生成一个独立脚本");
        return chunks[0].code;
    }
    return {
        name: "film-runtime",
        configureServer(server) {
            let cached: Promise<string> | undefined;
            server.watcher.on("change", () => {
                cached = undefined;
            });
            server.middlewares.use("/" + fileName, (_req, res, next) => {
                cached ??= bundle();
                void cached.then(
                    (code) => {
                        res.setHeader("Content-Type", "application/javascript");
                        res.end(code);
                    },
                    (error) => {
                        cached = undefined;
                        next(error);
                    },
                );
            });
        },
        async generateBundle() {
            this.emitFile({ type: "asset", fileName, source: await bundle() });
        },
    };
}
