import { expect, test } from "bun:test";
import { importedGraphIssue, parseBranchScript, replaceBranchTarget } from "../src/lib/film-script-import";
import { filmExitEditIssue, filmTrackIssue, filmRulesIssue, filmArrivals, filmRoutes, filmConnectionTargets, availableExits, inspectFilmCue, takeFilmExit } from "../src/lib/film-interactions";
import { filmEditorIssues } from "../src/lib/film-editor-issues";
import type { FilmGraph, FilmCue } from "../src/services/api/interactive-films";
import { filmDecisionKey, filmRehearsal, filmRouteCases, sceneRehearsal } from "../src/lib/film-audit";
import { appendFilmScenes, filmGraphIssue, filmTrialIssue, filmNovelFits, insertFilmNode, newFilmMediaNode, missingFilmScenes, parseFilmGraph, recoverFilmGraph } from "../src/lib/interactive-film";

test("汇合后获得同一物件时仍能区分此前空手和已有物件的来路", () => {
    const { graph } = parseBranchScript("[A] 入口\n出发。\n- 拿钥匙 → D\n- 空手 → D\n[D] 门口\n接钥匙。\n- 进入 → E\n[E] 屋内\n抵达。");
    graph.scenes[0].exits[0].item = "钥匙";
    graph.scenes[1].exits[0].item = "钥匙";
    const routes = filmRoutes(graph);
    expect(routes.arrivals("E").map(routes.arrivalLabel).sort()).toEqual(["门口 · 空手 → 钥匙", "门口 · 钥匙"]);
});

test("剧情图检查在场次重名时按节点编号定位剧本和线索错误", () => {
    const { graph } = parseBranchScript("[A] 视频片段\n开门。\n- 继续 → B\n[B] 视频片段\n进屋。");
    const second = graph.scenes[1];
    second.script = "";
    expect(filmEditorIssues(graph, () => "cut")).toEqual([{ scene: second.id, message: "视频片段 缺少标题或剧本" }]);
    second.script = "进屋。";
    second.clue = "removed";
    expect(filmEditorIssues(graph, () => "cut")).toEqual([{ scene: second.id, message: "视频片段 引用了已移除的线索" }]);
});

test("线索回应必须存在一条能取得热点并满足携带条件的来路", () => {
    const { graph } = parseBranchScript("[A] 入口\n出发。\n- 拿钥匙 → B\n- 空手 → C\n[B] 走廊\n拿钥匙。\n- 继续 → M\n[C] 走廊\n看照片。\n- 继续 → M\n[M] 门口\n选门。\n- 开锁 → D\n- 离开 → E\n[D] 屋内\n抵达。\n[E] 屋外\n抵达。");
    const [start, , photo, merge, inside, outside] = graph.scenes;
    start.exits[0].item = merge.exits[0].requiresItem = "钥匙";
    photo.track = { resourceId: "cut", durationMs: 5000, cues: [{ id: "photo", label: "照片", kind: "hotspot", atMs: 1000, endMs: 2000 }] };
    start.clue = photo.clue = inside.clue = outside.clue = "photo";
    expect(filmEditorIssues(graph, () => "cut")).toEqual([
        { scene: start.id, message: "入口 的观众无法在回应前取得线索「照片」" },
        { scene: inside.id, message: "屋内 的观众无法在回应前取得线索「照片」" },
    ]);
    const routes = filmRoutes(graph);
    expect(routes.arrivals(merge.id).map(routes.arrivalLabel)).toEqual(["第 2 场 · 走廊 · 钥匙", "第 3 场 · 走廊 · 空手"]);
});

test("剧情图同时列出缺片、剧本与规则问题，保留各断线出口的位置", () => {
    const { graph } = parseBranchScript("[A] 入口\n门开了。\n- 向左 → B\n- 向右 → B\n[B] 走廊\n灯亮了。");
    const [first, second] = graph.scenes;
    first.media = { kind: "clip" };
    for (const exit of first.exits) exit.target = "";
    second.script = "";
    second.clue = "removed";
    const issues = filmEditorIssues(graph, (scene) => (scene.id === second.id ? "cut" : undefined));
    expect(issues).toHaveLength(6);
    expect(issues).toContainEqual({ scene: first.id, message: "缺少可播放的最新成片" });
    for (const exit of [0, 1]) expect(issues).toContainEqual({ scene: first.id, exit, message: "待连接目标" });
    expect(issues).toContainEqual({ scene: second.id, message: "走廊 缺少标题或剧本" });
    expect(issues).toContainEqual({ scene: second.id, message: "走廊 引用了已移除的线索" });
    expect(issues).toContainEqual({ scene: second.id, message: "从入口无法到达" });
});

