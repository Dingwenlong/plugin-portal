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
  Triangle,
  Workflow as WorkflowIcon,
  X,
  type LucideIcon,
} from "lucide-react";

import { HubEntry, type HubRoute } from "../hub/HubEntry";
import { PortalClient } from "./api";
import { useResource } from "./useResource";
import type { ResourceState } from "./requestState";
import { sameContent } from "./requestState";
import { PortalModal, requestPortalNavigation } from "./PortalModal";
import { PortalPageAction, PortalPageActionTargetProvider } from "./PortalPageAction";
import { PluginBrandIcon } from "./PluginBrandIcon";
import { GlassSurface } from "./GlassSurface";
import { PortalThemeProvider, ThemeToggle } from "./PortalTheme";
import type { PluginManagementClient } from "./PluginManager";
import { parsePortalRoute, portalHref, type PortalPage } from "./routes";
import type {
  PluginCatalog,
  PluginImportCandidate,
  PluginImportConfig,
  PluginDownloadInfo,
  PluginMutationReceipt,
  PluginSnapshot,
  PortalAccess,
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
  getAccessMode(signal?: AbortSignal): Promise<PortalAccess>;
  listPlugins(signal?: AbortSignal): Promise<PluginCatalog>;
  getSnapshot(pluginKey: string, signal?: AbortSignal): Promise<PluginSnapshot>;
  getDownloadInfo(pluginKey: string, signal?: AbortSignal): Promise<PluginDownloadInfo>;
  getPrompts(pluginKey: string, signal?: AbortSignal): Promise<PromptDocument>;
  savePrompts(pluginKey: string, revision: number, items: PromptItem[]): Promise<PromptDocument>;
  getWorkflows(pluginKey: string, signal?: AbortSignal): Promise<WorkflowDocument>;
  saveWorkflows(pluginKey: string, revision: number, workflow: WorkflowValue): Promise<WorkflowDocument>;
  previewImport(config: PluginImportConfig): Promise<PluginImportCandidate>;
  promote(pluginKey: string, candidateId: string, revision: number): Promise<PluginMutationReceipt>;
  rollback(pluginKey: string, revision: number): Promise<PluginMutationReceipt>;
}

interface LoadedPluginData {
  snapshot?: PluginSnapshot;
  prompts?: PromptDocument;
  workflow?: WorkflowDocument;
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
  return <PortalThemeProvider><PortalShellContent client={client} initialHash={initialHash} /></PortalThemeProvider>;
}

