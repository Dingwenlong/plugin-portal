import { useEffect, useMemo, useState } from "react";

import { PortalClient } from "./api";
import { parsePortalRoute, portalHref, type PortalPage } from "./routes";
import type {
  PluginCatalog,
  PluginSnapshot,
  PromptDocument,
  PromptItem,
  WorkflowDocument,
  WorkflowValue,
} from "./types";
import {
  ExtensionsView,
  McpView,
  OverviewView,
  PromptsView,
  ReleasesView,
  RulesView,
  SkillsView,
} from "./views/PortalViews";
import { WorkflowEditor } from "./workflows/WorkflowEditor";

export interface PortalDataClient {
  listPlugins(): Promise<PluginCatalog>;
  getSnapshot(pluginKey: string): Promise<PluginSnapshot>;
  getPrompts(pluginKey: string): Promise<PromptDocument>;
  savePrompts(pluginKey: string, revision: number, items: PromptItem[]): Promise<PromptDocument>;
  getWorkflows(pluginKey: string): Promise<WorkflowDocument>;
  saveWorkflows(pluginKey: string, revision: number, workflow: WorkflowValue): Promise<WorkflowDocument>;
}

interface LoadedPluginData {
  snapshot: PluginSnapshot;
  prompts: PromptDocument;
  workflow: WorkflowDocument;
}

const NAVIGATION: ReadonlyArray<{ page: PortalPage; label: string }> = [
  { page: "overview", label: "鸟瞰全景" },
  { page: "skills", label: "Skills" },
  { page: "prompts", label: "Prompts" },
  { page: "mcp", label: "MCP" },
  { page: "extensions", label: "扩展工具" },
  { page: "rules", label: "工程规范" },
  { page: "releases", label: "版本沿革" },
];