test("较长来路补入的可选线索可随相同携带物穿过已访问的汇合场", () => {
    const { graph } = parseBranchScript("[A] 入口\n出发。\n- 近路 → M\n- 绕行 → B\n[B] 走廊\n经过。\n- 走 → C\n[C] 信箱\n读信。\n- 走 → M\n[M] 门口\n推门。\n- 进入 → E\n[E] 室内\n回应。");
    const source = graph.scenes.find((s) => s.id === "C")!;
    source.track = { resourceId: "cut", durationMs: 1000, cues: [{ id: "letter", label: "信", kind: "hotspot", atMs: 0, endMs: 300 }] };
    graph.scenes.at(-1)!.clue = "letter";
    expect(filmTrialIssue(graph)).toBe("");
});

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
test("图上接线排除自身与间接祖先，允许多个出口汇合", () => {
    const graph = sceneFixture();
    expect(filmConnectionTargets(graph, "c")).toEqual([]);
    expect(filmConnectionTargets(graph, "b").map((s) => s.id)).toEqual(["c"]);
    expect(filmConnectionTargets(graph, "a").map((s) => s.id)).toEqual(["b", "c"]);
});
test("空图没有试玩来路，缺片可文字试玩但必须校验规则和发行素材", () => {
    expect(filmRoutes({ start: "", scenes: [] }).arrivals("")).toEqual([]);
    const graph = sceneFixture();
    graph.scenes[0].media = { kind: "clip" };
    expect(filmTrialIssue(graph)).toBe("");
    expect(filmGraphIssue(graph)).toContain("绑定视频");
    graph.scenes[0].exits[0].target = "";
    expect(filmTrialIssue(graph)).toContain("有效目标");
});

test("汇合后续播可以选择更早的前情并继承该路径上的必经线索", () => {
    const node = (id: string, targets: string[]): FilmGraph["scenes"][number] => ({
        id,
        title: id,
        source: "",
        script: id,
        mode: targets.length > 1 ? "choice" : targets.length ? "next" : "ending",
        exits: targets.map((target) => ({ label: target, target })),
    });
    const graph: FilmGraph = { start: "A", scenes: [node("A", ["B", "C"]), node("B", ["D"]), node("C", ["D"]), node("D", ["E"]), node("E", [])] };
    graph.scenes[2].track = { resourceId: "cut", durationMs: 1000, cues: [{ id: "receipt", kind: "hotspot", atMs: 100, endMs: 400, wait: true, label: "收据" }] };
    const routes = filmRoutes(graph),
        parent = routes.arrivals("E")[0].parent;
    const direct = routes.trace(parent);
    expect(direct.path.map((p) => p.id)).toEqual(["A", "B", "D"]);
    const merge = direct.branches[0];
    const alternate = routes.trace(parent, { [merge.key]: merge.options.find((a) => a.from === "C")!.parent });
    const history = sceneRehearsal(graph, alternate.path, "E", "", 0).history;
    expect(history.map((p) => p.id)).toEqual(["A", "C", "D", "E"]);
    expect(history.at(-1)?.state.clues).toEqual(["receipt"]);
    expect(sceneRehearsal(graph, direct.path, "E", "", 0).history.at(-1)?.state.clues).toEqual([]);
});

