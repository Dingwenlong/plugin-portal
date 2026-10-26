import { useEffect, useRef, useState } from "react";
import type { PluginManagementClient } from "./PluginManager";
import type { EngineeringRule, PluginImportCandidate } from "./types";
import { errorMessage } from "./requestState";
import "./importRulePicker.css";

export function ImportRulePicker({ candidate, client, paths, onChange }: {
  candidate: PluginImportCandidate;
  client: PluginManagementClient;
  paths: string[];
  onChange: (paths: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(40);
  const [viewed, setViewed] = useState<string>();
  const [document, setDocument] = useState<EngineeringRule>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const opener = useRef<HTMLButtonElement | null>(null);
  const choices = candidate.importOptions?.rules ?? [];
  const filtered = choices.filter((rule) => `${rule.title} ${rule.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(() => {
    let active = true;
    setDocument(undefined); setError(""); setLoading(Boolean(viewed));
    if (viewed) {
      const read = async () => {
        try {
          if (!client.readImportRule) throw new Error("规范正文预览暂不可用，请刷新页面");
          const result = await client.readImportRule(candidate.candidateId, viewed);
          if (active) setDocument(result);
        } catch (reason) {
          if (active) setError(errorMessage(reason));
        } finally { if (active) setLoading(false); }
      };
      void read();
    }
    return () => { active = false; };
  }, [candidate.candidateId, client, viewed]);

  return <section className="import-rule-picker" aria-label="公开规范文件选择">
    <h3>公开工程规范（可选）</h3>
    <p>从插件内的 Markdown 文档中选择。只有勾选、更新预览并确认纳入的正文会公开。</p>
    {choices.length === 0 ? <p>插件内没有可选择的 Markdown 文档。</p> : <>
      <input aria-label="搜索规范文件" placeholder="搜索文件名或标题" value={query}
        onChange={(event) => { setQuery(event.currentTarget.value); setLimit(40); }} />
      <p className="import-rule-count">{filtered.length} 份文档 · 已选 {paths.length} 份</p>
      <div className="import-rule-list">
        {filtered.slice(0, limit).map((rule) => <div className="import-rule-choice" key={rule.path}>
          <label className="import-rule-label">
            <input type="checkbox" aria-label={`公开 ${rule.path}`} checked={paths.includes(rule.path)} disabled={!rule.available}
              onChange={(event) => onChange(event.currentTarget.checked ? [...paths, rule.path] : paths.filter((path) => path !== rule.path))} />
            <span><strong>{rule.title}</strong><small>{rule.path}</small>{rule.reason && <small>{rule.reason}</small>}</span>
          </label>
          {rule.available && <button type="button" aria-label={`预览 ${rule.path}`} aria-expanded={viewed === rule.path}
            onClick={(event) => { opener.current = event.currentTarget; setViewed(rule.path); }}>预览</button>}
        </div>)}
        {filtered.length === 0 && <p>没有匹配的文档。</p>}
        {filtered.length > limit && <button type="button" onClick={() => setLimit(limit + 40)}>显示更多文件</button>}
      </div>
      {candidate.importOptions?.rulesTruncated && <p>扫描数量已达上限，本次列出 {choices.length} 份文档。</p>}
    </>}
    {viewed && <section className="import-rule-body" aria-label="规范正文预览">
      <div><h4>{viewed}</h4><button type="button" aria-label="关闭正文预览" onClick={() => {
        setViewed(undefined); opener.current?.focus();
      }}>关闭</button></div>
      {loading && <p role="status">正在读取正文…</p>}
      {error && <p role="alert">{error}</p>}
      {document && <pre>{document.bodyMarkdown}</pre>}
    </section>}
  </section>;
}
