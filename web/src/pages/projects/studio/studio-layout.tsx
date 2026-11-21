import { useState, type ReactNode } from "react";
import { Clapperboard, Film, ScrollText } from "lucide-react";
import { SegmentedControl } from "@/components/ui/base/segmented-control";

export type StudioTab = "board" | "script" | "final";

export function studioTab(value: string | null): StudioTab {
    return value === "script" || value === "final" ? value : "board";
}

export function StudioTabs({ tab, onChange }: { tab: StudioTab; onChange: (tab: StudioTab) => void }) {
    return (
        <div className="drama-tabs" role="tablist" aria-label="视图">
            {(
                [
                    { value: "script", label: "剧本", Icon: ScrollText },
                    { value: "board", label: "分镜", Icon: Clapperboard },
                    { value: "final", label: "成片", Icon: Film },
                ] as const
            ).map(({ value, label, Icon }) => (
                <button key={value} type="button" role="tab" className="drama-tab" aria-selected={tab === value} onClick={() => onChange(value)}>
                    <Icon className="size-3.5" />
                    {label}
                </button>
            ))}
        </div>
    );
}

export function StudioBody({ label, covered, rail, children }: { label: string; covered?: boolean; rail: (showProduction: () => void) => ReactNode; children: ReactNode }) {
    const [pane, setPane] = useState<"episodes" | "production">("production");
    return (
        <div className={`drama-body is-inspector-hidden ${covered ? "is-covered" : ""}`} data-mobile-pane={pane}>
            <div className="drama-mobile-tabs">
                <SegmentedControl<"episodes" | "production">
                    block
                    size="sm"
                    ariaLabel="切换导航与制作区"
                    value={pane}
                    onChange={setPane}
                    options={[
                        { label, value: "episodes" },
                        { label: "制作", value: "production" },
                    ]}
                />
            </div>
            {rail(() => setPane("production"))}
            {children}
        </div>
    );
}
