import { Download, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentDataClient, ContentKind, ContentPreview, ContentValue } from "../contentTypes";
import type { PluginSnapshot } from "../types";
import { compareVersion } from "../catalogIdentity";
import { ModalCancelButton, PortalModal } from "../PortalModal";
import { SaveFeedback } from "../SaveFeedback";
import { errorMessage, sameContent } from "../requestState";
import { useResource } from "../useResource";
import { useSaveRecovery } from "../useSaveRecovery";
import { McpView, ReleasesView } from "./PortalViews";

const CHANGE_LABELS = { added: "新增", changed: "改进", fixed: "修复", removed: "移除" };

export function ContentDocumentPage({ client, kind, snapshot, readOnly }: {
  client: ContentDataClient; kind: ContentKind; snapshot: PluginSnapshot; readOnly: boolean;
}) {
  const pluginKey = `${snapshot.plugin.target}/${snapshot.plugin.id}`;
  const baseUrl = `/api/plugins/${encodeURIComponent(pluginKey)}/content/${kind}`;
  const load = useCallback((key: string, signal: AbortSignal) => client.getContent(key, kind, signal), [client, kind]);
  const resource = useResource(pluginKey, load);
  const [preview, setPreview] = useState<ContentPreview>();
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const previewLock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const recovery = useSaveRecovery<ContentPreview>(async (attempt) => {
    const current = await client.getContent(pluginKey, kind);
    if (current.revision <= attempt.revision || !sameContent(current.document, attempt.document)) return false;
    resource.update(current);
    return true;
  }, () => { setPreview(undefined); setNotice("页面内容已更新"); });
  const locked = previewing || recovery.busy || recovery.pending;
  const showPreview = async (document: unknown) => {
    const result = await client.previewContent(pluginKey, kind, document);
    if (alive.current) { setPreview(result); recovery.resetError(); }
  };
  const chooseFile = async (file: File) => {
    if (previewLock.current || locked) return;
    previewLock.current = true; setPreviewing(true); setError(""); setNotice("");
    try {
      if (file.size > 1024 * 1024) throw new Error("JSON 文件不能超过 1 MiB");
      let document: unknown;
      try { document = JSON.parse((await file.text()).replace(/^\uFEFF/, "")); }
      catch { throw new Error("JSON 文件格式无效，请检查后重新上传"); }
      if (alive.current) await showPreview(document);
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { previewLock.current = false; if (alive.current) setPreviewing(false); }
  };
  const repreview = async () => {
    if (!preview || previewLock.current || locked) return;
    previewLock.current = true; setPreviewing(true); setError("");
    try { await showPreview(preview.document); }
    catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { previewLock.current = false; if (alive.current) setPreviewing(false); }
  };
  const document = resource.value?.document;
  return <section className="content-document-page" aria-label={kind === "mcp" ? "MCP 功能说明" : "版本记录"}>
    <div className="portal-page-toolbar" aria-label="页面操作">
      <a className="portal-page-action" download href={`${baseUrl}/template`}><Download aria-hidden="true" size={17} />下载模板</a>
      {document && <a className="portal-page-action" download href={`${baseUrl}/export`}>导出当前 JSON</a>}
      {!readOnly && <>
        <button className="portal-page-action" type="button" ref={trigger} disabled={locked || resource.status !== "ready"} onClick={() => input.current?.click()}><Upload aria-hidden="true" size={17} />上传 JSON</button>
        <input hidden ref={input} aria-label="页面 JSON 文件" type="file" accept=".json,application/json" onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void chooseFile(file);
        }} />
      </>}
    </div>
    {!readOnly && <p className="content-document-help">下载模板，让 AI 结合插件填写，再上传 JSON。确认预览后将替换本页内容。</p>}
    {resource.status === "loading" && <p role="status">正在读取页面内容…</p>}
    {resource.status === "error" && <div role="alert"><p>{resource.error}</p><button type="button" onClick={() => void resource.refresh().catch(() => undefined)}>重新读取内容</button></div>}
    {previewing && <p role="status">正在生成预览…</p>}
    {error && !preview && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {document ? <DocumentBody document={document} currentVersion={snapshot.plugin.version} /> : resource.status === "ready" && <>
      {kind === "mcp" ? <><McpView snapshot={snapshot} /><p className="empty-copy">尚未上传工具功能说明。</p></> : <ReleasesView snapshot={snapshot} />}
    </>}
    {preview && <PortalModal title="内容变更预览" wide returnFocusRef={trigger} busy={previewing || recovery.busy} dirty={recovery.pending} onClose={() => { setPreview(undefined); setError(""); }}>
      <div className="content-preview-scroll" role="region" aria-label="内容预览正文" tabIndex={0}>
      <p>确认后整页替换。新增 {preview.diff.added} 项，修改 {preview.diff.changed} 项，移除 {preview.diff.removed} 项。</p>
      {(preview.document.documentType === "mcp" ? preview.document.services : preview.document.releases).length === 0 && <p role="alert">本次上传将清空本页已上传内容，移除 {preview.diff.removed} 项。</p>}
      <details className="content-diff"><summary>查看增删改明细</summary><ul>{preview.diff.items.map(item => <li key={item.label}>{item.type === "changed" ? "修改" : CHANGE_LABELS[item.type]}：{item.label}</li>)}</ul></details>
      <DocumentBody document={preview.document} currentVersion={snapshot.plugin.version} />
      {error && <p role="alert">{error}</p>}
      <SaveFeedback recovery={recovery} draft={recovery.frozen?.document ?? preview.document} />
      </div>
      <footer className="modal-actions">
        <ModalCancelButton />
        {recovery.conflict || (recovery.error && !recovery.pending) ? <button type="button" disabled={locked} onClick={() => void repreview()}>重新预览</button> : null}
        <button type="button" disabled={locked || Boolean(recovery.error)} onClick={() => void recovery.run(preview, async frozen => {
          const result = await client.confirmContent(pluginKey, kind, frozen); resource.update(result);
        })}>确认替换</button>
      </footer>
    </PortalModal>}
  </section>;
}