function PortalShellContent({
  client,
  initialHash,
}: {
  client?: PortalDataClient;
  initialHash?: string;
}) {
  const resolvedClient = useMemo<PortalDataClient>(() => client ?? new PortalClient(), [client]);
  const [browserHash, setBrowserHash] = useState(() => initialHash ?? window.location.hash);
  const loaders = useMemo(() => ({
    catalog: (_key: string, signal: AbortSignal) => resolvedClient.listPlugins(signal),
    access: (_key: string, signal: AbortSignal) => resolvedClient.getAccessMode(signal),
    snapshot: (key: string, signal: AbortSignal) => resolvedClient.getSnapshot(key, signal),
    prompts: (key: string, signal: AbortSignal) => resolvedClient.getPrompts(key, signal),
    workflow: (key: string, signal: AbortSignal) => resolvedClient.getWorkflows(key, signal),
    download: (key: string, signal: AbortSignal) => resolvedClient.getDownloadInfo(key, signal),
  }), [resolvedClient]);
  const catalogResource = useResource("catalog", loaders.catalog);
  const accessResource = useResource("access", loaders.access);
  const catalog = catalogResource.value ?? { revision: 0, items: [] };
  const access = accessResource.value ?? { readOnly: true, fileSelectionMode: "none" as const };
  const [editingWorkflow, setEditingWorkflow] = useState(false);
  const [pageActionTarget, setPageActionTarget] = useState<HTMLDivElement | null>(null);
  const [capsuleHidden, setCapsuleHidden] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
  const [portalModalOpen, setPortalModalOpen] = useState(false);
  const capsuleRef = useRef<HTMLElement>(null);
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const appearanceTriggerRef = useRef<HTMLButtonElement>(null);
  const appearancePanelRef = useRef<HTMLDivElement>(null);
  const lastScrollYRef = useRef(0);
  const downwardTravelRef = useRef(0);
  const upwardTravelRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const keyboardInputRef = useRef(false);
  const workflowTriggerRef = useRef<HTMLButtonElement>(null);
  const readOnly = access.readOnly;

  const pluginIds = useMemo(() => catalog.items.map((plugin) => plugin.id), [catalog.items]);
  const sourceHash = initialHash ?? browserHash;
  const activeRoute = useRef(sourceHash);
  activeRoute.current = sourceHash;
  const isPluginLocation = /^#\/plugins\//.test(sourceHash);
  const hubRoute: HubRoute | undefined = isPluginLocation
    ? undefined
    : sourceHash === "#/hub" ? "hub" : "cover";
  const route = parsePortalRoute(sourceHash, pluginIds);
  const page = route.page;

  useEffect(() => {
    setCapsuleHidden(false);
    setMobileMenuOpen(false);
    setAppearanceOpen(false);
    setEditingWorkflow(false);
    lastScrollYRef.current = window.scrollY;
    downwardTravelRef.current = 0;
    upwardTravelRef.current = 0;
  }, [page, route.pluginId]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => {
      setCompact(query.matches);
      setAppearanceOpen(false);
      setMobileMenuOpen(false);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

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
        if (currentY <= 24 || mobileMenuOpen || appearanceOpen || portalModalOpen || capsuleHasKeyboardFocus) {
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
  }, [mobileMenuOpen, appearanceOpen, portalModalOpen]);

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
    if (!appearanceOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!appearancePanelRef.current?.contains(event.target as Node)
        && !appearanceTriggerRef.current?.contains(event.target as Node)) setAppearanceOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAppearanceOpen(false);
      appearanceTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [appearanceOpen]);

  useEffect(() => {
    if (initialHash !== undefined) return undefined;
    const onHashChange = () => {
      const nextHash = window.location.hash;
      const proceed = () => {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
        setBrowserHash(nextHash);
      };
      if (requestPortalNavigation(proceed)) proceed();
      else window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${activeRoute.current}`);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [initialHash]);

  useEffect(() => {
    if (initialHash !== undefined || isPluginLocation || sourceHash === "#/" || sourceHash === "#/hub") return;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/`);
    setBrowserHash("#/");
  }, [initialHash, isPluginLocation, sourceHash]);

  const selectedPlugin = catalog.items.find((plugin) => plugin.id === route.pluginId);
  const selectedPluginKey = hubRoute ? undefined : selectedPlugin?.pluginKey;
  const snapshotResource = useResource(selectedPluginKey, loaders.snapshot, catalog.revision);
  const promptsResource = useResource(selectedPluginKey, loaders.prompts, catalog.revision);
  const workflowResource = useResource(selectedPluginKey, loaders.workflow, catalog.revision);
  const downloadResource = useResource(selectedPluginKey, loaders.download, catalog.revision);
  const refreshHubCatalog = async () => { await catalogResource.refresh(); };

  if (hubRoute) return <HubEntry
    access={access}
    catalog={catalog}
    client={resolvedClient}
    route={hubRoute}
    catalogStatus={catalogResource.status}
    catalogError={catalogResource.error ?? accessResource.error}
    onRetryCatalog={() => {
      if (catalogResource.status === "error") void catalogResource.refresh().catch(() => undefined);
      if (accessResource.status === "error") void accessResource.refresh().catch(() => undefined);
    }}
    onCatalogChanged={refreshHubCatalog}
    onNavigate={(next) => {
      if (initialHash !== undefined) return;
      const nextHash = next === "hub" ? "#/hub" : "#/";
      setBrowserHash(nextHash);
      if (window.location.hash !== nextHash) window.location.hash = nextHash;
    }}
  />;

  if (!selectedPlugin) return <main className="portal-empty-root"><h1>Plugin Portal</h1><a href="#/hub">返回 Hub</a>{catalogResource.status !== "ready" ? <ResourceNotice state={catalogResource} retry={catalogResource.refresh} /> : <p>该插件未纳入 Portal。</p>}</main>;
  const pageResource = page === "prompts" ? promptsResource : page === "overview" ? workflowResource : snapshotResource;
  const loaded = { snapshot: snapshotResource.value, prompts: promptsResource.value, workflow: workflowResource.value };
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
          <GlassSurface />
          <a aria-label={selectedPlugin.name} className="portal-brand" href={portalHref(selectedPlugin.id, "overview")}>
            <PluginBrandIcon pluginKey={selectedPlugin.pluginKey} revision={catalog.revision} />
            <span>{selectedPlugin.name}</span>
          </a>
          <div aria-hidden="true" className="portal-capsule-current">
            <CurrentPageIcon size={18} strokeWidth={1.7} />
            <span>{currentNavigation.label}</span>
          </div>
          <nav
            aria-label="插件内容"
            data-expanded={mobileMenuOpen ? "true" : "false"}
            id="portal-capsule-navigation"
            onClick={() => {
              if (!mobileMenuOpen) return;
              setMobileMenuOpen(false);
              mobileMenuTriggerRef.current?.focus();
            }}
          >
            {NAVIGATION.map((item) => (
              <a aria-current={item.page === page ? "page" : undefined} href={portalHref(selectedPlugin.id, item.page)} key={item.page}>
                <item.icon aria-hidden="true" size={18} strokeWidth={1.7} />
                <span>{item.label}</span>
              </a>
            ))}
          </nav>
          <div className="portal-capsule-actions">
            {compact && <ThemeToggle className="portal-theme-compact" />}
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
            <DownloadAction state={downloadResource} version={selectedPlugin.version} retry={downloadResource.refresh} />
            {!compact && <button
              aria-controls="portal-appearance-panel"
              aria-expanded={appearanceOpen}
              aria-label="外观设置"
              className="portal-appearance-trigger"
              onClick={() => { setCapsuleHidden(false); setAppearanceOpen((open) => !open); }}
              ref={appearanceTriggerRef}
              title="外观设置"
              type="button"
            ><Triangle aria-hidden="true" size={10} fill="currentColor" /></button>}
          </div>
          {!compact && appearanceOpen && <div aria-label="主题设置" className="portal-appearance-panel" id="portal-appearance-panel" ref={appearancePanelRef} role="group">
            <ThemeToggle />
          </div>}
        </header>
        <main aria-label={PAGE_TITLES[page]} className="portal-main">
          <section className="portal-content" aria-busy={pageResource.status === "loading"}>
            {accessResource.error && <ResourceNotice state={accessResource} retry={accessResource.refresh} />}
            {pageResource.status !== "ready" && <ResourceNotice state={pageResource} retry={pageResource.refresh} />}
            {pageResource.value && renderPage({
              page,
              readOnly,
              loaded,
              editingWorkflow,
              workflowTriggerRef,
              onOpenWorkflow: () => setEditingWorkflow(true),
              onCloseWorkflow: () => { setEditingWorkflow(false); workflowTriggerRef.current?.focus(); },
              onSavePrompts: async (revision, items) => {
                const prompts = await resolvedClient.savePrompts(selectedPlugin.pluginKey, revision, items);
                promptsResource.update(prompts);
              },
              onSaveWorkflow: async (revision, workflow) => {
                const saved = await resolvedClient.saveWorkflows(selectedPlugin.pluginKey, revision, workflow);
                if (workflowResource.update(saved) && activeRoute.current === sourceHash) setEditingWorkflow(false);
              },
              onCheckPrompts: async (items) => {
                const latest = await resolvedClient.getPrompts(selectedPlugin.pluginKey);
                if (!sameContent(latest.items, items)) return false;
                promptsResource.update(latest);
                return true;
              },
              onReadPrompts: () => resolvedClient.getPrompts(selectedPlugin.pluginKey),
              onApplyPrompts: promptsResource.update,
              onCheckWorkflow: async (workflow) => {
                const latest = await resolvedClient.getWorkflows(selectedPlugin.pluginKey);
                if (!sameContent({ pluginKey: latest.pluginKey, tabs: latest.tabs }, workflow)) return false;
                if (workflowResource.update(latest) && activeRoute.current === sourceHash) setEditingWorkflow(false);
                return true;
              },
              onReadWorkflow: () => resolvedClient.getWorkflows(selectedPlugin.pluginKey),
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
  onCheckPrompts,
  onReadPrompts,
  onApplyPrompts,
  onCheckWorkflow,
  onReadWorkflow,
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
  onCheckPrompts: (items: PromptItem[]) => Promise<boolean>;
  onReadPrompts: () => Promise<PromptDocument>;
  onApplyPrompts: (document: PromptDocument) => void;
  onCheckWorkflow: (workflow: WorkflowValue) => Promise<boolean>;
  onReadWorkflow: () => Promise<WorkflowDocument>;
}) {
  switch (page) {
    case "overview":
      if (!loaded.workflow) return null;
      return <>
        {!readOnly && <PortalPageAction>
          <button aria-label="配置流程" className="portal-page-action" onClick={onOpenWorkflow} ref={workflowTriggerRef} title="配置流程" type="button">
            <Settings2 aria-hidden="true" size={17} />
            <span className="portal-action-label">配置流程</span>
          </button>
        </PortalPageAction>}
        <OverviewView workflow={loaded.workflow} />
        {!readOnly && editingWorkflow ? <PortalModal key={loaded.workflow.pluginKey} returnFocusRef={workflowTriggerRef} onClose={onCloseWorkflow} title="配置流程" wide><WorkflowEditor document={loaded.workflow} onSave={onSaveWorkflow} onCheckSaved={onCheckWorkflow} onReadLatest={onReadWorkflow} /></PortalModal> : null}
      </>;
    case "skills": return loaded.snapshot && <SkillsView snapshot={loaded.snapshot} />;
    case "prompts": return loaded.prompts && <PromptsView key={loaded.prompts.pluginKey} document={loaded.prompts} onSave={onSavePrompts} readOnly={readOnly} onCheckSaved={onCheckPrompts} onReadLatest={onReadPrompts} onApplyLatest={onApplyPrompts} />;
    case "mcp": return loaded.snapshot && <McpView snapshot={loaded.snapshot} />;
    case "extensions": return loaded.snapshot && <ExtensionsView snapshot={loaded.snapshot} />;
    case "rules": return loaded.snapshot && <RulesView snapshot={loaded.snapshot} />;
    case "releases": return loaded.snapshot && <ReleasesView snapshot={loaded.snapshot} />;
  }
}

function DownloadAction({ state, version, retry }: { state: ResourceState<PluginDownloadInfo>; version: string; retry: () => Promise<unknown> }) {
  const info = state.value;
  const label = `下载最新版 v${version}`;
  if (state.status === "loading") return <button aria-label="正在检查下载" className="portal-download-action" disabled title="正在检查下载" type="button"><Download aria-hidden="true" size={17} /><span className="portal-action-label">v{version}</span></button>;
  if (state.status === "error") return <button aria-label="重新检查下载" className="portal-download-action" onClick={() => void retry().catch(() => undefined)} title={`下载检查失败：${state.error ?? "请重试"}`} type="button"><Download aria-hidden="true" size={17} /><span className="portal-action-label">重试</span></button>;
  if (!info) return null;
  if (info.available && info.href) {
    return <a aria-label={label} className="portal-download-action" href={info.href} title={label}><Download aria-hidden="true" size={17} /><span className="portal-action-label">v{info.version}</span></a>;
  }
  return <button aria-label={label} className="portal-download-action" disabled title="该插件未提供可下载版本" type="button"><Download aria-hidden="true" size={17} /><span className="portal-action-label">v{info.version}</span></button>;
}

function ResourceNotice({ state, retry }: { state: ResourceState<unknown>; retry: () => Promise<unknown> }) {
  if (state.status === "error") return <div className="portal-resource-notice"><p role="alert">{state.error}</p><button onClick={() => void retry().catch(() => undefined)} type="button">重试读取</button><a href="#/hub">返回 Hub</a></div>;
  return <p role="status">正在读取公开资料…</p>;
}
