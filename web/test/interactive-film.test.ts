import { expect, test } from "bun:test";
import { importedGraphIssue, parseBranchScript, replaceBranchTarget } from "../src/lib/film-script-import";
import { filmTrackIssue, filmRulesIssue, filmArrivals, availableExits, inspectFilmCue, takeFilmExit } from "../src/lib/film-interactions";
import type { FilmGraph, FilmCue } from "../src/services/api/interactive-films";
import { filmDecisionKey, filmRouteCases } from "../src/lib/film-audit";
import { appendFilmScenes, filmGraphIssue, filmNovelFits, insertFilmNode, newFilmMediaNode, missingFilmScenes, parseFilmGraph, recoverFilmGraph } from "../src/lib/interactive-film";

test("手工搭建可从空出口接入结局并保留另一个分支", () => {
    const opening = newFilmMediaNode("open", "event");
    opening.mode = "choice";
    opening.exits = [
        { label: "留下", target: "", feedback: "门关上了" },
        { label: "出发", target: "" },
    ];
    const first = insertFilmNode({ start: opening.id, scenes: [opening] }, opening.id, 0, "stay", "clip");
    const graph = insertFilmNode(first, opening.id, 1, "go", "clip");
    expect(graph.scenes[0].exits[0]).toEqual({ ...opening.exits[0], target: "stay" });
    expect(graph.scenes[1].mode).toBe("ending");
    expect(filmGraphIssue(graph, true)).toBe("");
    expect(filmGraphIssue(graph)).toContain("绑定视频");
    expect(insertFilmNode(graph, opening.id, 8, "bad", "clip")).toBe(graph);
});

test("连线上插入节点保留选择条件、效果和汇合点，片段可沿用同集素材", () => {
    const { graph } = parseBranchScript("[A] 入站\n铃响。\n- 查票 → E\n- 绕行 → E\n[E] 月台\n火车来了。");
    const original = graph.scenes[0].exits[0];
    Object.assign(original, { id: "ticket", item: "车票" });
    const event = insertFilmNode(graph, "A", 0, "tap", "event");
    const cut = insertFilmNode(event, "tap", 0, "shot", "clip");
    expect(original.target).toBe("E");
    expect(cut.scenes[0].exits).toEqual([{ ...original, target: "tap" }, graph.scenes[0].exits[1]]);
    expect(filmGraphIssue(cut)).toContain("绑定视频");
    cut.scenes[3].media!.resourceId = "segment-video";
    expect(filmGraphIssue(cut)).toBe("");
    cut.scenes[2].exits[0].feedback = "末班车";
    const generated = parseFilmGraph(JSON.stringify(cut));
    expect(generated.scenes[2].media).toEqual({ kind: "event" });
    expect(generated.scenes[2].exits[0].feedback).toBe("末班车");
    const ending = insertFilmNode(cut, "E", -1, "close", "event");
    expect(ending.scenes.at(-1)?.mode).toBe("ending");
    expect(filmGraphIssue(ending)).toBe("");
});

test("导入保留原文行号，两条分支可汇合到同一场，修正结果可再次导入", () => {
    const text = "[A] 入口\r\n向前走。\r\n\r\n- 走左边 → E\r\n- 走右边 → LOST  \r\n[E] 门厅\r\n灯亮了。";
    const broken = parseBranchScript(text);
    expect(importedGraphIssue(broken)).toContain("第 5 行");
    const fixed = replaceBranchTarget(text, broken.exitLines[0][1], "E");
    expect(fixed).toBe(text.replace("LOST", "E"));
    const review = parseBranchScript(fixed);
    expect(importedGraphIssue(review)).toBe("");
    expect(review.graph.scenes.map((scene) => scene.mode)).toEqual(["choice", "ending"]);
    expect(review.graph.scenes[0].exits.map((exit) => exit.target)).toEqual(["E", "E"]);
});

test("剧本核对阻止重复编号、回环和不可达场次", () => {
    const opening = "[A] 入口\n风起。\n";
    expect(() => parseBranchScript(opening + "[A] 尾声\n落幕。")).toThrow("第 3 行 · 重复编号 A");
    expect(importedGraphIssue(parseBranchScript(opening + "- 返回 → A"))).toContain("回环");
    expect(importedGraphIssue(parseBranchScript(opening + "[B] 尾声\n落幕。"))).toContain("无法到达 尾声");
});

test("整本原著按 Unicode 字符计数，包含换行和非 BMP 字符", () => {
    const novel = "文".repeat(5_999_998) + "\n🌙";
    expect(filmNovelFits(novel)).toBe(true);
    expect(filmNovelFits(novel + "字")).toBe(false);
});

test("时间窗口边界、换版越界与检查点互不污染", () => {
    const clue: FilmCue = { id: "ticket", kind: "hotspot", label: "翻票根", atMs: 6000, endMs: 10000 };
    const graph = sceneFixture();
    const scene = graph.scenes[0];
    scene.track = { resourceId: "v1", durationMs: 30000, cues: [clue, { id: "ask", kind: "choice", atMs: 16000 }] };
    expect(filmTrackIssue(scene)).toBe("");
    expect(filmTrackIssue(scene, scene.track, 12000)).toContain("超出");
    scene.track.cues[1].atMs = 9999;
    expect(filmTrackIssue(scene)).toContain("重叠");
    scene.track.cues[1].atMs = 10000;
    expect(filmTrackIssue(scene)).toBe("");
    const before = inspectFilmCue({ item: "", clues: [] }, clue);
    expect(inspectFilmCue(before, clue)).toBe(before);
    expect(takeFilmExit(before, scene.exits[0])).toEqual({ item: "围裙", clues: ["ticket"] });
    expect(before.item).toBe("");
});

