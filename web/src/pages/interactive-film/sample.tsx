import { useCallback, useMemo, useState } from "react";
import { filmRulesIssue } from "@/lib/film-interactions";
import { Button, Select } from "antd";
import { Link, useSearchParams } from "react-router";
import { WorkspacePage } from "@/components/layout/workspace-page";
import type { FilmGraph, InteractiveFilm } from "@/services/api/interactive-films";
import { FilmPlayer } from "./player";
import { FilmAudit } from "./audit";
import { useUserStore } from "@/stores/use-user-store";
import { InteractionTrack } from "./interaction-track";

const graph: FilmGraph = {
    start: "S01",
    scenes: [
        {
            id: "S01",
            title: "闭馆铃响",
            source: "展厅",
            script: "明早展签就要付印。你想为母亲修过的最后一枚怀表，找回她的署名。",
            mode: "choice",
            exits: [
                { id: "wear", label: "穿上围裙，查验表盖", target: "S02", item: "修复围裙" },
                { id: "record", label: "拿起录音机，听听旧磁带", target: "S03", item: "录音机" },
            ],
            track: {
                resourceId: "sample-S01",
                durationMs: 30000,
                cues: [
                    { id: "ticket", kind: "hotspot", atMs: 6000, endMs: 10000, x: 52, y: 68, label: "翻看票根", collectionName: "旧票根", feedback: "票背写着「陆青 · 五月十七」。" },
                    { id: "carry", kind: "choice", atMs: 16000 },
                ],
            },
        },
        { id: "S02", title: "修复围裙", script: "围裙口袋里还放着那副白手套。", source: "修复室", mode: "next", exits: [{ label: "走向登记台", target: "S04" }] },
        { id: "S03", title: "录音机", script: "磁带盒上，是母亲手写的「试音」。", source: "修复室", mode: "next", exits: [{ label: "走向登记台", target: "S04" }] },
        {
            id: "S04",
            title: "值班问询",
            script: "值班员翻开登记簿。「你想给明天的展柜留下什么？」",
            source: "登记台",
            mode: "choice",
            clue: "ticket",
            response: "你报出票背日期。值班员停在五月十七日那一页：「是陆青，我记得她。」",
            exits: [
                { id: "sign", label: "查验表盖署名", requiresItem: "修复围裙", target: "E01" },
                { id: "voice", label: "播放修复者录音", requiresItem: "录音机", target: "E02" },
                { id: "keep", label: "交由家属暂存", target: "E03" },
            ],
            track: { resourceId: "sample-S04", durationMs: 20000, cues: [{ id: "answer", kind: "choice", atMs: 4000, question: "你想给明天的展柜留下什么？", timeoutMs: 12000, defaultExit: "keep" }] },
        },
        { id: "E01", title: "展签署名", source: "展柜", script: "内盖上有一行针刻的小字。「陆青，修于五月十七。」展签有了名字。", mode: "ending", exits: [] },
        { id: "E02", title: "口述档案", source: "展柜", script: "「修好它的人，最先听见它重新走动。陆青，五月十七日。」", mode: "ending", exits: [] },
        { id: "E03", title: "家属暂存", source: "展柜", script: "你合上木盒，替母亲留住了这个晚上。", mode: "ending", exits: [] },
    ],
};
const files: Record<string, string> = { S01: "opening", S02: "apron", S03: "tape", S04: "desk", E01: "sign", E02: "voice", E03: "locket" };
const media = Object.fromEntries(Object.entries(files).map(([scene, file]) => [scene, "/interactive-film-sample/" + file + ".mp4"]));
const sample: InteractiveFilm = { id: "sample", projectId: "", title: "闭馆之后", novel: "", direction: "", revision: 1, takes: {}, updatedAt: "", graph };

export function FilmSample() {
    const owner = useUserStore((s) => s.user?.id);
    const [params, setParams] = useSearchParams();
    const [film, setFilm] = useState(sample);
    const scene = film.graph.scenes.find((entry) => entry.id === params.get("scene")) || film.graph.scenes[0];
    const sceneId = scene.id;
    const editing = params.get("mode") === "edit";
    const audit = params.has("audit");
    const origin = params.get("origin") || sceneId;
    function openAudit() {
        setParams({ scene: sceneId, ...(editing ? { mode: "edit" } : {}), audit: "1", origin }, { replace: true });
    }
    function editScene(id: string, time = 0) {
        setParams({ scene: id, mode: "edit", at: String(time), ...(params.has("origin") ? { origin } : {}) }, { replace: true });
    }
    const sampleRecords = useMemo(() => new Set<string>(), [owner, film.revision]);
    const recordEnding = useCallback(
        (key: string) => {
            sampleRecords.add(key);
        },
        [sampleRecords],
    );
    const issue = filmRulesIssue(film.graph);
    return (
        <WorkspacePage>
            <div className="drama-root film-sample">
                <header className="film-bar">
                    <div>
                        <Link to="/interactive-films">返回作品库</Link>
                        <h1>闭馆之后</h1>
                    </div>
                    <div className="film-actions">
                        <Button onClick={openAudit}>作品体检</Button>
                        <Button disabled={editing && !!issue} title={editing ? issue : undefined} onClick={() => setParams({ scene: sceneId, ...(editing ? {} : { mode: "edit" }) }, { replace: true })}>
                            {editing ? "试玩样片" : "编辑样片互动轨"}
                        </Button>
                    </div>
                </header>
                {audit && owner ? (
                    <FilmAudit owner={owner} sampleRecords={sampleRecords} film={film} episodes={[]} demoMedia={media} onBack={() => setParams({ scene: origin, ...(editing ? { mode: "edit" } : {}) }, { replace: true })} onLocate={editScene} />
                ) : editing ? (
                    <>
                        <label>
                            样片场次
                            <Select aria-label="样片场次" value={sceneId} options={film.graph.scenes.map((entry) => ({ value: entry.id, label: entry.title }))} onChange={(id) => editScene(id)} />
                        </label>
                        <small>样片编辑仅在本次打开期间保留。</small>
                        <InteractionTrack
                            key={scene.id}
                            film={film}
                            initialTime={Number(params.get("at")) || 0}
                            scene={scene}
                            episodes={[]}
                            resourceId={"sample-" + scene.id}
                            demoMedia={media}
                            save={async (updated) => {
                                const next = { ...film, revision: film.revision + 1, graph: { ...film.graph, scenes: film.graph.scenes.map((entry) => (entry.id === updated.id ? updated : entry)) } };
                                setFilm(next);
                                return next;
                            }}
                        />
                    </>
                ) : (
                    <FilmPlayer graph={film.graph} takes={{}} onEnding={recordEnding} onAudit={openAudit} episodes={[]} start={sceneId} demoMedia={media} onLocate={editScene} />
                )}
            </div>
        </WorkspacePage>
    );
}
