import { useEffect, useState } from "react";
import { Alert, Button } from "antd";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { filmDraftStorage } from "./draft-storage";
import type { TrackDraft } from "./interaction-track";

export function TrackDraftReview({ scope, draft, reason, retry }: { scope: string; draft: TrackDraft; reason: string; retry: () => Promise<unknown> }) {
    const cache = useQueryClient();
    const [status, setStatus] = useState("正在保留本地草稿…");
    const [retrying, setRetrying] = useState(false);
    useEffect(() => {
        let active = true;
        filmDraftStorage.setItem(scope, draft).then(
            () => {
                if (active) {
                    cache.setQueryData(["film-track-draft", scope], draft);
                    setStatus("本地草稿待同步");
                }
            },
            () => {
                if (active) setStatus("草稿写入失败，请先复制当前编辑内容。");
            },
        );
        return () => {
            active = false;
        };
    }, [cache, scope, draft]);
    return (
        <WorkspacePage>
            <section className="drama-scriptv-brief film-panel">
                <h2>{draft.scene.title} · 互动轨草稿</h2>
                <Alert type="warning" title={reason} />
                <p role="status">{status}</p>
                <ol>
                    {draft.scene.track?.cues.map((cue) => (
                        <li key={cue.id}>
                            {cue.atMs / 1000} 秒 · {cue.question || cue.label || "画面选择"}
                        </li>
                    ))}
                </ol>
                <details>
                    <summary>查看和复制完整草稿</summary>
                    <pre className="film-script">{JSON.stringify(draft.scene, null, 2)}</pre>
                </details>
                <div className="film-actions">
                    <Button
                        loading={retrying}
                        onClick={async () => {
                            setRetrying(true);
                            try {
                                await retry();
                            } finally {
                                setRetrying(false);
                            }
                        }}
                    >
                        重新读取场次
                    </Button>
                    <Link to={`/interactive-films/${draft.base.id}?mode=edit`}>查看剧情图</Link>
                </div>
            </section>
        </WorkspacePage>
    );
}
