import { useRef, useState } from "react";
import { Alert, Button, Radio } from "antd";
import { Download } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { filmExportMedia } from "@/lib/interactive-film";
import type { InteractiveFilm } from "@/services/api/interactive-films";
import type { DramaEpisodeRow } from "@/services/api/drama";

export function ExportDialog({ film, episodes }: { film: InteractiveFilm; episodes: DramaEpisodeRow[] }) {
    const [open, setOpen] = useState(false),
        [busy, setBusy] = useState(false),
        [status, setStatus] = useState(""),
        [error, setError] = useState("");
    const lock = useRef(false);
    const { issue } = filmExportMedia(film, episodes);
    async function download() {
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        setStatus("正在校验作品");
        setError("");
        try {
            const { exportFilm } = await import("./h5-export");
            const blob = await exportFilm(film, episodes, setStatus);
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = film.title.replace(/[\\/:*?"<>|]/g, "_") + "-H5.zip";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            setStatus("已生成工程。解压后按 README.md 启动，或上传到静态站点。");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "工程导出失败");
            setStatus("");
        } finally {
            lock.current = false;
            setBusy(false);
        }
    }
    return (
        <>
            <Button
                disabled={!!issue}
                icon={<Download size={15} />}
                onClick={() => {
                    setOpen(true);
                    setError("");
                    setStatus("");
                }}
            >
                导出工程
            </Button>
            {issue && <small role="status">{issue}</small>}
            <AppModal
                title="导出工程"
                open={open}
                onCancel={() => {
                    if (!busy) setOpen(false);
                }}
                closable={!busy}
                maskClosable={!busy}
                footer={
                    <Button type="primary" disabled={!!issue} loading={busy} onClick={() => void download()}>
                        下载 H5 工程
                    </Button>
                }
            >
                <Radio.Group value="h5" aria-label="工程格式">
                    <Radio value="h5">H5 网页工程</Radio>
                    <Radio disabled>iOS 工程（规划中）</Radio>
                    <Radio disabled>Android 工程（规划中）</Radio>
                </Radio.Group>
                <p>包含播放器、可编辑的剧情数据、随包素材和本地启动说明。</p>
                {status && <p role="status">{status}</p>}
                {error && <Alert type="error" title={error} />}
            </AppModal>
        </>
    );
}
