import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  Blocks,
  BookCopy,
  Download,
  History,
  Menu,
  MessageSquareText,
  Network,
  Package,
  Settings2,
  Workflow as WorkflowIcon,
  X,
  type LucideIcon,
} from "lucide-react";

import { HubEntry, type HubRoute } from "../hub/HubEntry";
import { PortalClient } from "./api";
import { PortalModal } from "./PortalModal";
import { PortalPageAction, PortalPageActionTargetProvider } from "./PortalPageAction";
import type { PluginManagementClient } from "./PluginManager";
import { parsePortalRoute, portalHref, type PortalPage } from "./routes";
import type {
  PluginCatalog,
  PluginImportCandidate,
  PluginImportConfig,
  PluginDownloadInfo,
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
  getAccessMode(): Promise<{ readOnly: boolean }>;
  listPlugins(): Promise<PluginCatalog>;
  getSnapshot(pluginKey: string): Promise<PluginSnapshot>;
  getDownloadInfo(pluginKey: string): Promise<PluginDownloadInfo>;
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
  download: PluginDownloadInfo;
  prompts: PromptDocument;
  workflow: WorkflowDocument;
}

const NAVIGATION: ReadonlyArray<{ page: PortalPage; label: string; icon: LucideIcon }> = [
  { page: "skills", label: "Skills", icon: WorkflowIcon },
  { page: "prompts", label: "Prompts", icon: MessageSquareText },
  { page: "mcp", label: "MCP", icon: Network },
  { page: "extensions", label: "扩展工具", icon: Blocks },
  { page: "rules", label: "工程规范", icon: BookCopy },
  { page: "releases", label: "版本沿革", icon: History },
];

