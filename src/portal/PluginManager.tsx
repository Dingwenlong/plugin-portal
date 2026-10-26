import { useEffect, useRef, useState } from "react";
import { useModalGuard } from "./PortalModal";
import { errorMessage, isUncertain, PortalRequestError, sameContent } from "./requestState";
import { ImportRulePicker } from "./ImportRulePicker";

import type {
  FileSelectionMode,
  PluginDirectorySelection,
  PluginImportCandidate,
  PluginImportConfig,
  PluginImportSource,
  PluginMutationReceipt,
  PluginRemovalReceipt,
  PluginSnapshot,
  PluginUploadReceipt,
  PluginDownloadInfo,
  PluginCatalog,
  EngineeringRule,
} from "./types";

export interface PluginManagementClient {
  selectPluginDirectory(): Promise<PluginDirectorySelection>;
  uploadPluginArchive?(file: File): Promise<PluginUploadReceipt>;
  previewImport(config: PluginImportConfig): Promise<PluginImportCandidate>;
  readImportRule?(candidateId: string, path: string): Promise<EngineeringRule>;
  previewImportRules?(candidateId: string, paths: string[]): Promise<PluginImportCandidate>;
  promote(pluginKey: string, candidateId: string, revision: number): Promise<PluginMutationReceipt>;
  rollback(pluginKey: string, revision: number): Promise<PluginMutationReceipt>;
  getSnapshot?(pluginKey: string, signal?: AbortSignal): Promise<PluginSnapshot>;
  getDownloadInfo?(pluginKey: string, signal?: AbortSignal): Promise<PluginDownloadInfo>;
  listPlugins?(signal?: AbortSignal): Promise<PluginCatalog>;
  removePlugin?(pluginKey: string, revision: number): Promise<PluginRemovalReceipt>;
  reorderPlugins?(pluginIds: string[], revision: number): Promise<{ revision: number; pluginIds: string[] }>;
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
  const [rulePaths, setRulePaths] = useState<string[]>([]);
  const [candidate, setCandidate] = useState<PluginImportCandidate>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [completed, setCompleted] = useState<string>();
  const [pending, setPending] = useState(false);
  const [needsPreview, setNeedsPreview] = useState(false);
  const [catalogConflict, setCatalogConflict] = useState(false);
  const [confirmationRevision, setConfirmationRevision] = useState<number>();
  const fileRef = useRef<File | undefined>(undefined);
  const busyRef = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useModalGuard(Boolean(source || candidate || fileRef.current || rulePaths.length) && !completed, busy);
  const rulesChanged = Boolean(candidate) && !sameContent(rulePaths, candidate!.snapshot.engineeringRules.map((rule) => rule.path));
  const acceptPreview = (result: PluginImportCandidate) => {
    setCandidate(result); setRulePaths(result.snapshot.engineeringRules.map((rule) => rule.path)); setNeedsPreview(false);
    setConfirmationRevision(result.importOptions?.catalogRevision); setCatalogConflict(false);
  };
  const begin = (label: string) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true); setPhase(label); setError("");
    return true;
  };
  const finish = () => { busyRef.current = false; if (active.current) { setBusy(false); setPhase(""); } };

  const refreshCompleted = async (pluginId = completed) => {
    if (!pluginId) return;
    setPhase("正在刷新列表…");
    try {
      await onChanged(pluginId);
      if (active.current) { setCandidate(undefined); setError(""); }
    } catch (reason) {
      if (active.current) setError(`已纳入，列表刷新失败：${errorMessage(reason)}`);
    }
  };

  const configFor = (nextSource: PluginImportSource, paths = rulePaths): PluginImportConfig => ({
    source: nextSource,
    target: target.trim(),
    expectedPluginId: currentSnapshot?.plugin.id ?? "",
    approvedRulePaths: paths,
    extensionTools: [],
  });

  const preview = async (nextSource = source) => {
    if (!nextSource || !begin("正在生成预览…")) return;
    try {
      const result = await client.previewImport(configFor(nextSource));
      if (active.current) acceptPreview(result);
    } catch (reason) {
      if (!active.current) return;
      if (reason instanceof PortalRequestError && ["invalid_session", "upload_not_found"].includes(reason.code)) setNeedsPreview(true);
      setCandidate(undefined);
      setError(reason instanceof Error ? reason.message : "无法预览插件");
    } finally {
      finish();
    }
  };

  const selectDirectory = async () => {
    if (!begin("正在选择插件目录…")) return;
    try {
      const selection = await client.selectPluginDirectory();
      if (!selection.selected || !active.current) return;
      setPluginRoot(selection.path);
      const nextSource = { kind: "server-directory", path: selection.path } as const;
      setSource(nextSource);
      setSourceLabel(selection.path);
      setPhase("正在生成预览…");
      const result = await client.previewImport(configFor(nextSource, []));
      if (active.current) acceptPreview(result);
    } catch (reason) {
      if (!active.current) return;
      setCandidate(undefined);
      setError(reason instanceof Error ? reason.message : "无法选择插件目录");
    } finally {
      finish();
    }
  };

  const uploadArchive = async (file: File | undefined) => {
    if (!file || pending || completed || !begin("正在上传 ZIP…")) return;
    fileRef.current = file;
    setSourceLabel(file.name);
    try {
      setCandidate(undefined);
      setSource(undefined);
      if (typeof client.uploadPluginArchive !== "function") throw new Error("浏览器上传不可用");
      const uploaded = await client.uploadPluginArchive(file);
      if (!active.current) return;
      const nextSource = { kind: "upload", uploadId: uploaded.uploadId } as const;
      setSource(nextSource);
      setSourceLabel(uploaded.fileName);
      setPhase("正在生成预览…");
      const result = await client.previewImport(configFor(nextSource, []));
      if (active.current) acceptPreview(result);
    } catch (reason) {
      if (!active.current) return;
      setCandidate(undefined);
      setError(reason instanceof Error ? reason.message : "无法上传插件 ZIP");
    } finally {
      finish();
    }
  };

  const checkResult = async () => {
    if (!candidate) return;
    setPending(true);
    setPhase("正在核对纳入结果…");
    try {
      if (!client.getSnapshot) throw new Error("无法核对活动快照");
      const snapshot = await client.getSnapshot(candidate.pluginKey);
      if (!sameContent(snapshot, candidate.snapshot)) throw new Error("活动快照尚未与本次预览一致");
      if (source?.kind === "upload") {
        const download = await client.getDownloadInfo?.(candidate.pluginKey);
        if (!download?.available || download.version !== snapshot.plugin.version) throw new Error("下载状态尚未确认");
      }
      if (!active.current) return;
      setPending(false); setCompleted(candidate.snapshot.plugin.id);
      await refreshCompleted(candidate.snapshot.plugin.id);
    } catch (reason) {
      if (active.current) setError(`结果待确认：${errorMessage(reason)}。请核对结果，不要重复提交。`);
    }
  };

  const promote = async () => {
    if (!candidate || pending || completed || needsPreview || catalogConflict || rulesChanged || !begin("正在校验并纳入插件…")) return;
    try {
      await client.promote(candidate.pluginKey, candidate.candidateId, confirmationRevision ?? catalogRevision);
      if (!active.current) return;
      setCompleted(candidate.snapshot.plugin.id);
      await refreshCompleted(candidate.snapshot.plugin.id);
    } catch (reason) {
      if (!active.current) return;
      if (isUncertain(reason)) await checkResult();
      else {
        if (reason instanceof PortalRequestError && ["invalid_session", "candidate_not_found", "upload_not_found"].includes(reason.code)) setNeedsPreview(true);
        if (reason instanceof PortalRequestError && reason.code === "revision_conflict") setCatalogConflict(true);
        setError(errorMessage(reason));
      }
    } finally {
      finish();
    }
  };

  const rollback = async () => {
    if (!currentSnapshot || !begin("正在回滚插件…")) return;
    try {
      const pluginKey = `${currentSnapshot.plugin.target}/${currentSnapshot.plugin.id}`;
      await client.rollback(pluginKey, catalogRevision);
      await onChanged(currentSnapshot.plugin.id);
      setCandidate(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法回滚插件");
    } finally {
      finish();
    }
  };

  return (
    <section className="plugin-manager" aria-label="插件管理">
      <h2>{currentSnapshot ? "刷新或回滚插件" : "人工纳入插件"}</h2>
      <p>{fileSelectionMode === "browser-upload"
        ? "ZIP 将先生成公开预览；确认后纳入 Portal 并发布下载，不会安装或执行插件代码。"
        : "目录只发送给本机服务用于生成预览，不写入公开快照。"}</p>
      {phase && <p role="status">{phase}</p>}
      <fieldset className="edit-form" disabled={busy || pending || Boolean(completed)}>
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
          <label>来源市场<input aria-label="来源市场" readOnly={Boolean(candidate?.importOptions?.marketplace)} value={candidate?.importOptions?.marketplace ?? target}
            onChange={(event) => { setTarget(event.currentTarget.value); setCandidate(undefined); }} /></label>
          {candidate?.importOptions?.marketplace && <p>已从发行包识别来源市场。</p>}
          {candidate?.importOptions && <ImportRulePicker key={candidate.pluginKey} candidate={candidate} client={client} paths={rulePaths} onChange={setRulePaths} />}
          {!candidate && <p>选择插件后，可在这里勾选要公开的规范文件并预览正文。</p>}
          {rulesChanged && <button type="button" disabled={busy} onClick={async () => {
            if (!candidate || !begin("正在更新规范预览…")) return;
            try {
              if (!client.previewImportRules) throw new Error("规范文件选择暂不可用，请刷新页面");
              const next = await client.previewImportRules(candidate.candidateId, rulePaths);
              if (active.current) acceptPreview(next);
            } catch (reason) {
              if (active.current) {
                setError(errorMessage(reason));
                if (reason instanceof PortalRequestError && ["invalid_session", "candidate_not_found"].includes(reason.code)) setNeedsPreview(true);
              }
            } finally { finish(); }
          }}>更新规范预览</button>}
          <button disabled={busy || !source} onClick={() => preview()} type="button">重新生成预览</button>
        </details>
        <div className="row-actions">
          {currentSnapshot ? <button disabled={busy} onClick={rollback} type="button">回滚上一版</button> : null}
        </div>
      </fieldset>
      {fileRef.current && !candidate && !busy && !completed && !pending && <button onClick={() => void uploadArchive(fileRef.current)} type="button">重新上传并预览</button>}
      {candidate ? (
        <div className="plugin-preview">
          <h3>变更预览</h3>
          <p>{currentSnapshot
            ? `版本 ${currentSnapshot.plugin.version} → ${candidate.snapshot.plugin.version}`
            : `将纳入 ${candidate.snapshot.plugin.name} v${candidate.snapshot.plugin.version}`}</p>
          <p>{candidate.snapshot.plugin.id} · v{candidate.snapshot.plugin.version}</p>
          <p>来源市场：{candidate.snapshot.plugin.target}</p>
          {candidate.importOptions?.currentVersion && candidate.importOptions.currentVersion !== candidate.snapshot.plugin.version && <p>
            该来源当前为 v{candidate.importOptions.currentVersion}，确认后切换为 v{candidate.snapshot.plugin.version}。
          </p>}
          <p>只读公开内容：Skills、MCP 服务 ID 与 {candidate.snapshot.engineeringRules.length} 份规范正文。</p>
          {rulesChanged && <p role="status">规范选择已改变，请先更新规范预览。</p>}
          {candidate.snapshot.engineeringRules.length > 0 && <ul className="import-selected-rules">{candidate.snapshot.engineeringRules.map((rule) => <li key={rule.path}>{rule.path}</li>)}</ul>}
          {!completed && !pending && !needsPreview && !catalogConflict && <button disabled={busy || rulesChanged} onClick={promote} type="button">{currentSnapshot ? "确认刷新" : "确认纳入"}</button>}
        </div>
      ) : null}
      {completed && <p role="status">已纳入插件。</p>}
      {completed && error && <button disabled={busy} onClick={async () => { if (!begin("正在刷新列表…")) return; try { await refreshCompleted(); } finally { finish(); } }} type="button">刷新列表</button>}
      {pending && <button disabled={busy} onClick={async () => { if (!begin("正在核对纳入结果…")) return; try { await checkResult(); } finally { finish(); } }} type="button">核对纳入结果</button>}
      {catalogConflict && !pending && <><p>插件目录已更新，预览和所选文件仍保留。请先读取最新目录，再确认纳入。</p><button disabled={busy} onClick={async () => {
        if (!begin("正在读取最新目录…")) return;
        try {
          if (!client.listPlugins) throw new Error("无法读取最新目录，请关闭后重试");
          const latest = await client.listPlugins();
          const next = source ? await client.previewImport(configFor(source)) : undefined;
          if (active.current) { if (next) acceptPreview(next); setConfirmationRevision(next?.importOptions?.catalogRevision ?? latest.revision); setCatalogConflict(false); }
        } catch (reason) { if (active.current) setError(errorMessage(reason)); }
        finally { finish(); }
      }} type="button">读取最新目录</button></>}
      {needsPreview && !pending && <><p>上传候选已失效，请重新生成预览并确认。</p><button disabled={busy} onClick={() => fileRef.current ? void uploadArchive(fileRef.current) : void preview()} type="button">重新生成预览并确认</button></>}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
