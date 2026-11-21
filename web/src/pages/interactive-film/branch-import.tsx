import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Select } from "antd";
import { FileUp, GitBranch } from "lucide-react";
import { nanoid } from "nanoid";
import { useBlocker } from "react-router";
import { AppModal } from "@/components/ui/product/app-modal";
import { MAX_NOVEL_FILE_BYTES } from "@/lib/canvas/canvas-document";
import { filmNovelFits } from "@/lib/interactive-film";
import { branchScriptExample, importedGraphIssue, parseBranchScript, replaceBranchTarget, type FilmImportReview } from "@/lib/film-script-import";
import { saveInteractiveFilm, type InteractiveFilm } from "@/services/api/interactive-films";

export function BranchImport({ onSaved }: { onSaved: (film: InteractiveFilm) => void }) {
    const [title, setTitle] = useState(""),
        [text, setText] = useState(""),
        [review, setReview] = useState<FilmImportReview>(),
        [error, setError] = useState(""),
        [busy, setBusy] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null),
        lastSubmission = useRef<{ title: string; text: string; key: string } | null>(null),
        submitting = useRef(false),
        saved = useRef(false);
    const dirty = !!title || !!text;
    const blocker = useBlocker(() => dirty && !saved.current);
    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => {
            if (!saved.current) event.preventDefault();
        };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    const problem = review ? importedGraphIssue(review) : "";
    const targets = review?.graph.scenes.map((scene) => ({ value: scene.id, label: scene.id + " · " + scene.title }));
    function editText(value: string) {
        if (!filmNovelFits(value)) {
            setError("剧本最多 600 万字");
            return;
        }
        setText(value);
        setReview(undefined);
        setError("");
    }
    async function load(file: File) {
        setBusy(true);
        try {
            if (!/\.txt$/i.test(file.name) || file.size > MAX_NOVEL_FILE_BYTES) throw new Error("请选择 40 MB 以内的 UTF-8 TXT 文件");
            const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
            if (!content.trim()) throw new Error("文件为空，请选择包含剧本文字的 TXT 文件");
            if (!filmNovelFits(content)) throw new Error("剧本最多 600 万字");
            editText(content);
            setTitle(
                (current) =>
                    current ||
                    Array.from(file.name.replace(/\.txt$/i, ""))
                        .slice(0, 100)
                        .join(""),
            );
        } catch (e) {
            setError(e instanceof TypeError ? "无法识别编码，请选择 UTF-8 TXT 文件" : e instanceof Error ? e.message : "读取失败");
        } finally {
            setBusy(false);
        }
    }
    function inspect() {
        try {
            setReview(parseBranchScript(text));
            setError("");
        } catch (e) {
            setError(e instanceof Error ? e.message : "剧本格式有误");
        }
    }
    async function confirm() {
        if (!review || problem || submitting.current || !title.trim()) return;
        submitting.current = true;
        setBusy(true);
        setError("");
        try {
            const name = title.trim();
            if (lastSubmission.current?.title !== name || lastSubmission.current.text !== text) {
                lastSubmission.current = { title: name, text, key: nanoid() };
            }
            const film = await saveInteractiveFilm({ title: name, graph: review.graph, novel: text, direction: "", revision: 0, creationKey: lastSubmission.current.key });
            saved.current = true;
            onSaved(film);
        } catch (e) {
            setError(e instanceof Error ? e.message : "导入失败，请重试");
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }
    function mapExit(index: number, exitIndex: number, target: string) {
        if (!review) return;
        const updated = replaceBranchTarget(text, review.exitLines[index][exitIndex], target);
        if (!filmNovelFits(updated)) {
            setError("修正后的剧本超过 600 万字，请返回原文缩短剧本");
            return;
        }
        setReview(parseBranchScript(updated));
        setText(updated);
        setError("");
    }
    return (
        <section className="drama-scriptv-brief film-panel film-import-panel">
            <div className="drama-section-title">
                <h2>
                    <GitBranch size={16} />
                    {review ? "核对剧情图" : "导入已有分支剧本"}
                </h2>
                {review && (
                    <small>
                        {review.graph.scenes.length} 场 · {review.graph.scenes.filter((s) => s.mode === "ending").length} 个结局
                    </small>
                )}
            </div>
            {error && <Alert type="error" showIcon title={error} />}
            {!review ? (
                <>
                    <label>
                        作品名称
                        <Input value={title} disabled={busy} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
                    </label>
                    <label>
                        剧本原文
                        <Input.TextArea rows={12} value={text} disabled={busy} placeholder={branchScriptExample} onChange={(e) => editText(e.target.value)} />
                    </label>
                    <small>每场以 [编号] 场名开头，每个选项独占一行，用 → 指向目标场次。</small>
                    <input
                        hidden
                        type="file"
                        ref={fileInput}
                        accept=".txt,text/plain"
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            if (file) void load(file);
                        }}
                    />
                    <div className="film-actions">
                        <Button icon={<FileUp size={15} />} disabled={busy} onClick={() => fileInput.current?.click()}>
                            上传 TXT
                        </Button>
                        {!text && (
                            <Button disabled={busy} onClick={() => editText(branchScriptExample)}>
                                填入示例
                            </Button>
                        )}
                        <Button type="primary" disabled={busy || !text.trim() || !title.trim()} onClick={inspect}>
                            检查剧本
                        </Button>
                    </div>
                </>
            ) : (
                <>
                    <strong>{title}</strong>
                    {problem && <Alert type="warning" showIcon title={problem} />}
                    {review.graph.scenes.map((scene, i) => (
                        <section className="film-import-scene" key={scene.id}>
                            <strong>
                                {scene.id} · {scene.title}
                            </strong>
                            <p className="film-script">{scene.script}</p>
                            {scene.exits.map((exit, j) => (
                                <label key={j}>
                                    {exit.label}
                                    <Select aria-label={exit.label + "的目标场"} disabled={busy} value={exit.target} onChange={(target) => mapExit(i, j, target)} options={targets} />
                                </label>
                            ))}
                        </section>
                    ))}
                    <div className="film-actions">
                        <Button
                            disabled={busy}
                            onClick={() => {
                                setReview(undefined);
                                setError("");
                            }}
                        >
                            返回原文
                        </Button>
                        <Button type="primary" disabled={!!problem} loading={busy} onClick={() => void confirm()}>
                            确认导入
                        </Button>
                    </div>
                </>
            )}
            <AppModal title="放弃本次导入？" open={blocker.state === "blocked"} okText="放弃并离开" cancelText="继续编辑" okButtonProps={{ disabled: busy }} onCancel={() => blocker.reset?.()} onOk={() => blocker.proceed?.()}>
                离开后将清除当前剧本和已修正的跳转。
            </AppModal>
        </section>
    );
}