function sceneFixture(): FilmGraph {
    return {
        start: "a",
        scenes: [
            {
                id: "a",
                title: "选择",
                source: "",
                script: "拿一件物品。",
                mode: "choice",
                exits: [
                    { label: "穿上", target: "b", item: "围裙" },
                    { label: "拿起", target: "b", item: "磁带" },
                ],
            },
            {
                id: "b",
                title: "问询",
                source: "",
                script: "值班员抬头。",
                mode: "choice",
                exits: [
                    { id: "apron", label: "查验", requiresItem: "围裙", target: "c" },
                    { id: "keep", label: "暂存", target: "c" },
                ],
            },
            { id: "c", title: "闭馆", source: "", script: "灯灭。", mode: "ending", exits: [] },
        ],
    };
}
test("汇合后的每一种携带物都必须有可用的超时默认项", () => {
    const graph = sceneFixture(),
        scene = graph.scenes[1];
    expect(filmArrivals(graph, "b").map((entry) => entry.item)).toEqual(["围裙", "磁带"]);
    expect(availableExits(scene, "磁带").map((edge) => edge.id)).toEqual(["keep"]);
    const choice: FilmCue = { id: "timer", kind: "choice", atMs: 2000, timeoutMs: 1000, defaultExit: "apron" };
    scene.track = { resourceId: "v2", durationMs: 4000, cues: [choice] };
    expect(filmRulesIssue(graph)).toContain("超时默认");
    choice.defaultExit = "keep";
    expect(filmRulesIssue(graph)).toBe("");
});

test("体检以实际携带物与最后一次选择区分路线，保留限时默认和连续片尾", () => {
    const graph = sceneFixture();
    const question = graph.scenes[1];
    question.track = { resourceId: "v1", durationMs: 20000, cues: [{ id: "ask", kind: "choice", atMs: 4000, timeoutMs: 12000, defaultExit: "keep" }] };
    graph.scenes.push({ ...graph.scenes[2], id: "tail", mode: "next", exits: [{ label: "", target: "c" }] });
    question.exits[1].target = "tail";
    const routes = filmRouteCases(graph);
    expect(routes.length).toBe(5);
    expect(new Set(routes.map((r) => r.key)).size).toBe(5);
    const timeout = routes.find((r) => r.key === filmDecisionKey("b", "磁带", 1, true));
    expect(timeout?.ending).toBe("c");
    expect(timeout?.history.at(-1)?.time).toBe(2000);
    expect(timeout?.history[0].decision).toBe("拿起");
    expect(routes.some((r) => r.key === filmDecisionKey("b", "磁带", 0, false))).toBe(false);
});
test("连续剧本可独立试玩，互不连通的结局不计入可达数", () => {
    const graph = sceneFixture();
    graph.scenes[0].mode = "next";
    graph.scenes[0].exits = [{ label: "", target: "c" }];
    graph.scenes.push({ ...graph.scenes[2], id: "unreachable" });
    expect(filmRouteCases(graph).map((r) => r.ending)).toEqual(["c"]);
});

const graph = {
    start: "a",
    scenes: [
        {
            id: "a",
            title: "入口",
            script: "进站。",
            mode: "choice",
            exits: [
                { label: "问话", target: "b" },
                { label: "看信", target: "c" },
            ],
        },
        { id: "b", title: "问话", script: "站长指路。", mode: "next", exits: [{ label: "", target: "c" }] },
        { id: "c", title: "站台", script: "列车进站。", mode: "ending", exits: [] },
    ],
};
test("两条路径可达同一结局，支持模型代码围栏", () => {
    const parsed = parseFilmGraph("\x60\x60\x60json\n" + JSON.stringify(graph) + "\n\x60\x60\x60");
    expect(filmGraphIssue(parsed)).toBe("");
    expect(parsed.scenes[0].exits.map((e) => e.target)).toEqual(["b", "c"]);
    parsed.scenes[1].exits[0].target = "a";
    expect(filmGraphIssue(parsed)).toContain("回环");
    parsed.scenes[1].exits[0].target = "gone";
    expect(filmGraphIssue(parsed)).toContain("有效目标");
});
test("生成输出损坏时保留错误信息", () => {
    expect(() => parseFilmGraph("不是 JSON")).toThrow("JSON");
    expect(() => parseFilmGraph(JSON.stringify({ ...graph, scenes: [...graph.scenes, graph.scenes[0]] }))).toThrow("编号");
});

test("中断后只恢复完整场次，续写接回原入口且不会覆盖已经编辑的剧本", () => {
    const original = parseFilmGraph(JSON.stringify(graph));
    original.scenes[0].script = '车票上写着「{\\"下一站\\"}」。';
    const json = JSON.stringify(original);
    const partial = recoverFilmGraph("\x60\x60\x60json\n" + json.slice(0, json.indexOf('"id":"c"') + 7));
    expect(partial?.scenes).toEqual(original.scenes.slice(0, 2));
    expect(missingFilmScenes(partial!)).toEqual(["c"]);
    expect(recoverFilmGraph(json.slice(0, json.indexOf('"exits"')))).toBeUndefined();
    expect(() => appendFilmScenes(partial!, original)).toThrow("已有场次");
    const complete = appendFilmScenes(partial!, { start: "c", scenes: original.scenes.slice(2) });
    expect(complete).toEqual(original);
    expect(filmGraphIssue(complete)).toBe("");
});