const PAGE_TITLES: Readonly<Record<PortalPage, string>> = {
  overview: "鸟瞰全景",
  skills: "Skills",
  prompts: "Prompts",
  mcp: "MCP",
  extensions: "扩展工具",
  rules: "工程规范",
  releases: "版本沿革",
};

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
  const [readOnly, setReadOnly] = useState(true);
  const [error, setError] = useState("");
  const [editingWorkflow, setEditingWorkflow] = useState(false);
  const [pageActionTarget, setPageActionTarget] = useState<HTMLDivElement | null>(null);
  const [capsuleHidden, setCapsuleHidden] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [portalModalOpen, setPortalModalOpen] = useState(false);
  const capsuleRef = useRef<HTMLElement>(null);
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const lastScrollYRef = useRef(0);
  const downwardTravelRef = useRef(0);
  const upwardTravelRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const keyboardInputRef = useRef(false);
  const workflowTriggerRef = useRef<HTMLButtonElement>(null);

  const pluginIds = useMemo(() => catalog.items.map((plugin) => plugin.id), [catalog.items]);
  const sourceHash = initialHash ?? browserHash;
  const isPluginLocation = /^#\/plugins\//.test(sourceHash);
  const hubRoute: HubRoute | undefined = isPluginLocation
    ? undefined
    : sourceHash === "#/hub" ? "hub" : "cover";
  const route = parsePortalRoute(sourceHash, pluginIds);
  const page = route.page;

  useEffect(() => {
    setCapsuleHidden(false);
    setMobileMenuOpen(false);
    lastScrollYRef.current = window.scrollY;
    downwardTravelRef.current = 0;
    upwardTravelRef.current = 0;
  }, [page, route.pluginId]);

  useEffect(() => {
    const onKeyDown = () => { keyboardInputRef.current = true; };
    const onPointerDown = () => { keyboardInputRef.current = false; };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  useEffect(() => {
    const onScroll = () => {
      if (scrollFrameRef.current !== null) return;
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        const currentY = window.scrollY;
        const previousY = lastScrollYRef.current;
        const delta = currentY - previousY;
        lastScrollYRef.current = currentY;

        const focusedElement = document.activeElement;
        const capsuleHasKeyboardFocus = keyboardInputRef.current
          && capsuleRef.current?.contains(focusedElement);
        if (currentY <= 24 || mobileMenuOpen || portalModalOpen || capsuleHasKeyboardFocus) {
          downwardTravelRef.current = 0;
          upwardTravelRef.current = 0;
          setCapsuleHidden(false);
          return;
        }
        if (delta > 0) {
          upwardTravelRef.current = 0;
          downwardTravelRef.current += delta;
          if (downwardTravelRef.current >= 24) setCapsuleHidden(true);
        } else if (delta < 0) {
          downwardTravelRef.current = 0;
          upwardTravelRef.current += Math.abs(delta);
          if (upwardTravelRef.current >= 24) setCapsuleHidden(false);
        }
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    };
  }, [mobileMenuOpen, portalModalOpen]);

  useEffect(() => {
    if (portalModalOpen) setCapsuleHidden(false);
  }, [portalModalOpen]);

  useEffect(() => {
    if (!mobileMenuOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!capsuleRef.current?.contains(event.target as Node)) setMobileMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileMenuOpen(false);
      mobileMenuTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    let active = true;
    Promise.all([resolvedClient.getAccessMode(), resolvedClient.listPlugins()]).then(([access, nextCatalog]) => {
      if (!active) return;
      setReadOnly(access.readOnly);
      setCatalog(nextCatalog);
      const sourceHash = initialHash ?? window.location.hash;
      const nextRoute = parsePortalRoute(sourceHash, nextCatalog.items.map((item) => item.id));
      const nextPluginId = /^#\/plugins\//.test(sourceHash) ? nextRoute.pluginId : "";
      setSelectedPluginId(nextPluginId);
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
    if (!hubRoute && route.pluginId && route.pluginId !== selectedPluginId) {
      setSelectedPluginId(route.pluginId);
    }
  }, [hubRoute, initialHash, route.pluginId, selectedPluginId]);

  useEffect(() => {
    if (initialHash !== undefined) return undefined;
    const onHashChange = () => setBrowserHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [initialHash]);

  useEffect(() => {
    if (initialHash !== undefined || isPluginLocation || sourceHash === "#/" || sourceHash === "#/hub") return;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/`);
    setBrowserHash("#/");
  }, [initialHash, isPluginLocation, sourceHash]);

  const selectedPlugin = catalog.items.find((plugin) => plugin.id === selectedPluginId);
  const selectedPluginKey = selectedPlugin?.pluginKey;

  useEffect(() => {
    if (!selectedPluginKey) return undefined;
    let active = true;
    setLoading(true);
    Promise.all([
      resolvedClient.getSnapshot(selectedPluginKey),
      resolvedClient.getPrompts(selectedPluginKey),
      resolvedClient.getWorkflows(selectedPluginKey),
    ]).then(([snapshot, prompts, workflow]) => {
      if (!active) return;
      setData((current) => ({
        ...current,
        [selectedPluginKey]: {
          snapshot,
          download: { available: false, version: snapshot.plugin.version, href: null },
          prompts,
          workflow,
        },
      }));
      setLoading(false);
      void resolvedClient.getDownloadInfo(selectedPluginKey).then((download) => {
        if (!active) return;
        setData((current) => current[selectedPluginKey] ? {
          ...current,
          [selectedPluginKey]: { ...current[selectedPluginKey], download },
        } : current);
      }).catch(() => undefined);
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : "无法读取插件公开资料");
      setLoading(false);
    });
    return () => { active = false; };
  }, [resolvedClient, selectedPluginKey]);

  if (error) return <main className="portal-empty-root"><h1>Plugin Portal</h1><p role="alert">{error}</p></main>;
  const refreshHubCatalog = async () => {
    setCatalog(await resolvedClient.listPlugins());
    setData({});
  };

  if (hubRoute) return <HubEntry
    readOnly={readOnly}
    catalog={catalog}
    client={resolvedClient}
    route={hubRoute}
    onCatalogChanged={refreshHubCatalog}
    onNavigate={(next) => {
      if (initialHash !== undefined) return;
      const nextHash = next === "hub" ? "#/hub" : "#/";
      setBrowserHash(nextHash);
      if (window.location.hash !== nextHash) window.location.hash = nextHash;
    }}
  />;

  if (loading && catalog.items.length === 0) return <main className="portal-empty-root"><h1>Plugin Portal</h1><p>正在读取已纳入插件…</p></main>;
  if (!selectedPlugin) return <main className="portal-empty-root"><h1>Plugin Portal</h1><p>该插件未纳入 Portal。</p></main>;

  const loaded = data[selectedPlugin.pluginKey];
  const currentNavigation = NAVIGATION.find((item) => item.page === page) ?? {
    page: "overview" as const,
    label: PAGE_TITLES.overview,
    icon: Package,
  };
  const CurrentPageIcon = currentNavigation.icon;
  return (
    <PortalPageActionTargetProvider onModalStateChange={setPortalModalOpen} target={pageActionTarget}>
      <div className="portal-layout">
        <header
          aria-label="插件导航"
          className="portal-capsule"
          data-visibility={capsuleHidden ? "hidden" : "visible"}
          onFocusCapture={() => setCapsuleHidden(false)}
          ref={capsuleRef}
        >
          <a aria-label={selectedPlugin.name} className="portal-brand" href={portalHref(selectedPlugin.id, "overview")}>
            <PluginBrandIcon pluginKey={selectedPlugin.pluginKey} />
            <span>{selectedPlugin.name}</span>
          </a>
          <div aria-hidden="true" className="portal-capsule-current">
            <CurrentPageIcon size={18} strokeWidth={1.7} />
            <span>{currentNavigation.label}</span>
          </div>
          <nav aria-label="插件内容" data-expanded={mobileMenuOpen ? "true" : "false"} id="portal-capsule-navigation" onClick={() => setMobileMenuOpen(false)}>
            {NAVIGATION.map((item) => (
              <a aria-current={item.page === page ? "page" : undefined} href={portalHref(selectedPlugin.id, item.page)} key={item.page}>
                <item.icon aria-hidden="true" size={18} strokeWidth={1.7} />
                <span>{item.label}</span>
              </a>
            ))}
          </nav>
          <div className="portal-capsule-actions">
            <button
              aria-controls="portal-capsule-navigation"
              aria-expanded={mobileMenuOpen}
              aria-label={mobileMenuOpen ? "关闭导航菜单" : "打开导航菜单"}
              className="portal-capsule-more"
              onClick={() => { setCapsuleHidden(false); setMobileMenuOpen((current) => !current); }}
              ref={mobileMenuTriggerRef}
              title={mobileMenuOpen ? "关闭导航菜单" : "打开导航菜单"}
              type="button"
            >
              {mobileMenuOpen ? <X aria-hidden="true" size={18} /> : <Menu aria-hidden="true" size={18} />}
            </button>
            <div className="portal-page-actions" ref={setPageActionTarget} />
            {loaded ? <DownloadAction info={loaded.download} /> : null}
          </div>
        </header>
        <main aria-label={PAGE_TITLES[page]} className="portal-main">
          <section className="portal-content" aria-busy={!loaded}>
            {!loaded ? <p>正在读取公开资料…</p> : renderPage({
              page,
              readOnly,
              loaded,
              editingWorkflow,
              workflowTriggerRef,
              onOpenWorkflow: () => setEditingWorkflow(true),
              onCloseWorkflow: () => { setEditingWorkflow(false); workflowTriggerRef.current?.focus(); },
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
    </PortalPageActionTargetProvider>
  );
}

function renderPage({
  page,
  readOnly,
  loaded,
  editingWorkflow,
  workflowTriggerRef,
  onOpenWorkflow,
  onCloseWorkflow,
  onSavePrompts,
  onSaveWorkflow,
}: {
  page: PortalPage;
  readOnly: boolean;
  loaded: LoadedPluginData;
  editingWorkflow: boolean;
  workflowTriggerRef: RefObject<HTMLButtonElement | null>;
  onOpenWorkflow: () => void;
  onCloseWorkflow: () => void;
  onSavePrompts: (revision: number, items: PromptItem[]) => Promise<void>;
  onSaveWorkflow: (revision: number, workflow: WorkflowValue) => Promise<void>;
}) {
  switch (page) {
    case "overview":
      return <>
        {!readOnly && <PortalPageAction>
          <button aria-label="配置流程" className="portal-page-action" onClick={onOpenWorkflow} ref={workflowTriggerRef} title="配置流程" type="button">
            <Settings2 aria-hidden="true" size={17} />
            <span className="portal-action-label">配置流程</span>
          </button>
        </PortalPageAction>}
        <OverviewView workflow={loaded.workflow} />
        {!readOnly && editingWorkflow ? <PortalModal onClose={onCloseWorkflow} title="配置流程" wide><WorkflowEditor document={loaded.workflow} onSave={onSaveWorkflow} /></PortalModal> : null}
      </>;
    case "skills": return <SkillsView snapshot={loaded.snapshot} />;
    case "prompts": return <PromptsView document={loaded.prompts} onSave={onSavePrompts} readOnly={readOnly} />;
    case "mcp": return <McpView snapshot={loaded.snapshot} />;
    case "extensions": return <ExtensionsView snapshot={loaded.snapshot} />;
    case "rules": return <RulesView snapshot={loaded.snapshot} />;
    case "releases": return <ReleasesView snapshot={loaded.snapshot} />;
  }
}

function PluginBrandIcon({ pluginKey }: { pluginKey: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [pluginKey]);
  if (failed) return <Package aria-hidden="true" className="portal-brand-fallback" size={22} />;
  return (
    <img
      alt=""
      className="portal-brand-image"
      onError={() => setFailed(true)}
      src={`/api/plugins/${encodeURIComponent(pluginKey)}/icon`}
    />
  );
}

function DownloadAction({ info }: { info: PluginDownloadInfo }) {
  const label = `下载最新版 v${info.version}`;
  if (info.available && info.href) {
    return <a aria-label={label} className="portal-download-action" href={info.href} title={label}><Download aria-hidden="true" size={17} /><span className="portal-action-label">{label}</span></a>;
  }
  return <button aria-label={label} className="portal-download-action" disabled title="该插件未提供可下载版本" type="button"><Download aria-hidden="true" size={17} /><span className="portal-action-label">{label}</span></button>;
}