export function PortalShell({
  client,
  initialHash,
}: {
  client?: PortalDataClient;
  initialHash?: string;
}) {
  const resolvedClient = useMemo<PortalDataClient>(() => client ?? new PortalClient(), [client]);
  const [browserHash, setBrowserHash] = useState(() => initialHash ?? window.location.hash);
  const [catalog, setCatalog] = useState<PluginCatalog>({ revision: 0, items: [] });
  const [selectedPluginId, setSelectedPluginId] = useState("");
  const [data, setData] = useState<Record<string, LoadedPluginData>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingWorkflow, setEditingWorkflow] = useState(false);

  const pluginIds = useMemo(() => catalog.items.map((plugin) => plugin.id), [catalog.items]);
  const route = parsePortalRoute(initialHash ?? browserHash, pluginIds);
  const page = route.page;

  useEffect(() => {
    let active = true;
    resolvedClient.listPlugins().then((nextCatalog) => {
      if (!active) return;
      setCatalog(nextCatalog);
      const nextRoute = parsePortalRoute(initialHash ?? window.location.hash, nextCatalog.items.map((item) => item.id));
      setSelectedPluginId(nextRoute.pluginId);
      setLoading(false);
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : "无法读取插件目录");
      setLoading(false);
    });
    return () => { active = false; };
  }, [resolvedClient, initialHash]);

  useEffect(() => {
    if (initialHash !== undefined) return undefined;
    const onHashChange = () => setBrowserHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [initialHash]);

  const selectedPlugin = catalog.items.find((plugin) => plugin.id === selectedPluginId);
  const selectedPluginKey = selectedPlugin?.pluginKey;

  useEffect(() => {
    if (!selectedPluginKey || data[selectedPluginKey]) return undefined;
    let active = true;
    setLoading(true);
    Promise.all([
      resolvedClient.getSnapshot(selectedPluginKey),
      resolvedClient.getPrompts(selectedPluginKey),
      resolvedClient.getWorkflows(selectedPluginKey),
    ]).then(([snapshot, prompts, workflow]) => {
      if (!active) return;
      setData((current) => ({ ...current, [selectedPluginKey]: { snapshot, prompts, workflow } }));
      setLoading(false);
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : "无法读取插件公开资料");
      setLoading(false);
    });
    return () => { active = false; };
  }, [resolvedClient, data, selectedPluginKey]);

  if (loading && catalog.items.length === 0) return <main className="portal-empty-root"><h1>Plugin Portal</h1><p>正在读取已纳入插件…</p></main>;
  if (error) return <main className="portal-empty-root"><h1>Plugin Portal</h1><p role="alert">{error}</p></main>;
  if (!selectedPlugin) return <main className="portal-empty-root"><h1>Plugin Portal</h1><p>尚未人工纳入插件</p></main>;

  const loaded = data[selectedPlugin.pluginKey];
  return (
    <div className="portal-layout">
      <aside className="portal-sidebar">
        <a className="portal-brand" href={portalHref(selectedPlugin.id, "overview")}>Plugin Portal</a>
        <label className="plugin-selector">
          <span>当前插件</span>
          <select aria-label="当前插件" value={selectedPlugin.id} onChange={(event) => {
            setSelectedPluginId(event.currentTarget.value);
            setEditingWorkflow(false);
          }}>
            {catalog.items.map((plugin) => <option key={plugin.pluginKey} value={plugin.id}>{plugin.name}</option>)}
          </select>
        </label>
        <nav aria-label="插件内容">
          {NAVIGATION.map((item) => (
            <a aria-current={item.page === page ? "page" : undefined} href={portalHref(selectedPlugin.id, item.page)} key={item.page}>{item.label}</a>
          ))}
        </nav>
      </aside>
      <main className="portal-main">
        <header className="portal-header"><h1>{selectedPlugin.name}</h1><span className="plugin-identity">{selectedPlugin.id}</span></header>
        <section className="portal-content" aria-busy={!loaded}>
          {!loaded ? <p>正在读取公开资料…</p> : renderPage({
            page,
            loaded,
            editingWorkflow,
            onEditWorkflow: () => setEditingWorkflow((value) => !value),
            onSavePrompts: async (revision, items) => {
              const prompts = await resolvedClient.savePrompts(selectedPlugin.pluginKey, revision, items);
              setData((current) => ({ ...current, [selectedPlugin.pluginKey]: { ...current[selectedPlugin.pluginKey], prompts } }));
            },
            onSaveWorkflow: async (revision, workflow) => {
              const saved = await resolvedClient.saveWorkflows(selectedPlugin.pluginKey, revision, workflow);
              setData((current) => ({ ...current, [selectedPlugin.pluginKey]: { ...current[selectedPlugin.pluginKey], workflow: saved } }));
              setEditingWorkflow(false);
            },
          })}
        </section>
      </main>
    </div>
  );
}

function renderPage({
  page,
  loaded,
  editingWorkflow,
  onEditWorkflow,
  onSavePrompts,
  onSaveWorkflow,
}: {
  page: PortalPage;
  loaded: LoadedPluginData;
  editingWorkflow: boolean;
  onEditWorkflow: () => void;
  onSavePrompts: (revision: number, items: PromptItem[]) => Promise<void>;
  onSaveWorkflow: (revision: number, workflow: WorkflowValue) => Promise<void>;
}) {
  switch (page) {
    case "overview":
      return <><div className="view-actions"><button onClick={onEditWorkflow} type="button">{editingWorkflow ? "查看流程" : "配置流程"}</button></div>{editingWorkflow ? <WorkflowEditor document={loaded.workflow} onSave={onSaveWorkflow} /> : <OverviewView workflow={loaded.workflow} />}</>;
    case "skills": return <SkillsView snapshot={loaded.snapshot} />;
    case "prompts": return <PromptsView document={loaded.prompts} onSave={onSavePrompts} />;
    case "mcp": return <McpView snapshot={loaded.snapshot} />;
    case "extensions": return <ExtensionsView snapshot={loaded.snapshot} />;
    case "rules": return <RulesView snapshot={loaded.snapshot} />;
    case "releases": return <ReleasesView snapshot={loaded.snapshot} />;
  }
}