test("第 64 个选择点可以调整时间，新增第 65 点被拒绝", () => {
    const scene = sceneFixture().scenes[0];
    const captions: FilmCue[] = Array.from({ length: 63 }, (_, i) => ({ id: String(i), kind: "caption", label: "对白", atMs: i * 10, endMs: i * 10 + 5 }));
    const choice: FilmCue = { id: "ask", kind: "choice", atMs: 800 };
    scene.track = { resourceId: "cut", durationMs: 1000, cues: [...captions, choice] };
    expect(filmTrackIssue(scene)).toBe("");
    choice.atMs = 900;
    expect(filmTrackIssue(scene)).toBe("");
    scene.track.cues.splice(63, 0, { ...captions[0], id: "last", atMs: 650, endMs: 660 });
    expect(filmTrackIssue(scene)).toContain("64");
});
test("指定出口保留真实来路和入口初态，缺少携带物时定位到这一行", () => {
    const graph = sceneFixture();
    const routes = filmRoutes(graph);
    expect(routes.arrivals("a")).toEqual([{ from: "", item: "", parent: -1 }]);
    const arrival = routes.arrivals("c").find((a) => a.item === "围裙")!;
    expect(routes.history(arrival.parent).map((p) => [p.id, p.state.item])).toEqual([
        ["a", ""],
        ["b", "围裙"],
    ]);
    delete graph.scenes[0].exits[0].item;
    expect(filmEditorIssues(graph, () => "cut")).toContainEqual({ scene: "b", exit: 0, message: "没有来路能持有「围裙」" });
});
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

test("默认出口断线可应用草稿，补接后按来路和时间重新校验", () => {
    const graph = sceneFixture();
    const scene = graph.scenes[1];
    const choice: FilmCue = { id: "timer", kind: "choice", atMs: 1000, timeoutMs: 500, defaultExit: "keep" };
    scene.track = { resourceId: "cut", durationMs: 2000, cues: [choice] };
    const arrivals = filmArrivals(graph, scene.id);
    const issue = (g = graph) => filmExitEditIssue(g.scenes[1], arrivals, (id) => g.scenes.some((s) => s.id === id));
    scene.exits[1].target = "";
    expect(issue()).toMatchObject({ reason: "detached-default", blocksApply: false, exit: 1 });
    expect(issue(insertFilmNode(graph, scene.id, 1, "inserted", "event"))).toBeUndefined();
    expect(issue(insertFilmNode(graph, scene.id, 0, "other", "event"))?.reason).toBe("detached-default");
    choice.atMs = 2000;
    expect(issue()).toMatchObject({ reason: "track", blocksApply: true });
    choice.atMs = 1000;
    scene.exits[1].target = "missing";
    expect(issue()).toMatchObject({ reason: "invalid-default", blocksApply: true });
    choice.defaultExit = "removed";
    expect(issue()).toMatchObject({ reason: "invalid-default", blocksApply: true });
    choice.defaultExit = "apron";
    expect(issue()).toMatchObject({ reason: "requires-item", blocksApply: true, exit: 0 });
});

test("指定来路试演继承已完成的必经热点，可选线索按场次带入，正在显示的热点留给观众", () => {
    const graph = sceneFixture();
    const hotspot = (id: string, atMs: number, wait = false): FilmCue => ({ id, kind: "hotspot", atMs, endMs: atMs + 500, wait, label: id });
    graph.scenes[0].track = { resourceId: "a", durationMs: 5000, cues: [hotspot("照片", 0, true), hotspot("信封", 600), { id: "pick", kind: "choice", atMs: 1200 }] };
    graph.scenes[1].track = { resourceId: "b", durationMs: 5000, cues: [hotspot("回执", 200, true), hotspot("路牌", 1500)] };
    const routes = filmRoutes(graph);
    const arrival = routes.arrivals("b")[0];
    const path = [...routes.history(arrival.parent), { id: "b", time: 1600, state: { item: arrival.item, clues: [] } }];
    const trial = filmRehearsal(graph, path, ["信封", "路牌"]);
    expect(trial.optional.map((cue) => cue.id)).toEqual(["信封"]);
    expect(trial.history.map((p) => p.state.clues)).toEqual([
        ["照片", "信封"],
        ["照片", "信封", "回执"],
    ]);
    expect(filmRehearsal(graph, path, []).history.at(-1)?.state.clues).toEqual(["照片", "回执"]);
    expect(filmRehearsal(graph, [{ ...path[0], time: 0 }], []).history[0].state.clues).toEqual([]);
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