export function DocumentBody({ document, currentVersion }: { document: ContentValue; currentVersion: string }) {
  if (document.documentType === "mcp") return <div className="content-list">
    <p className="content-version-note">{document.pluginVersion === currentVersion ? `说明对应 v${document.pluginVersion}` : `说明对应 v${document.pluginVersion}，当前插件 v${currentVersion}`}</p>
    {document.services.length === 0 && <p className="empty-copy">尚无 MCP 功能说明。</p>}
    {document.services.map(service => <section className="document-service" key={service.id}>
      <h2>{service.name}</h2>{service.name !== service.id && <small>{service.id}</small>}
      {service.tools.length === 0 && <p className="empty-copy">该服务尚无工具说明。</p>}
      {service.tools.map(tool => <article className="document-tool" key={tool.id}>
        <h3>{tool.name}</h3><code>{tool.id}</code><p>{tool.purpose}</p>
        {tool.scenarios.length > 0 && <ul aria-label={`${tool.name}使用场景`}>{tool.scenarios.map((scenario, index) => <li key={index}>{scenario}</li>)}</ul>}
      </article>)}
    </section>)}
  </div>;
  return <div className="release-history">
    {document.releases.length === 0 && <p className="empty-copy">尚无版本记录。</p>}
    {[...document.releases].sort((a, b) => compareVersion(b.version, a.version)).map(release => <article className="document-release" key={release.version}>
      <div className="document-release-heading"><h2>v{release.version}</h2>{release.releasedAt ? <time dateTime={release.releasedAt}>{release.releasedAt}</time> : <span>发布日期未知</span>}</div>
      <p>{release.summary}</p><ul>{release.changes.map((change, index) => <li key={index}><span className="release-change-type">{CHANGE_LABELS[change.type]}</span>{change.text}</li>)}</ul>
    </article>)}
  </div>;
}
