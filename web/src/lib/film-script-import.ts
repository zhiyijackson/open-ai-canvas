import type { FilmGraph, FilmScene } from "@/services/api/interactive-films";
import { filmGraphIssue, filmNovelFits } from "./interactive-film";

export const branchScriptExample = `[S01] 闭馆铃响
闭馆铃响，桌上放着一本登记簿。
- 打开登记簿 → E01
- 独自离开 → E02
[E01] 留下署名
她翻开登记簿，写下母亲的名字。
[E02] 合上木门
她把钥匙交还给管理员。`;

export type FilmImportReview = { graph: FilmGraph; exitLines: number[][] };

export function parseBranchScript(text: string): FilmImportReview {
    if (!filmNovelFits(text)) throw new Error("剧本最多 600 万字");
    const scenes: FilmScene[] = [],
        exitLines: number[][] = [],
        ids = new Set<string>();
    let body: string[] = [],
        headerLine = 0;
    function finishScene() {
        const scene = scenes.at(-1);
        if (!scene) return;
        scene.script = body.join("\n").trim();
        body = [];
        if (!scene.script || Array.from(scene.script).length > 12000) throw new Error(`第 ${headerLine} 行 · ${scene.id} 需填写 1–12000 字场次剧本`);
        scene.mode = scene.exits.length > 1 ? "choice" : scene.exits.length ? "next" : "ending";
    }
    for (const [index, raw] of text.split(/\r\n?|\n/).entries()) {
        const line = index + 1,
            value = raw.trim();
        const scene = scenes.at(-1);
        if (value.startsWith("[")) {
            finishScene();
            const header = value.match(/^\[([\w-]{1,64})\]\s*(.+)$/);
            if (!header || !header[2].trim() || Array.from(header[2].trim()).length > 60) throw new Error(`第 ${line} 行 · 请使用 [编号] 场名，场名最多 60 字`);
            if (ids.has(header[1])) throw new Error(`第 ${line} 行 · 重复编号 ${header[1]}`);
            if (scenes.length >= 300) throw new Error(`第 ${line} 行 · 作品最多 300 场`);
            ids.add(header[1]);
            headerLine = line;
            scenes.push({ id: header[1], title: header[2].trim(), source: "", script: "", mode: "ending", exits: [] });
            exitLines.push([]);
        } else if (scene && value.startsWith("-")) {
            const edge = value.match(/^-\s*(.+?)\s*→\s*([\w-]{1,64})$/);
            if (!edge || !edge[1].trim()) throw new Error(`第 ${line} 行 · 选项格式应为「- 行动 → 场次编号」`);
            if (scene.exits.length >= 32) throw new Error(`第 ${line} 行 · 每场最多 32 个去向`);
            scene.exits.push({ label: edge[1].trim(), target: edge[2] });
            exitLines[scenes.length - 1].push(line);
        } else if (scene) body.push(raw);
        else if (value) throw new Error(`第 ${line} 行 · 请先填写 [编号] 场名`);
    }
    finishScene();
    if (!scenes.length) throw new Error("请至少填写一场剧本");
    return { graph: { start: scenes[0].id, scenes }, exitLines };
}

export function importedGraphIssue({ graph, exitLines }: FilmImportReview) {
    const ids = new Set(graph.scenes.map((scene) => scene.id));
    for (const [i, scene] of graph.scenes.entries()) {
        for (const [j, edge] of scene.exits.entries()) {
            if (!ids.has(edge.target)) return `第 ${exitLines[i][j]} 行 · ${scene.id} 的目标 ${edge.target} 不存在`;
        }
    }
    return filmGraphIssue(graph);
}

export function replaceBranchTarget(text: string, line: number, target: string) {
    const parts = text.split(/(\r\n|\r|\n)/);
    const index = (line - 1) * 2;
    parts[index] = parts[index].replace(/[\w-]+(\s*)$/, target + "$1");
    return parts.join("");
}
