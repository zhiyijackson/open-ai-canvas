import { expect, test } from "bun:test";

import { applyToolMention, canvasNodeMentionToken, normalizeCanvasNodeMentionTokens, parseToolMentionTokens, removeToolMentions } from "../../src/lib/canvas/canvas-resource-references";
import { workbenchPromptReferences, workbenchPromptToolIssue } from "../../src/open-ai-canvas-expand/workbench-prompt-tools";
import type { ToolItem } from "../../src/services/api/tools";

const tool = { id: 17, type: "style", label: "水彩", enabled: true } as ToolItem;

test("image tool validation blocks loading, revoked, wrong-type and unreadable tools without dropping their intent", () => {
    const prompt = applyToolMention("补充正文", tool, "Palette");
    const mentions = parseToolMentionTokens(prompt);
    expect(workbenchPromptToolIssue(mentions, [{ pending: true, failed: false }])).toContain("正在校验");
    expect(workbenchPromptToolIssue(mentions, [{ pending: false, failed: true }])).toContain("无法读取");
    expect(workbenchPromptToolIssue(mentions, [{ pending: false, failed: false, tool: { ...tool, enabled: false } }])).toContain("不可用");
    expect(workbenchPromptToolIssue(mentions, [{ pending: false, failed: false, tool: { ...tool, type: "effect" } }])).toContain("不可用");
    expect(workbenchPromptToolIssue(mentions, [{ pending: false, failed: false, tool }])).toBeUndefined();
    expect(workbenchPromptToolIssue(parseToolMentionTokens(applyToolMention("", { ...tool, type: "motion" })), [])).toContain("不支持");
    expect(mentions[0].toolId).toBe(17);
    expect(prompt).toContain("补充正文");
});

test("original rich editor gets active tool references while original workbench normalizes only local media mentions", () => {
    const media = { id: "local-reference", name: "模特", kind: "image" as const, resourceId: "resource-1", previewUrl: "/api/resources/resource-1/file", uploading: false, progress: 100, role: "reference" as const };
    const prompt = applyToolMention(`参考${canvasNodeMentionToken(media.id)}，保持主体`, tool, "Palette");
    const references = workbenchPromptReferences(prompt, [media]);
    expect(references[0]).toMatchObject({ id: media.id, nodeId: media.id, active: true, kind: "image" });
    expect(references[1]).toMatchObject({ toolId: 17, toolType: "style", label: "水彩", active: true });
    const submitted = normalizeCanvasNodeMentionTokens(prompt, references);
    expect(submitted).toContain("@模特");
    expect(submitted).not.toContain("@[node:");
    expect(parseToolMentionTokens(submitted)).toEqual(parseToolMentionTokens(prompt));
});

test("replacing and clearing image tool tags uses native semantics and preserves prose through draft round trip", () => {
    const original = applyToolMention("正文\n补充要求", tool, "Palette");
    const replaced = applyToolMention(original, { ...tool, id: 18, label: "油画" }, "Palette");
    const restored = JSON.parse(JSON.stringify({ prompt: replaced })).prompt;
    expect(parseToolMentionTokens(restored).map((mention) => mention.toolId)).toEqual([18]);
    expect(workbenchPromptReferences(restored, [])[0]).toMatchObject({ label: "油画", toolId: 18, active: true });
    expect(removeToolMentions(restored, "style")).toBe("正文\n补充要求");
});
