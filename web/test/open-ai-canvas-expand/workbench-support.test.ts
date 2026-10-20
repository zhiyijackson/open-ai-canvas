import { describe, expect, test } from "bun:test";

import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import {
    assignWorkbenchReferenceRole,
    expandWorkbenchEnabled,
    historicalImageParameterIssue,
    historicalVideoParameterIssue,
    normalizedWorkbenchVideoParameters,
    serializedWorkbenchImageParameters,
    workbenchDefaultParameters,
    workbenchImageSubmissionSettings,
    workbenchCompatibilityParameters,
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

    test("serializes advanced image settings into both workbench and original generation requests", () => {
        const submission = workbenchImageSubmissionSettings({
            size: "1:1",
            quality: "high",
            imageResolution: "2k",
            count: "2",
            transparentBackground: "true",
            imageParameters: '{"style":"natural","steps":12}',
        });

        expect(submission.parameters).toEqual({
            size: "1:1",
            quality: "high",
            imageResolution: "2k",
            count: 2,
            transparentBackground: true,
            imageParameters: { style: "natural", steps: 12 },
        });
        expect(submission.config).toMatchObject({
            transparentBackground: "true",
            imageParameters: '{"style":"natural","steps":12}',
        });
    });

    test("detects video settings that become invalid after a model change", () => {
        const profile = defaultModelCapabilityConfig("openai-video", "video-model").video!;
        expect(historicalVideoParameterIssue(profile, { seconds: profile.duration.default, ratio: profile.defaultRatio, resolution: profile.defaultResolution })).toBeUndefined();
        expect(historicalVideoParameterIssue(profile, { seconds: 999, ratio: profile.defaultRatio, resolution: profile.defaultResolution })).toBe("视频时长与当前模型不兼容，请重新选择参数");
    });

    test("blocks enabled video flags after switching to a model that does not support them and repairs them explicitly", () => {
        const unsupported = defaultModelCapabilityConfig("openai-video", "video-model").video!;
        const parameters = {
            seconds: unsupported.duration.default,
            ratio: unsupported.defaultRatio,
            resolution: unsupported.defaultResolution,
            generateAudio: "true",
            watermark: "true",
        };

        expect(historicalVideoParameterIssue(unsupported, parameters)).toBe("生成音频与当前模型不兼容，请重新选择参数");
        expect(historicalVideoParameterIssue(unsupported, { ...parameters, generateAudio: "false" })).toBe("视频水印与当前模型不兼容，请重新选择参数");
        expect(normalizedWorkbenchVideoParameters(unsupported, parameters)).toMatchObject({ generateAudio: "false", watermark: "false" });

        const supported = { ...unsupported, generateAudio: { supported: true, default: false }, watermark: { supported: true, default: false } };
        expect(historicalVideoParameterIssue(supported, parameters)).toBeUndefined();
        expect(normalizedWorkbenchVideoParameters(supported, parameters)).toMatchObject({ generateAudio: "true", watermark: "true" });
    });

    test("preserves all live settings before a model compatibility check", () => {
        expect(workbenchCompatibilityParameters("image", { ratio: "3:2", quality: "high", imageResolution: "2k", count: "2", transparentBackground: "true", imageParameters: '{"style":"natural"}' })).toEqual({
            size: "3:2",
            quality: "high",
            imageResolution: "2k",
            count: "2",
            transparentBackground: "true",
            imageParameters: '{"style":"natural"}',
        });
        expect(workbenchCompatibilityParameters("video", { seconds: "12", ratio: "9:16", videoQuality: "1080", generateAudio: "true", watermark: "false" })).toEqual({
            seconds: "12",
            ratio: "9:16",
            resolution: "1080",
            generateAudio: "true",
            watermark: "false",
        });
    });

    test("resets every advanced setting from the selected model capabilities", () => {
        const image = defaultModelCapabilityConfig("openai-image", "image-model").image!;
        const video = defaultModelCapabilityConfig("openai-video", "video-model").video!;

        expect(workbenchDefaultParameters("image", image)).toMatchObject({
            ratio: image.size.default,
            quality: image.quality.default,
            count: "1",
            transparentBackground: String(image.transparentBackground.default),
            imageParameters: "",
        });
        expect(workbenchDefaultParameters("video", undefined, video)).toEqual({
            seconds: String(video.duration.default),
            ratio: video.defaultRatio,
            videoQuality: video.defaultResolution.replace(/p$/i, ""),
            generateAudio: String(video.generateAudio.default),
            watermark: String(video.watermark.default),
        });
    });

    test("selecting a frame role explicitly replaces the previous frame instead of silently submitting two", () => {
        const assigned = assignWorkbenchReferenceRole([reference("first", "first_frame"), reference("second", "reference")], "second", "first_frame");
        expect(assigned.map((item) => item.role)).toEqual(["reference", "first_frame"]);
        expect(workbenchFrameRoleConflict(assigned)).toBeUndefined();
        expect(workbenchFrameRoleConflict([reference("a", "last_frame"), reference("b", "last_frame")])).toBe("尾帧最多只能选择一张图片");
    });
});
