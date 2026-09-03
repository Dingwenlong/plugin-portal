import { useState } from "react";

import { PortalModal } from "./PortalModal";
import type {
  DownloadCandidateSelection,
  DownloadPublicationReceipt,
  FileSelectionMode,
  PluginListItem,
} from "./types";

export interface DownloadPublicationClient {
  selectDownloadCandidate(pluginKey: string): Promise<DownloadCandidateSelection>;
  uploadDownloadCandidate?(pluginKey: string, file: File): Promise<DownloadCandidateSelection>;
  confirmDownloadPublication(
    pluginKey: string,
    publicationId: string,
  ): Promise<DownloadPublicationReceipt>;
}

export function DownloadPublisherDialog({
  client,
  fileSelectionMode = "server-picker",
  onClose,
  onPublished,
  plugin,
}: {
  client: DownloadPublicationClient;
  fileSelectionMode?: FileSelectionMode;
  onClose: () => void;
  onPublished?: (receipt: DownloadPublicationReceipt) => void | Promise<void>;
  plugin: PluginListItem;
}) {
  const [selection, setSelection] = useState<DownloadCandidateSelection>();
  const [receipt, setReceipt] = useState<DownloadPublicationReceipt>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectCandidate = async () => {
    try {
      setBusy(true);
      setError("");
      setReceipt(undefined);
      setSelection(await client.selectDownloadCandidate(plugin.pluginKey));
    } catch (reason) {
      setSelection(undefined);
      setError(reason instanceof Error ? reason.message : "无法选择候选 ZIP");
    } finally {
      setBusy(false);
    }
  };

  const uploadCandidate = async (file: File | undefined) => {
    if (!file) return;
    try {
      setBusy(true);
      setError("");
      setReceipt(undefined);
      if (typeof client.uploadDownloadCandidate !== "function") throw new Error("浏览器上传不可用");
      setSelection(await client.uploadDownloadCandidate(plugin.pluginKey, file));
    } catch (reason) {
      setSelection(undefined);
      setError(reason instanceof Error ? reason.message : "无法上传候选 ZIP");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!selection?.selected) return;
    try {
      setBusy(true);
      setError("");
      const published = await client.confirmDownloadPublication(plugin.pluginKey, selection.publicationId);
      setReceipt(published);
      await onPublished?.(published);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法发布下载");
    } finally {
      setBusy(false);
    }
  };

  const preview = selection?.selected ? selection.preview : undefined;
  return (
    <PortalModal title={`发布 ${plugin.name} 下载`} onClose={onClose}>
      <div className="download-publication">
        <p>选择由该插件自身发布流程生成的 ZIP。Portal 会先交给 Plugin Release 只读审计，不会生成或修改候选。</p>
        {fileSelectionMode === "browser-upload" && !receipt ? <label className="download-publication-file">
          下载候选 ZIP
          <input
            accept=".zip,application/zip"
            aria-label="下载候选 ZIP"
            data-autofocus={!preview || undefined}
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void uploadCandidate(file);
            }}
            type="file"
          />
          {busy ? <span role="status">正在上传并审计…</span> : null}
        </label> : null}
        {fileSelectionMode === "server-picker" && !preview && !receipt ? (
          <button data-autofocus disabled={busy} onClick={selectCandidate} type="button">
            {busy ? "正在审计…" : "选择候选 ZIP"}
          </button>
        ) : null}
        {preview && !receipt ? (
          <>
            <dl className="download-publication-preview">
              <div><dt>候选文件</dt><dd>{preview.fileName}</dd></div>
              <div><dt>下载文件</dt><dd>{preview.destinationFileName}</dd></div>
              <div><dt>插件版本</dt><dd>{preview.version}</dd></div>
              <div><dt>文件数</dt><dd>{preview.fileCount}</dd></div>
              <div><dt>大小</dt><dd>{formatBytes(preview.archiveBytes)}</dd></div>
              <div><dt>候选摘要</dt><dd><code>{preview.candidateSha256}</code></dd></div>
              <div><dt>文件集摘要</dt><dd><code>{preview.fileSetSha256}</code></dd></div>
              <div><dt>审计工具</dt><dd>Plugin Release v{preview.auditToolVersion}</dd></div>
            </dl>
            {preview.warnings.length > 0 ? (
              <div className="download-publication-warnings">
                <h3>审计警告</h3>
                <ul>{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </div>
            ) : null}
            <div className="modal-actions">
              {fileSelectionMode === "server-picker"
                ? <button disabled={busy} onClick={selectCandidate} type="button">重新选择</button>
                : null}
              <button disabled={busy} onClick={confirm} type="button">
                {busy ? "正在发布…" : "确认发布"}
              </button>
            </div>
          </>
        ) : null}
        {receipt ? (
          <div className="download-publication-success" role="status">
            <strong>发布成功</strong>
            <span>{receipt.fileName}</span>
          </div>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </PortalModal>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
