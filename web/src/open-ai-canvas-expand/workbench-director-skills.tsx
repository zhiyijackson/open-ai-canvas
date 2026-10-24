import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Select, Space, Tag } from "antd";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import { CanvasAgentSkillLibraryModal } from "@/components/canvas/canvas-agent-skill-library-modal";
import { curationQuery, useSkillCuration } from "@/components/skills/skill-curation-browser";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { getActiveUserScope } from "@/lib/user-scope";
import { addSkill, listSkillLibraryCategories, listSkills, type Skill } from "@/services/api/skills";
import type { useWorkbenchDirector } from "./use-workbench-director";
import { workbenchSessionEpoch } from "./workbench-session";
import "@/components/canvas/canvas-cloud-agent.css";

type Props = { director: ReturnType<typeof useWorkbenchDirector>; theme: CanvasTheme; userId: string; onSelectionChange(change: () => void): void };

/** Thin first-step adapter around the host's skill library and installation API. */
export function WorkbenchDirectorSkills({ director, theme, userId, onSelectionChange }: Props) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [category, setCategory] = useState("all");
    const [search, setSearch] = useState("");
    const [platformCategory, setPlatformCategory] = useState("");
    const open = director.skillPickerOpen;
    const curationState = useSkillCuration(open);
    const addedKey = ["workbench-director-added-skills", userId];
    const latestDirector = useRef(director);
    latestDirector.current = director;
    const lifecycleRef = useRef(0);
    useEffect(() => {
        lifecycleRef.current += 1;
        return () => { lifecycleRef.current += 1; };
    }, []);
    const library = useQuery({ queryKey: ["workbench-director-skill-categories", userId], queryFn: () => listSkillLibraryCategories("mine"), enabled: open });
    const market = useInfiniteQuery({
        queryKey: ["workbench-director-skill-library", userId, search, category, platformCategory, curationState.curation?.revision],
        initialPageParam: 1,
        queryFn: ({ pageParam }) => listSkills({ scope: "public", page: pageParam, pageSize: 20, search: search || undefined, tag: category !== "all" ? category : undefined, ...curationQuery(curationState.curation, platformCategory) }),
        getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.page + 1 : undefined,
        enabled: open,
    });
    const selection = director.selection;
    const selectedIds = selection?.skillIds || [];
    const select = (skillId: string) => {
        const next = selectedIds.includes(skillId) ? selectedIds.filter((id) => id !== skillId) : [...selectedIds, skillId];
        if (next.length > 8) return;
        onSelectionChange(() => director.setSelection({ mode: "custom", skillIds: next }));
    };
    const install = async (skill: Skill) => {
        if (!selectedIds.includes(skill.skillId) && selectedIds.length >= 8) { message.warning("编导最多启用 8 个技能"); return; }
        const scope = getActiveUserScope();
        const epoch = workbenchSessionEpoch(scope);
        const contextId = director.contextId;
        const expectedSelection = director.selection;
        const lifecycle = lifecycleRef.current;
        const isCurrent = () => lifecycle === lifecycleRef.current && scope === getActiveUserScope() && epoch === workbenchSessionEpoch(scope) && latestDirector.current.contextId === contextId && latestDirector.current.selection === expectedSelection;
        try {
            if (!skill.isAdded) await addSkill(skill.skillId);
            if (!isCurrent()) return;
            await queryClient.invalidateQueries({ queryKey: addedKey });
            await queryClient.invalidateQueries({ queryKey: ["workbench-director-skill-library", userId] });
            if (!isCurrent()) return;
            if (!selectedIds.includes(skill.skillId)) onSelectionChange(() => director.setSelection({ mode: "custom", skillIds: [...selectedIds, skill.skillId] }));
            window.dispatchEvent(new Event("canvas-skills-changed"));
        } catch (error) {
            if (isCurrent()) message.error(error instanceof Error ? error.message : "技能加入失败，请重试");
        }
    };
    const installedSkills = director.installedSkills;
    return (
        <section aria-label="编导场景与技能" className="flex flex-col gap-3">
            <Space wrap>
                <Select aria-label="编导技能场景" placeholder="选择编导场景" value={selection?.mode === "scene" ? selection.presetId : undefined}
                    loading={director.presetsLoading} onChange={(id) => { if (id !== selection?.presetId) onSelectionChange(() => director.choosePreset(id)); }}
                    options={director.presets.map((preset) => ({ value: preset.presetId, label: preset.name }))} style={{ minWidth: 180 }} />
                <Button onClick={() => director.setSkillPickerOpen(true)}>技能库</Button>
            </Space>
            {selectedIds.length ? <div className="flex flex-wrap gap-2" aria-label="本轮真实技能">
                {selectedIds.map((id) => {
                    const skill = director.selectedSkills.find((item) => item.skillId === id);
                    return <Tag key={id} style={{ margin: 0, whiteSpace: "normal", overflowWrap: "anywhere", background: "var(--oacx-muted)", color: "var(--oacx-text-muted)", borderColor: "var(--oacx-border)" }}>{skill?.skillName || "正在确认技能"}{!director.skillsLoading && !installedSkills.some((item) => item.skillId === id) ? " · 未加入" : ""}</Tag>;
                })}
            </div> : <p style={{ color: theme.node.muted }}>选择场景或从技能库启用至少一项技能。</p>}
            {!director.skillsLoading && !director.skillsError && director.missingSkills.length > 0 ? <Button loading={director.installingSkills} onClick={() => void director.installMissingSkills()}>加入所需技能</Button> : null}
            {!director.skillsIssue && selectedIds.length > 0 ? <p role="status" style={{ color: theme.node.muted }}>已启用 {selectedIds.length} 项技能，将交给画布 Agent 执行。</p> : null}
            {director.skillsError ? <Alert type="warning" title={director.skillsError} action={<Button onClick={director.retrySkills}>重试</Button>} /> : null}
            {open && (market.isError || library.isError) ? <Alert type="warning" title="技能库部分目录读取失败，已保留当前选择" action={<Button onClick={() => { void director.refreshAddedSkills(); void market.refetch(); void library.refetch(); }}>重试</Button>} /> : null}
            <CanvasAgentSkillLibraryModal open={open} theme={theme} curationState={curationState} platformCategory={platformCategory} onPlatformCategoryChange={setPlatformCategory}
                installedSkills={installedSkills} marketSkills={(market.data?.pages.flatMap((page) => page.skills) || []).map((skill) => ({ ...skill, isAdded: installedSkills.some((item) => item.skillId === skill.skillId) }))}
                selectedSkillIds={selectedIds} categories={market.data?.pages[0]?.categories || []} libraryCategories={library.data?.categories || []}
                category={category} search={search} loading={market.isFetching || director.skillsLoading} hasMore={Boolean(market.hasNextPage)}
                onClose={() => director.setSkillPickerOpen(false)} onCategoryChange={setCategory} onSearch={setSearch} onToggle={select} onInstall={install}
                onLoadMore={async () => { if (!market.isFetching && market.hasNextPage) await market.fetchNextPage(); }} />
        </section>
    );
}
