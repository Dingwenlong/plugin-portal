import { useState } from "react";

import type {
  ExtensionTool,
  PluginImportCandidate,
  PluginImportConfig,
  PluginMutationReceipt,
  PluginSnapshot,
} from "./types";

export interface PluginManagementClient {
  previewImport(config: PluginImportConfig): Promise<PluginImportCandidate>;
  promote(pluginKey: string, candidateId: string, revision: number): Promise<PluginMutationReceipt>;
  rollback(pluginKey: string, revision: number): Promise<PluginMutationReceipt>;
}

export function PluginManager({
  catalogRevision,
  client,
  currentSnapshot,
  onChanged,
}: {
  catalogRevision: number;
  client: PluginManagementClient;
  currentSnapshot?: PluginSnapshot;
  onChanged: (pluginId: string) => Promise<void>;
}) {
  const [pluginRoot, setPluginRoot] = useState("");
  const [target, setTarget] = useState(currentSnapshot?.plugin.target ?? "company-dev");
  const [pluginId, setPluginId] = useState(currentSnapshot?.plugin.id ?? "");
  const [rulePaths, setRulePaths] = useState("");
  const [toolsJson, setToolsJson] = useState("[]");
  const [candidate, setCandidate] = useState<PluginImportCandidate>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const preview = async () => {
    try {
      setBusy(true);
      setError("");
      const extensionTools = parseExtensionTools(toolsJson);
      const config: PluginImportConfig = {
        pluginRoot: pluginRoot.trim(),
        target: target.trim(),
        expectedPluginId: pluginId.trim(),
        approvedRulePaths: rulePaths.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        extensionTools,
      };
      setCandidate(await client.previewImport(config));
    } catch (reason) {
      setCandidate(undefined);
      setError(reason instanceof Error ? reason.message : "无法预览插件");
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
      <p>目录只发送给本机服务用于生成预览，不写入公开快照。</p>
      <div className="edit-form">
        <label>插件目录<input aria-label="插件目录" value={pluginRoot} onChange={(event) => setPluginRoot(event.currentTarget.value)} /></label>
        <label>发布者<input aria-label="发布者" value={target} onChange={(event) => setTarget(event.currentTarget.value)} /></label>
        <label>插件 ID<input aria-label="插件 ID" value={pluginId} onChange={(event) => setPluginId(event.currentTarget.value)} /></label>
        <label>公开规范相对路径<textarea aria-label="公开规范相对路径" placeholder="每行一条，例如 rules/public.md" value={rulePaths} onChange={(event) => setRulePaths(event.currentTarget.value)} /></label>
        <label>扩展工具 JSON<textarea aria-label="扩展工具 JSON" value={toolsJson} onChange={(event) => setToolsJson(event.currentTarget.value)} /></label>
        <div className="row-actions">
          <button disabled={busy || !pluginRoot.trim() || !pluginId.trim()} onClick={preview} type="button">预览插件</button>
          {currentSnapshot ? <button disabled={busy} onClick={rollback} type="button">回滚上一版</button> : null}
        </div>
      </div>
      {candidate ? (
        <div className="plugin-preview">
          <h3>变更预览</h3>
          <p>{currentSnapshot
            ? `版本 ${currentSnapshot.plugin.version} → ${candidate.snapshot.plugin.version}`
            : `将纳入 ${candidate.snapshot.plugin.name} v${candidate.snapshot.plugin.version}`}</p>
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
