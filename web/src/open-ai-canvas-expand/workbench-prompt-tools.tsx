import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { Button, Input, Popover } from "antd";
import { Palette, X } from "lucide-react";
import { useMemo, useState } from "react";

import { CanvasNineGridPicker } from "@/components/canvas/canvas-nine-grid-picker";
import { applyToolMention, buildToolMentionReference, parseToolMentionTokens, removeToolMentions, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { toAbsoluteUrl } from "@/lib/canvas/canvas-tool-presentation";
import { getTool, listTools, type ToolItem } from "@/services/api/tools";
import { resourceStorageKey } from "@/services/api/resources";

import type { WorkbenchReference } from "./workbench-contract";

type Mention = ReturnType<typeof parseToolMentionTokens>[number];
type ToolResolution = { pending: boolean; failed: boolean; tool?: ToolItem };

export function workbenchPromptToolIssue(mentions: Mention[], resolutions: ToolResolution[]) {
    for (const [index, mention] of mentions.entries()) {
        if (mention.type !== "style" && mention.type !== "nine_grid") return `图片创作不支持“${mention.label}”的工具类型，请清除后重选`;
        const resolved = resolutions[index];
        if (!resolved || resolved.pending) return "正在校验提示词工具…";
        if (resolved.failed || !resolved.tool) return `无法读取工具“${mention.label}”，请重试校验或清除该工具`;
        if (!resolved.tool.enabled || resolved.tool.id !== mention.toolId || resolved.tool.type !== mention.type) return `工具“${mention.label}”已不可用，请清除后重选`;
    }
    return undefined;
}

export function workbenchPromptReferences(prompt: string, references: WorkbenchReference[]): CanvasResourceReference[] {
    return [
        ...references.map((reference) => ({
            id: reference.id,
            // This is the same local composer identity normalized by WorkbenchPage,
            // rather than a persisted canvas node created for the workbench.
            nodeId: reference.id,
            kind: reference.kind,
            label: reference.name,
            title: reference.name,
            previewUrl: reference.previewUrl,
            ...(reference.resourceId ? { storageKey: resourceStorageKey(reference.resourceId) } : {}),
            active: true,
        })),
        ...parseToolMentionTokens(prompt).map((mention) => buildToolMentionReference(mention.toolId, mention.label, mention.type, mention.icon)),
    ];
}

export function useWorkbenchPromptTools({ enabled, prompt, userId }: { enabled: boolean; prompt: string; userId: string }) {
    const mentions = useMemo(() => enabled ? parseToolMentionTokens(prompt) : [], [enabled, prompt]);
    const queries = useQueries({ queries: mentions.map((mention) => ({
        queryKey: ["canvas-tools", userId, "workbench-mention", mention.toolId],
        queryFn: ({ signal }: { signal: AbortSignal }) => getTool(mention.toolId, { signal }),
        enabled: userId !== "guest",
        retry: false,
        refetchOnMount: "always" as const,
    })) });
    const issue = workbenchPromptToolIssue(mentions, queries.map((query) => ({ pending: query.isPending || query.isFetching, failed: query.isError, tool: query.data })));
    return { issue, retry: () => Promise.all(queries.map((query) => query.refetch())) };
}

function WorkbenchStylePicker({ prompt, userId, onChange }: { prompt: string; userId: string; onChange(prompt: string): void }) {
    const [open, setOpen] = useState(false);
    const [scope, setScope] = useState<"public" | "custom">("public");
    const [search, setSearch] = useState("");
    const active = parseToolMentionTokens(prompt).find((mention) => mention.type === "style");
    const query = useInfiniteQuery({
        queryKey: ["canvas-tools", userId, "workbench-style", scope, search],
        queryFn: ({ signal, pageParam }) => listTools({ type: "style", scope, search: search.trim() || undefined, page: pageParam, pageSize: 40 }, { signal }),
        initialPageParam: 1,
        getNextPageParam: (page) => page.hasMore ? page.page + 1 : undefined,
        enabled: open && userId !== "guest",
    });
    return (
        <Popover open={open} onOpenChange={setOpen} trigger="click" placement="topLeft" content={
            <div className="w-[min(320px,80vw)] space-y-2" aria-label="选择图片风格">
                <div className="flex gap-2" role="group" aria-label="风格来源">
                    {([{ value: "public", label: "公共" }, { value: "custom", label: "自定义" }] as const).map((item) => <Button key={item.value} size="small" type={scope === item.value ? "primary" : "default"} aria-pressed={scope === item.value} onClick={() => setScope(item.value)}>{item.label}</Button>)}
                </div>
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索风格" aria-label="搜索图片风格" allowClear />
                <div className="max-h-72 space-y-1 overflow-y-auto" role="listbox" aria-label="图片风格工具">
                    {query.isPending ? <p role="status">正在加载风格…</p> : query.isError ? <div role="alert"><p>风格加载失败</p><Button onClick={() => void query.refetch()}>重试</Button></div> : !query.data.pages.some((page) => page.tools.length) ? <p>没有可用风格</p> : query.data.pages.flatMap((page) => page.tools).map((tool) => (
                        <button key={tool.id} type="button" role="option" aria-selected={active?.toolId === tool.id} disabled={!tool.enabled} className="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-surface-hover disabled:opacity-50" onClick={() => { onChange(applyToolMention(prompt, tool, "Palette")); setOpen(false); }}>
                            {tool.cover ? <img src={toAbsoluteUrl(tool.cover)} alt="" className="size-10 rounded object-cover" /> : <Palette className="size-5" />}
                            <span><strong>{tool.label}</strong>{tool.desc ? <small className="block text-muted-foreground">{tool.desc}</small> : null}</span>
                        </button>
                    ))}
                </div>
                {query.hasNextPage ? <Button loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>加载更多</Button> : null}
            </div>
        }><Button size="small" icon={<Palette className="size-3" />}>{active?.label || "风格"}</Button></Popover>
    );
}

export function WorkbenchImagePromptTools({ prompt, userId, onChange }: { prompt: string; userId: string; onChange(prompt: string): void }) {
    const mentions = parseToolMentionTokens(prompt);
    const grid = mentions.find((mention) => mention.type === "nine_grid");
    return (
        <div className="flex flex-wrap items-center gap-2" aria-label="图片提示词工具">
            <WorkbenchStylePicker prompt={prompt} userId={userId} onChange={onChange} />
            <CanvasNineGridPicker icon={grid?.icon} onSelect={(id, label, icon) => onChange(applyToolMention(prompt, { id, label, type: "nine_grid" }, icon))} />
            {mentions.map((mention) => <Button key={`${mention.type}:${mention.toolId}`} size="small" icon={<X className="size-3" />} aria-label={`移除工具 ${mention.label}`} onClick={() => onChange(removeToolMentions(prompt, mention.type))}>{mention.label}</Button>)}
        </div>
    );
}
