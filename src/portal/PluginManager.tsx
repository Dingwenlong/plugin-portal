import { useState } from "react";

import type {
  ExtensionTool,
  FileSelectionMode,
  PluginDirectorySelection,
  PluginImportCandidate,
  PluginImportConfig,
  PluginImportSource,
  PluginMutationReceipt,
  PluginSnapshot,
  PluginUploadReceipt,
} from "./types";

export interface PluginManagementClient {
  selectPluginDirectory(): Promise<PluginDirectorySelection>;
  uploadPluginArchive?(file: File): Promise<PluginUploadReceipt>;
  previewImport(config: PluginImportConfig): Promise<PluginImportCandidate>;
  promote(pluginKey: string, candidateId: string, revision: number): Promise<PluginMutationReceipt>;
  rollback(pluginKey: string, revision: number): Promise<PluginMutationReceipt>;
}

export function PluginManager({
  catalogRevision,
  client,
  currentSnapshot,
  fileSelectionMode = "server-picker",
  onChanged,
}: {
  catalogRevision: number;
  client: PluginManagementClient;
  currentSnapshot?: PluginSnapshot;
  fileSelectionMode?: FileSelectionMode;
  onChanged: (pluginId: string) => Promise<void>;
}) {
  const [pluginRoot, setPluginRoot] = useState("");
  const [source, setSource] = useState<PluginImportSource>();
  const [sourceLabel, setSourceLabel] = useState("");
  const [target, setTarget] = useState(currentSnapshot?.plugin.target ?? "company-dev");
  const [rulePaths, setRulePaths] = useState("");
  const [toolsJson, setToolsJson] = useState("[]");
  const [candidate, setCandidate] = useState<PluginImportCandidate>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const configFor = (nextSource: PluginImportSource): PluginImportConfig => ({
    source: nextSource,
    target: target.trim(),
    expectedPluginId: currentSnapshot?.plugin.id ?? "",
    approvedRulePaths: rulePaths.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    extensionTools: parseExtensionTools(toolsJson),
  });

  const preview = async (nextSource = source) => {
    if (!nextSource) return;
    try {
      setBusy(true);
      setError("");
      setCandidate(await client.previewImport(configFor(nextSource)));
    } catch (reason) {
      setCandidate(undefined);
      setError(reason instanceof Error ? reason.message : "无法预览插件");
    } finally {
      setBusy(false);
    }
  };

  const selectDirectory = async () => {
    try {
      setBusy(true);
      setError("");
      const selection = await client.selectPluginDirectory();
      if (!selection.selected) return;
      setPluginRoot(selection.path);
      const nextSource = { kind: "server-directory", path: selection.path } as const;
      setSource(nextSource);
      setSourceLabel(selection.path);
      setCandidate(await client.previewImport(configFor(nextSource)));
    } catch (reason) {
      setCandidate(undefined);
      setError(reason instanceof Error ? reason.message : "无法选择插件目录");
    } finally {
      setBusy(false);
    }
  };

  const uploadArchive = async (file: File | undefined) => {
    if (!file) return;
    try {
      setBusy(true);
      setError("");
      setCandidate(undefined);
      if (typeof client.uploadPluginArchive !== "function") throw new Error("浏览器上传不可用");
      const uploaded = await client.uploadPluginArchive(file);
      const nextSource = { kind: "upload", uploadId: uploaded.uploadId } as const;
      setSource(nextSource);
      setSourceLabel(uploaded.fileName);
      setCandidate(await client.previewImport(configFor(nextSource)));
    } catch (reason) {
      setCandidate(undefined);
      setError(reason instanceof Error ? reason.message : "无法上传插件 ZIP");
    } finally {
      setBusy(false);
    }
  };

  const promote = async () => {
    if (!candidate) return;
    try {
      setBusy(true);
      setError("");
      await client.promote(candidate.pluginKey, candidate.candidateId, catalogRevision);
      await onChanged(candidate.snapshot.plugin.id);
      setCandidate(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法纳入插件");
    } finally {
      setBusy(false);
    }
  };

  const rollback = async () => {
    if (!currentSnapshot) return;
    try {
      setBusy(true);
      setError("");
      const pluginKey = `${currentSnapshot.plugin.target}/${currentSnapshot.plugin.id}`;
      await client.rollback(pluginKey, catalogRevision);
      await onChanged(currentSnapshot.plugin.id);
      setCandidate(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法回滚插件");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="plugin-manager" aria-label="插件管理">
      <h2>{currentSnapshot ? "刷新或回滚插件" : "人工纳入插件"}</h2>
      <p>{fileSelectionMode === "browser-upload"
        ? "ZIP 仅上传到暂存区并生成公开预览，不会安装或执行插件代码。"
        : "目录只发送给本机服务用于生成预览，不写入公开快照。"}</p>
      <div className="edit-form">
        {fileSelectionMode === "server-picker" ? <label>插件目录
          <span className="directory-picker-row">
            <input aria-label="插件目录" placeholder="请选择插件目录" readOnly value={pluginRoot} />
            <button disabled={busy} onClick={selectDirectory} type="button">选择插件目录</button>
          </span>
        </label> : null}
        {fileSelectionMode === "browser-upload" ? <label>插件 ZIP
          <input
            accept=".zip,application/zip"
            aria-label="插件 ZIP"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void uploadArchive(file);
            }}
            type="file"
          />
          {sourceLabel ? <span className="selected-file-name">{sourceLabel}</span> : null}
        </label> : null}
        <details className="advanced-import-options">
          <summary>高级公开内容（可选）</summary>
          <label>发布者<input aria-label="发布者" value={target} onChange={(event) => { setTarget(event.currentTarget.value); setCandidate(undefined); }} /></label>
          <label>公开规范相对路径<textarea aria-label="公开规范相对路径" placeholder="每行一条，例如 rules/public.md" value={rulePaths} onChange={(event) => { setRulePaths(event.currentTarget.value); setCandidate(undefined); }} /></label>
          <label>扩展工具 JSON<textarea aria-label="扩展工具 JSON" value={toolsJson} onChange={(event) => { setToolsJson(event.currentTarget.value); setCandidate(undefined); }} /></label>
          <button disabled={busy || !source} onClick={() => preview()} type="button">重新生成预览</button>
        </details>
        <div className="row-actions">
          {currentSnapshot ? <button disabled={busy} onClick={rollback} type="button">回滚上一版</button> : null}
        </div>
      </div>
      {candidate ? (
        <div className="plugin-preview">
          <h3>变更预览</h3>
          <p>{currentSnapshot
            ? `版本 ${currentSnapshot.plugin.version} → ${candidate.snapshot.plugin.version}`
            : `将纳入 ${candidate.snapshot.plugin.name} v${candidate.snapshot.plugin.version}`}</p>
          <p>{candidate.snapshot.plugin.id} · v{candidate.snapshot.plugin.version}</p>
          <p>只读公开内容：Skills、MCP 服务 ID、批准的扩展工具与规范正文。</p>
          <button disabled={busy} onClick={promote} type="button">{currentSnapshot ? "确认刷新" : "确认纳入"}</button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function parseExtensionTools(value: string): ExtensionTool[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("扩展工具 JSON 无效");
  }
  if (!Array.isArray(parsed)) throw new Error("扩展工具 JSON 必须是数组");
  return parsed as ExtensionTool[];
}
