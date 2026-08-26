import { useRef, useState } from "react";

import { PortalModal } from "../PortalModal";
import type { PluginSnapshot, PromptDocument, PromptItem, WorkflowDocument } from "../types";
import { WorkflowGraph } from "../workflows/WorkflowGraph";

export function SkillsView({ snapshot }: { snapshot: PluginSnapshot }) {
  if (snapshot.skills.length === 0) return <Empty copy="该插件未提供 Skills" />;
  return (
    <ContentTable headings={["名称", "用途"]}>
      {snapshot.skills.map((skill) => (
        <tr key={skill.id}>
          <td><strong>{skill.id}</strong><small>{skill.name === skill.id ? skill.description : skill.name}</small></td>
          <td>{skill.description}</td>
        </tr>
      ))}
    </ContentTable>
  );
}

export function McpView({ snapshot }: { snapshot: PluginSnapshot }) {
  if (snapshot.mcp.length === 0) return <Empty copy="该插件未提供 MCP" />;
  return (
    <section className="content-list">
      <h2>公开服务</h2>
      {snapshot.mcp.map((service) => <article key={service.id}><strong>{service.id}</strong></article>)}
    </section>
  );
}

export function ExtensionsView({ snapshot }: { snapshot: PluginSnapshot }) {
  if (snapshot.extensionTools.length === 0) return <Empty copy="该插件未配置扩展工具" />;
  return (
    <ContentTable headings={["名称", "用途", "了解更多"]}>
      {snapshot.extensionTools.map((tool) => (
        <tr key={tool.id}>
          <td><strong>{tool.name}</strong><small>{tool.id}</small></td>
          <td>{tool.purpose}</td>
          <td><a href={tool.url} rel="noreferrer" target="_blank">打开资料</a></td>
        </tr>
      ))}
    </ContentTable>
  );
}

export function RulesView({ snapshot }: { snapshot: PluginSnapshot }) {
  const [selectedPath, setSelectedPath] = useState(snapshot.engineeringRules[0]?.path ?? "");
  if (snapshot.engineeringRules.length === 0) return <Empty copy="该插件未提供公开工程规范" />;
  const selected = snapshot.engineeringRules.find((item) => item.path === selectedPath) ?? snapshot.engineeringRules[0];
  return (
    <div className="rules-layout">
      <nav aria-label="规范文件">
        {snapshot.engineeringRules.map((rule) => (
          <button key={rule.path} onClick={() => setSelectedPath(rule.path)} type="button">{rule.path}</button>
        ))}
      </nav>
      <article className="markdown-document"><SafeMarkdown markdown={selected.bodyMarkdown} /></article>
    </div>
  );
}

export function ReleasesView({ snapshot }: { snapshot: PluginSnapshot }) {
  return (
    <section className="release-view">
      <h2>当前导入版本</h2>
      <strong>v{snapshot.plugin.version}</strong>
      <p>{snapshot.plugin.summary}</p>
      <small>导入时间：{snapshot.provenance.importedAt}</small>
    </section>
  );
}

export function OverviewView({ workflow }: { workflow: WorkflowDocument }) {
  return <WorkflowGraph document={workflow} />;
}

export function PromptsView({
  document,
  onSave,
}: {
  document: PromptDocument;
  onSave: (revision: number, items: PromptItem[]) => Promise<unknown>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [scenario, setScenario] = useState("");
  const [content, setContent] = useState("");
  const [editingId, setEditingId] = useState<string | undefined>();
  const [error, setError] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);

  const closeForm = () => {
    setShowForm(false);
    setEditingId(undefined);
    setScenario("");
    setContent("");
    triggerRef.current?.focus();
  };

  const save = async () => {
    const id = editingId ?? uniquePromptId(document.items);
    const existing = document.items.find((item) => item.id === editingId);
    const nextItem = {
      id,
      scenario: scenario.trim(),
      content: content.trim(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    const next = editingId
      ? document.items.map((item) => item.id === editingId ? nextItem : item)
      : [...document.items, nextItem];
    try {
      setError("");
      await onSave(document.revision, next);
      closeForm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存 Prompt");
    }
  };

  return (
    <section className="prompts-view">
      {document.items.length === 0 ? <p className="empty-copy">尚未添加 Prompt</p> : (
        <ContentTable headings={["常用场景", "Prompt", "添加时间", "操作"]}>
          {document.items.map((item) => <tr key={item.id}>
            <td>{item.scenario}</td><td>{item.content}</td><td>{formatPromptTime(item.createdAt)}</td>
            <td className="row-actions">
              <button aria-label={`编辑 ${item.scenario}`} onClick={() => {
                setEditingId(item.id); setScenario(item.scenario); setContent(item.content); setShowForm(true);
              }} type="button">编辑</button>
              <button aria-label={`删除 ${item.scenario}`} onClick={async () => {
                try {
                  setError("");
                  await onSave(document.revision, document.items.filter((candidate) => candidate.id !== item.id));
                } catch (reason) {
                  setError(reason instanceof Error ? reason.message : "无法删除 Prompt");
                }
              }} type="button">删除</button>
            </td>
          </tr>)}
        </ContentTable>
      )}
      <button className="portal-page-action" ref={triggerRef} onClick={() => { setEditingId(undefined); setScenario(""); setContent(""); setShowForm(true); }} type="button">新增 Prompt</button>
      {showForm ? (
        <PortalModal onClose={closeForm} title={editingId ? "编辑 Prompt" : "新增 Prompt"}>
          <form className="edit-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <label>常用场景<input aria-label="常用场景" data-autofocus value={scenario} onChange={(event) => setScenario(event.currentTarget.value)} /></label>
            <label>Prompt 内容<textarea aria-label="Prompt 内容" value={content} onChange={(event) => setContent(event.currentTarget.value)} /></label>
            <footer className="modal-actions">
              <button onClick={closeForm} type="button">取消</button>
              <button disabled={!scenario.trim() || !content.trim()} type="submit">保存</button>
            </footer>
          </form>
        </PortalModal>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function ContentTable({ headings, children }: { headings: string[]; children: React.ReactNode }) {
  return <div className="table-frame"><table><thead><tr>{headings.map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

function Empty({ copy }: { copy: string }) {
  return <p className="empty-copy">{copy}</p>;
}

function SafeMarkdown({ markdown }: { markdown: string }) {
  return <>{markdown.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const Heading = `h${heading[1].length}` as keyof React.JSX.IntrinsicElements;
      return <Heading key={index}>{heading[2]}</Heading>;
    }
    return <p key={index}>{line}</p>;
  })}</>;
}

function uniquePromptId(items: PromptItem[]): string {
  let index = items.length + 1;
  while (items.some((item) => item.id === `prompt-${index}`)) index += 1;
  return `prompt-${index}`;
}

function formatPromptTime(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(timestamp);
}
