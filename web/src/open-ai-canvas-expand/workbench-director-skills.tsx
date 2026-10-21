import { useState } from "react";
import { Alert, App, Button, Select, Space, Tag } from "antd";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import { CanvasAgentSkillLibraryModal } from "@/components/canvas/canvas-agent-skill-library-modal";
import { curationQuery, useSkillCuration } from "@/components/skills/skill-curation-browser";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { getActiveUserScope } from "@/lib/user-scope";
import { addSkill, listAddedSkills, listSkillLibraryCategories, listSkills, type Skill } from "@/services/api/skills";
import type { useWorkbenchDirector } from "./use-workbench-director";
import { workbenchSessionEpoch } from "./workbench-session";
import "@/components/canvas/canvas-cloud-agent.css";

type Props = { director: ReturnType<typeof useWorkbenchDirector>; theme: CanvasTheme; userId: string };

/** Thin first-step adapter around the host's skill library and installation API. */
export function WorkbenchDirectorSkills({ director, theme, userId }: Props) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [category, setCategory] = useState("all");
    const [search, setSearch] = useState("");
    const [platformCategory, setPlatformCategory] = useState("");
    const open = director.skillPickerOpen;
    const curationState = useSkillCuration(open);
    const addedKey = ["workbench-director-added-skills", userId];
    const added = useQuery({ queryKey: addedKey, queryFn: listAddedSkills });
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
        director.setSelection({ mode: "custom", skillIds: next });
    };
    const install = async (skill: Skill) => {
        if (!selectedIds.includes(skill.skillId) && selectedIds.length >= 8) { message.warning("编导最多启用 8 个技能"); return; }
        const scope = getActiveUserScope();
        const epoch = workbenchSessionEpoch(scope);
        try {
            if (!skill.isAdded) await addSkill(skill.skillId);
            if (scope !== getActiveUserScope() || epoch !== workbenchSessionEpoch(scope)) return;
            await queryClient.invalidateQueries({ queryKey: addedKey });
            await queryClient.invalidateQueries({ queryKey: ["workbench-director-skill-library", userId] });
            if (scope !== getActiveUserScope() || epoch !== workbenchSessionEpoch(scope)) return;
            director.setSelection((current) => ({ mode: "custom", skillIds: [...new Set([...(current?.skillIds || []), skill.skillId])].slice(0, 8) }));
            window.dispatchEvent(new Event("canvas-skills-changed"));
        } catch (error) {
            if (scope === getActiveUserScope() && epoch === workbenchSessionEpoch(scope)) message.error(error instanceof Error ? error.message : "技能加入失败，请重试");
        }
    };
    const installedSkills = added.data?.skills.filter((skill) => skill.isAdded) || [];
    return (
        <section aria-label="编导场景与技能" className="flex flex-col gap-3">
            <Space wrap>
                <Select aria-label="编导技能场景" placeholder="选择真实技能场景" value={selection?.mode === "scene" ? selection.presetId : undefined}
                    loading={director.presetsLoading} onChange={(id) => director.choosePreset(id)}
                    options={director.presets.map((preset) => ({ value: preset.presetId, label: preset.name }))} style={{ minWidth: 180 }} />
                <Button onClick={() => director.setSkillPickerOpen(true)}>原技能库</Button>
                <Button aria-pressed={selection?.mode === "general"} onClick={director.selectGeneral}>通用编导</Button>
            </Space>
            {selection?.mode === "general" ? <p style={{ color: theme.node.muted }}>已主动选择通用 Agent，本轮不预选场景技能。</p> : null}
            {selectedIds.length ? <div className="flex flex-wrap gap-2" aria-label="本轮真实技能">
                {selectedIds.map((id) => {
                    const skill = director.selectedSkills.find((item) => item.skillId === id);
                    return <Tag key={id} style={{ margin: 0, whiteSpace: "normal", overflowWrap: "anywhere", background: "var(--oacx-muted)", color: "var(--oacx-text-muted)", borderColor: "var(--oacx-border)" }}>{skill?.skillName || "正在确认技能"} · {id}{!installedSkills.some((item) => item.skillId === id) ? " · 待加入" : ""}</Tag>;
                })}
            </div> : selection?.mode !== "general" ? <p style={{ color: theme.node.muted }}>选择场景或从原技能库启用技能；无技能时需主动选择通用编导。</p> : null}
            {director.skillsError ? <Alert type="warning" title={director.skillsError} action={<Button onClick={director.retrySkills}>重试</Button>} /> : null}
            {added.isError || (open && (market.isError || library.isError)) ? <Alert type="warning" title="技能库部分目录读取失败，已保留当前选择" action={<Button onClick={() => { void added.refetch(); void market.refetch(); void library.refetch(); }}>重试</Button>} /> : null}
            <CanvasAgentSkillLibraryModal open={open} theme={theme} curationState={curationState} platformCategory={platformCategory} onPlatformCategoryChange={setPlatformCategory}
                installedSkills={installedSkills} marketSkills={(market.data?.pages.flatMap((page) => page.skills) || []).map((skill) => ({ ...skill, isAdded: installedSkills.some((item) => item.skillId === skill.skillId) }))}
                selectedSkillIds={selectedIds} categories={market.data?.pages[0]?.categories || []} libraryCategories={library.data?.categories || []}
                category={category} search={search} loading={market.isFetching || added.isPending} hasMore={Boolean(market.hasNextPage)}
                onClose={() => director.setSkillPickerOpen(false)} onCategoryChange={setCategory} onSearch={setSearch} onToggle={select} onInstall={install}
                onLoadMore={async () => { if (!market.isFetching && market.hasNextPage) await market.fetchNextPage(); }} />
        </section>
    );
}
