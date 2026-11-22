import { runBackendGenerationTask } from "@/services/api/generation-task";
import { getFilmAdaptationMethod, type FilmGraph } from "@/services/api/interactive-films";
import { missingFilmScenes } from "@/lib/interactive-film";
import type { AiConfig } from "@/stores/use-config-store";

const brief =
    "你是互动影视编剧。按提供的原著选段顺序，以人物目标、冲突或时空变化为界拆解剧情。逐段写出标题、原文章节依据、出场角色、场景、关键道具、起因、转折和结果。标明观众可介入的决定、不同后果与可能汇合的位置。最后概述玩家视角、结局方向与预计场次数。保留原著的因果和人物动机。";
const script =
    '你是互动影视编剧。根据原著与作者确认的改编方向逐场撰写可拍摄的动作、对白与情境。给每场写原著依据或注明改编新增。设计有后果的选择、多条路线汇合和不同结局，汇合场只使用所有来路共同成立的事实。按提案控制规模。只输出合法 JSON，形状 {"start":"s1","scenes":[{"id":"s1","title":"场名","source":"出处","script":"本场完整剧本","mode":"choice","exits":[{"label":"选项","target":"s2"}]}]}。场次编号为唯一英数字或下划线，标题最多60字。choice 至少两个具名出口，next 恰好一个出口且 label 为空串，ending 的 exits 为空数组。全部场次从入口可达，无回环无断边。';

export async function adaptFilm(stage: "direction" | "graph", novel: string, direction: string, config: AiConfig, model: string, signal: AbortSignal, onTextDelta: (text: string) => void, existing?: FilmGraph) {
    if (!novel.trim() || !model) throw new Error("请提供原著并选择文本模型");
    if (stage === "graph" && !direction.trim()) throw new Error("请先填写或生成改编方向");
    const { method } = await getFilmAdaptationMethod(signal);
    const result = await runBackendGenerationTask({
        mode: "text",
        config: {
            ...config,
            model,
            taskWorkflowProvider: "model",
            systemPrompt: [
                method,
                stage === "direction" ? brief : script,
                stage === "graph" && "先输出 start 后输出 scenes。每场用精炼动作和关键对白推进剧情，优先写完所有路线与结局。",
                stage === "graph" &&
                    '在适合观众亲手完成动作之处，可在两个视频场次之间加入独立事件场次。该场额外写 "media":{"kind":"event"}，script 写给观众的简短提示，每个出口 label 写可点击的动作，可用 feedback 写点击后揭示的信息（最多500字）。单出口事件的 label 也要填写。视频场次仍写可拍摄的分镜素材，不编造任何素材编号。',
                existing && "这次只续写缺失场次及其后续，保持已有场次和出口不变。沿用待补编号，scenes 仅列新增场次，start 填本次首个待补编号。",
            ]
                .filter(Boolean)
                .join("\n\n"),
        },
        prompt: JSON.stringify({ 原著: novel, 改编方向: direction, ...(existing ? { 已有剧情图: existing, 待补编号: missingFilmScenes(existing) } : {}) }),
        metadata: { source: "interactive-film", stage },
        signal,
        onTextDelta,
    });
    if (!result.text?.trim()) throw new Error("模型没有返回正文");
    return result.text.trim();
}
