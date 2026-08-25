import { useEffect, useMemo, useState } from "react";

import { PortalClient } from "./api";
import { PluginManager, type PluginManagementClient } from "./PluginManager";
import { parsePortalRoute, portalHref, type PortalPage } from "./routes";
import type {
  PluginCatalog,
  PluginImportCandidate,
  PluginImportConfig,
  PluginMutationReceipt,
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

export interface PortalDataClient extends PluginManagementClient {
  listPlugins(): Promise<PluginCatalog>;
  getSnapshot(pluginKey: string): Promise<PluginSnapshot>;
  getPrompts(pluginKey: string): Promise<PromptDocument>;
  savePrompts(pluginKey: string, revision: number, items: PromptItem[]): Promise<PromptDocument>;
  getWorkflows(pluginKey: string): Promise<WorkflowDocument>;
  saveWorkflows(pluginKey: string, revision: number, workflow: WorkflowValue): Promise<WorkflowDocument>;
  previewImport(config: PluginImportConfig): Promise<PluginImportCandidate>;
  promote(pluginKey: string, candidateId: string, revision: number): Promise<PluginMutationReceipt>;
  rollback(pluginKey: string, revision: number): Promise<PluginMutationReceipt>;
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

const LAST_PLUGIN_KEY = "plugin-portal.last-plugin";

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
  const [managingPlugins, setManagingPlugins] = useState(false);

  const pluginIds = useMemo(() => catalog.items.map((plugin) => plugin.id), [catalog.items]);
  const route = parsePortalRoute(initialHash ?? browserHash, pluginIds);
  const page = route.page;

  useEffect(() => {
    let active = true;
    resolvedClient.listPlugins().then((nextCatalog) => {
      if (!active) return;
      setCatalog(nextCatalog);
      const sourceHash = initialHash ?? window.location.hash;
      const nextRoute = parsePortalRoute(sourceHash, nextCatalog.items.map((item) => item.id));
      const remembered = initialHash === undefined && !sourceHash ? readRememberedPlugin() : undefined;
      const nextPluginId = remembered && nextCatalog.items.some((item) => item.id === remembered)
        ? remembered
        : nextRoute.pluginId;
      setSelectedPluginId(nextPluginId);
      if (initialHash === undefined && nextPluginId && !sourceHash) {
        const nextHash = portalHref(nextPluginId, nextRoute.page);
        setBrowserHash(nextHash);
        window.location.hash = nextHash;
      }
      setLoading(false);
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : "无法读取插件目录");
      setLoading(false);
    });
    return () => { active = false; };
  }, [resolvedClient, initialHash]);

  useEffect(() => {
    if (initialHash !== undefined) return;
    if (route.pluginId && route.pluginId !== selectedPluginId) {
      setSelectedPluginId(route.pluginId);
    }
  }, [initialHash, route.pluginId, selectedPluginId]);

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
  const reloadCatalog = async (pluginId: string) => {
    const nextCatalog = await resolvedClient.listPlugins();
    setCatalog(nextCatalog);
    setSelectedPluginId(pluginId);
    rememberPlugin(pluginId);
    if (initialHash === undefined) {
      const nextHash = portalHref(pluginId, page);
      setBrowserHash(nextHash);
      window.location.hash = nextHash;
    }
    const changed = nextCatalog.items.find((item) => item.id === pluginId);
    if (changed) {
      setData((current) => {
        const next = { ...current };
        delete next[changed.pluginKey];
        return next;
      });
    }
  };

  if (!selectedPlugin) return (
    <main className="portal-empty-root">
      <h1>Plugin Portal</h1>
      <p>尚未人工纳入插件</p>
      <PluginManager catalogRevision={catalog.revision} client={resolvedClient} onChanged={reloadCatalog} />
    </main>
  );

  const loaded = data[selectedPlugin.pluginKey];
  return (
    <div className="portal-layout">
      <aside className="portal-sidebar">
        <a className="portal-brand" href={portalHref(selectedPlugin.id, "overview")}>Plugin Portal</a>
        <label className="plugin-selector">
          <span>当前插件</span>
          <select aria-label="当前插件" value={selectedPlugin.id} onChange={(event) => {
            const pluginId = event.currentTarget.value;
            rememberPlugin(pluginId);
            if (initialHash === undefined) {
              const nextHash = portalHref(pluginId, page);
              setBrowserHash(nextHash);
              window.location.hash = nextHash;
            } else {
              setSelectedPluginId(pluginId);
            }
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
        <header className="portal-header">
          <h1>{selectedPlugin.name}</h1>
          <div className="header-actions"><span className="plugin-identity">{selectedPlugin.id}</span><button onClick={() => setManagingPlugins((value) => !value)} type="button">管理插件</button></div>
        </header>
        <section className="portal-content" aria-busy={!loaded}>
          {managingPlugins ? <PluginManager catalogRevision={catalog.revision} client={resolvedClient} currentSnapshot={loaded?.snapshot} onChanged={reloadCatalog} /> : !loaded ? <p>正在读取公开资料…</p> : renderPage({
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

function readRememberedPlugin(): string | undefined {
  try {
    return window.localStorage.getItem(LAST_PLUGIN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberPlugin(pluginId: string): void {
  try {
    window.localStorage.setItem(LAST_PLUGIN_KEY, pluginId);
  } catch {
    // URL remains the canonical, refresh-safe selection when storage is unavailable.
  }
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
