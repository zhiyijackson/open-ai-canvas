import { describe, expect, test } from "bun:test";

import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import {
    assignWorkbenchReferenceRole,
    expandWorkbenchEnabled,
    historicalImageParameterIssue,
    historicalVideoParameterIssue,
    serializedWorkbenchImageParameters,
    workbenchFrameRoleConflict,
    type ExpandWorkbenchReference,
} from "../../src/open-ai-canvas-expand/workbench-support";

describe("expand workbench gate", () => {
    test("falls back only when the build flag explicitly disables the extension", () => {
        expect(expandWorkbenchEnabled("false")).toBe(false);
        expect(expandWorkbenchEnabled("true")).toBe(true);
        expect(expandWorkbenchEnabled()).toBe(true);
    });
});

describe("workbench restore and video reference validation", () => {
    const reference = (id: string, role: ExpandWorkbenchReference["role"]): ExpandWorkbenchReference => ({ id, role, name: id, kind: "image", previewUrl: "blob:test", progress: 100, uploading: false });

    test("keeps compatible historical image settings and blocks unsupported custom parameters", () => {
        const profile = defaultModelCapabilityConfig("openai-image", "gpt-image-1").image!;
        expect(historicalImageParameterIssue(profile, { size: profile.size.default, quality: profile.quality.default, imageResolution: "auto", count: 1 })).toBeUndefined();
        expect(historicalImageParameterIssue(profile, { size: profile.size.default, quality: profile.quality.default, imageResolution: "2k", count: 1 })).toBe("图片分辨率与当前模型不兼容，请重新选择参数");
        expect(historicalImageParameterIssue(profile, { size: profile.size.default, imageParameters: { unsupported: true } })).toContain("不兼容");
        expect(historicalImageParameterIssue(profile, { size: profile.size.default, count: profile.maxOutputs + 1 })).toBe("生成张数与当前模型不兼容，请重新选择参数");
    });

    test("clears current custom image parameters when a historical snapshot has none", () => {
        expect(serializedWorkbenchImageParameters({})).toBe("");
        expect(serializedWorkbenchImageParameters({ imageParameters: { style: "natural" } })).toBe('{"style":"natural"}');
    });

    test("detects video settings that become invalid after a model change", () => {
        const profile = defaultModelCapabilityConfig("openai-video", "video-model").video!;
        expect(historicalVideoParameterIssue(profile, { seconds: profile.duration.default, ratio: profile.defaultRatio, resolution: profile.defaultResolution })).toBeUndefined();
        expect(historicalVideoParameterIssue(profile, { seconds: 999, ratio: profile.defaultRatio, resolution: profile.defaultResolution })).toBe("视频时长与当前模型不兼容，请重新选择参数");
    });

    test("selecting a frame role explicitly replaces the previous frame instead of silently submitting two", () => {
        const assigned = assignWorkbenchReferenceRole([reference("first", "first_frame"), reference("second", "reference")], "second", "first_frame");
        expect(assigned.map((item) => item.role)).toEqual(["reference", "first_frame"]);
        expect(workbenchFrameRoleConflict(assigned)).toBeUndefined();
        expect(workbenchFrameRoleConflict([reference("a", "last_frame"), reference("b", "last_frame")])).toBe("尾帧最多只能选择一张图片");
    });
});
