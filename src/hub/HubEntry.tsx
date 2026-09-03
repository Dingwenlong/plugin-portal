import {
  useEffect,
  useRef,
  useState,
  type AnimationEvent,
  type CSSProperties,
  type RefObject,
} from "react";

import { PluginManager, type PluginManagementClient } from "../portal/PluginManager";
import {
  DownloadPublisherDialog,
  type DownloadPublicationClient,
} from "../portal/DownloadPublisher";
import { PluginBrandIcon } from "../portal/PluginBrandIcon";
import { ThemeToggle } from "../portal/PortalTheme";
import { portalHref } from "../portal/routes";
import type { PluginCatalog, PluginListItem, PortalAccess } from "../portal/types";
import { CoverAccretionBackground } from "./CoverAccretionBackground";
import {
  CoverLiquidGlassButton,
  type CoverLiquidGlassButtonHandle,
} from "./CoverLiquidGlassButton";

export type HubRoute = "cover" | "hub";
export type EntryPhase = "idle" | "engulfing" | "revealing" | "hub";
type EntryEvent = "start" | "covered" | "revealed" | "safety-timeout" | "reset";

const START_DIAMETER = 112;
const TIMING = Object.freeze({
  scalePreparationMs: 250,
  labelFadeMs: 120,
  engulfMs: 680,
  revealMs: 360,
  reducedPhaseMs: 120,
  safetyBufferMs: 150,
});
const ENGULF_ANIMATIONS = new Set([
  "hub-entry-engulf",
  "hub-entry-fallback-cover",
  "hub-entry-reduced-cover",
]);
const REVEAL_ANIMATIONS = new Set(["hub-entry-reveal", "hub-entry-reduced-reveal"]);
type EntryTransitionMode = "scaled" | "fade";

export function reduceEntryPhase(phase: EntryPhase, event: EntryEvent): EntryPhase {
  if (event === "reset") return "idle";
  if (phase === "idle" && event === "start") return "engulfing";
  if (phase === "engulfing" && event === "covered") return "revealing";
  if (phase === "revealing" && event === "revealed") return "hub";
  if (phase === "engulfing" && event === "safety-timeout") return "revealing";
  if (phase === "revealing" && event === "safety-timeout") return "hub";
  return phase;
}

function HubList({
  readOnly,
  catalog,
  interactive,
  firstEntryRef,
  includeButtonRef,
  onInclude,
  onPublish,
}: {
  catalog: PluginCatalog;
  interactive: boolean;
  readOnly: boolean;
  firstEntryRef?: RefObject<HTMLAnchorElement | null>;
  includeButtonRef?: RefObject<HTMLButtonElement | null>;
  onInclude: () => void;
  onPublish?: (plugin: PluginListItem, trigger: HTMLButtonElement) => void;
}) {
  return <main className="company-dev-hub" data-company-dev-hub aria-hidden={!interactive || undefined}>
    <h1 className="sr-only">已纳入插件</h1>
    <div className="company-dev-hub-sections">
      <div className="company-dev-hub-toolbar">
        <ThemeToggle disabled={!interactive} />
        {!readOnly && <button ref={includeButtonRef} type="button" tabIndex={interactive ? 0 : -1} onClick={onInclude}>纳入插件</button>}
      </div>
      <section className="company-dev-hub-section" data-hub-section="plugins">
        <h2>插件</h2>
        <div className="company-dev-hub-entry-list">
          {catalog.items.length === 0
            ? <p className="company-dev-hub-empty">尚未纳入插件</p>
            : catalog.items.map((item, index) => <div className="company-dev-hub-entry-row" key={item.pluginKey}>
                <a
                  className="company-dev-hub-entry"
                  aria-label={item.name}
                  href={portalHref(item.id, "overview")}
                  ref={index === 0 ? firstEntryRef : undefined}
                  tabIndex={interactive ? 0 : -1}
                  data-hub-entry={item.id}
                >
                  <span className="company-dev-hub-entry-identity">
                    <PluginBrandIcon pluginKey={item.pluginKey} revision={catalog.revision} />
                    <span>{item.name}</span>
                  </span>
                  <span className="company-dev-hub-entry-action">进入</span>
                </a>
                {!readOnly && onPublish ? <button
                  aria-label={`发布 ${item.name} 下载`}
                  className="company-dev-hub-publish"
                  onClick={(event) => onPublish(item, event.currentTarget)}
                  tabIndex={interactive ? 0 : -1}
                  type="button"
                >发布下载</button> : null}
              </div>)}
        </div>
      </section>
    </div>
  </main>;
}

function GenericHubView({
  readOnly,
  catalog,
  route,
  phase = route === "hub" ? "hub" : "idle",
  onStart = () => undefined,
  onButtonAnimationEnd,
  onCoverAnimationEnd,
  reducedMotion = false,
  coverScale = 1,
  preparing = false,
  transitionMode = "scaled",
  buttonRef,
  firstEntryRef,
  includeButtonRef,
  onInclude,
  onPublish,
}: {
  catalog: PluginCatalog;
  route: HubRoute;
  readOnly: boolean;
  phase?: EntryPhase;
  onStart?: () => void;
  onButtonAnimationEnd?: (event: AnimationEvent<HTMLButtonElement>) => void;
  onCoverAnimationEnd?: (event: AnimationEvent<HTMLElement>) => void;
  reducedMotion?: boolean;
  coverScale?: number;
  preparing?: boolean;
  transitionMode?: EntryTransitionMode;
  buttonRef?: RefObject<CoverLiquidGlassButtonHandle | null>;
  firstEntryRef?: RefObject<HTMLAnchorElement | null>;
  includeButtonRef?: RefObject<HTMLButtonElement | null>;
  onInclude: () => void;
  onPublish?: (plugin: PluginListItem, trigger: HTMLButtonElement) => void;
}) {
  const effectivePhase = route === "hub" && phase === "idle" ? "hub" : phase;
  const showHub = effectivePhase === "revealing" || effectivePhase === "hub";
  const showCover = effectivePhase !== "hub";

  return <div className="hub-entry-flow" data-hub-entry-phase={effectivePhase} data-reduced-motion={reducedMotion}>
    {showHub && <HubList
      readOnly={readOnly}
      catalog={catalog}
      interactive={effectivePhase === "hub"}
      firstEntryRef={firstEntryRef}
      includeButtonRef={includeButtonRef}
      onInclude={onInclude}
      onPublish={onPublish}
    />}
    {showCover && <HubCover
      effectivePhase={effectivePhase}
      coverScale={coverScale}
      preparing={preparing}
      transitionMode={transitionMode}
      buttonRef={buttonRef}
      onStart={onStart}
      onButtonAnimationEnd={onButtonAnimationEnd}
      onCoverAnimationEnd={onCoverAnimationEnd}
    />}
  </div>;
}

function HubCover({
  effectivePhase,
  coverScale,
  preparing,
  transitionMode,
  buttonRef,
  onStart,
  onButtonAnimationEnd,
  onCoverAnimationEnd,
}: {
  effectivePhase: EntryPhase;
  coverScale: number;
  preparing: boolean;
  transitionMode: EntryTransitionMode;
  buttonRef?: RefObject<CoverLiquidGlassButtonHandle | null>;
  onStart: () => void;
  onButtonAnimationEnd?: (event: AnimationEvent<HTMLButtonElement>) => void;
  onCoverAnimationEnd?: (event: AnimationEvent<HTMLElement>) => void;
}) {
  const [coverReady, setCoverReady] = useState(false);
  const entryStyle = { "--hub-entry-cover-scale": coverScale } as CSSProperties;

  return <main
      className="hub-cover hub-entry-cover-layer"
      data-hub-cover
      data-phase={effectivePhase}
      data-transition-mode={transitionMode}
      data-transition-preparing={preparing || undefined}
      onAnimationEnd={onCoverAnimationEnd}
    >
      <h1 className="sr-only">Plugin Portal</h1>
      <CoverAccretionBackground
        frozen={effectivePhase !== "idle"}
        onReady={() => setCoverReady(true)}
      />
      {!coverReady && <p
        aria-live="polite"
        className="sr-only"
        data-cover-loading-status
        role="status"
      >
        正在加载封面
      </p>}
      <CoverLiquidGlassButton
        ref={buttonRef}
        className={`hub-entry-button is-${effectivePhase}`}
        disabled={effectivePhase !== "idle" || preparing}
        style={entryStyle}
        onClick={onStart}
        onAnimationEnd={onButtonAnimationEnd}
      >
        <span data-hub-start-size={START_DIAMETER}>Start</span>
      </CoverLiquidGlassButton>
      <footer className="hub-cover-attribution sr-only">
        <a href="https://openprocessing.org/@jcponcemath/2696126" target="_blank" rel="noreferrer">Accretion by Xor — jcponcemath</a>
        <span aria-hidden="true"> · </span>
        <a href="https://creativecommons.org/licenses/by-nc-sa/3.0/" target="_blank" rel="noreferrer">CC BY-NC-SA 3.0</a>
      </footer>
    </main>;
}

function InteractiveHub({
  readOnly,
  catalog,
  route,
  onNavigate,
  onInclude,
  onPublish,
}: {
  catalog: PluginCatalog;
  route: HubRoute;
  readOnly: boolean;
  onNavigate: (route: HubRoute) => void;
  onInclude: () => void;
  onPublish?: (plugin: PluginListItem, trigger: HTMLButtonElement) => void;
}) {
  const initial = route === "hub" ? "hub" : "idle";
  const [phase, setPhase] = useState<EntryPhase>(initial);
  const [coverScale, setCoverScale] = useState(1);
  const [preparing, setPreparing] = useState(false);
  const [transitionMode, setTransitionMode] = useState<EntryTransitionMode>("scaled");
  const [reducedMotion, setReducedMotion] = useState(false);
  const phaseRef = useRef<EntryPhase>(initial);
  const timerRef = useRef<number | null>(null);
  const navigatedRef = useRef(route === "hub");
  const focusAfterTransitionRef = useRef(false);
  const firstEntryRef = useRef<HTMLAnchorElement>(null);
  const includeButtonRef = useRef<HTMLButtonElement>(null);
  const buttonRef = useRef<CoverLiquidGlassButtonHandle>(null);
  const preparingRef = useRef(false);
  const preparationTokenRef = useRef(0);

  function clearTimer() {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  function navigateOnce() {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    onNavigate("hub");
  }

  function safetyDelayFor(target: EntryPhase) {
    if (reducedMotion) return TIMING.reducedPhaseMs + TIMING.safetyBufferMs;
    if (target === "engulfing") return TIMING.labelFadeMs + TIMING.engulfMs + TIMING.safetyBufferMs;
    return TIMING.revealMs + TIMING.safetyBufferMs;
  }

  function scheduleSafetyTimeout(target: EntryPhase) {
    clearTimer();
    timerRef.current = window.setTimeout(() => transition("safety-timeout"), safetyDelayFor(target));
  }

  function transition(event: EntryEvent) {
    const next = reduceEntryPhase(phaseRef.current, event);
    if (next !== phaseRef.current) {
      phaseRef.current = next;
      setPhase(next);
      if (next === "revealing") {
        navigateOnce();
        scheduleSafetyTimeout(next);
      } else if (next === "hub") {
        clearTimer();
      }
    }
    return next;
  }

  async function start() {
    if (phaseRef.current !== "idle" || preparingRef.current) return;
    preparingRef.current = true;
    setPreparing(true);
    const token = ++preparationTokenRef.current;
    const targetScale = Math.max(
      1,
      Math.hypot(window.innerWidth, window.innerHeight) / START_DIAMETER * 1.05,
    );
    focusAfterTransitionRef.current = true;
    navigatedRef.current = false;
    let prepared = false;
    if (!reducedMotion && buttonRef.current) {
      let timeout = 0;
      try {
        prepared = await Promise.race([
          buttonRef.current.prepareScale(targetScale),
          new Promise<boolean>((resolve) => {
            timeout = window.setTimeout(() => resolve(false), TIMING.scalePreparationMs);
          }),
        ]);
      } catch {
        prepared = false;
      } finally {
        window.clearTimeout(timeout);
      }
    }

    if (token !== preparationTokenRef.current || phaseRef.current !== "idle") return;
    if (!prepared && !reducedMotion) void buttonRef.current?.prepareScale(1);
    setCoverScale(prepared ? targetScale : 1);
    setTransitionMode(prepared ? "scaled" : "fade");
    preparingRef.current = false;
    setPreparing(false);
    transition("start");
    scheduleSafetyTimeout("engulfing");
  }

  function animationCompleted(name: string) {
    if (phaseRef.current === "engulfing" && ENGULF_ANIMATIONS.has(name)) {
      transition("covered");
    } else if (phaseRef.current === "revealing" && REVEAL_ANIMATIONS.has(name)) {
      transition("revealed");
    }
  }

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    preparationTokenRef.current += 1;
    preparingRef.current = false;
    setPreparing(false);
    setCoverScale(1);
    setTransitionMode("scaled");
    if (route === "cover") {
      if (phaseRef.current !== "idle") {
        clearTimer();
        navigatedRef.current = false;
        focusAfterTransitionRef.current = false;
        transition("reset");
      }
    } else if (phaseRef.current === "idle") {
      phaseRef.current = "hub";
      navigatedRef.current = true;
      setPhase("hub");
    }
  }, [route]);

  useEffect(() => () => {
    preparationTokenRef.current += 1;
    clearTimer();
  }, []);

  useEffect(() => {
    if (phase === "hub" && focusAfterTransitionRef.current) {
      focusAfterTransitionRef.current = false;
      (firstEntryRef.current ?? includeButtonRef.current)?.focus();
    }
  }, [phase]);

  return <GenericHubView
    readOnly={readOnly}
    catalog={catalog}
    route={route}
    phase={phase}
    reducedMotion={reducedMotion}
    coverScale={coverScale}
    preparing={preparing}
    transitionMode={transitionMode}
    buttonRef={buttonRef}
    firstEntryRef={firstEntryRef}
    includeButtonRef={includeButtonRef}
    onInclude={onInclude}
    onPublish={onPublish}
    onStart={start}
    onButtonAnimationEnd={(event) => animationCompleted(event.animationName)}
    onCoverAnimationEnd={(event) => {
      if (event.currentTarget === event.target) animationCompleted(event.animationName);
    }}
  />;
}

export function HubEntry({
  access,
  readOnly = false,
  catalog,
  client,
  route,
  onNavigate,
  onCatalogChanged,
  onDownloadPublished,
}: {
  access?: PortalAccess;
  catalog: PluginCatalog;
  client: PluginManagementClient & Partial<DownloadPublicationClient>;
  readOnly?: boolean;
  route: HubRoute;
  onNavigate: (route: HubRoute) => void;
  onCatalogChanged: () => Promise<void>;
  onDownloadPublished?: (pluginKey: string) => Promise<void>;
}) {
  const effectiveAccess = access ?? {
    readOnly,
    fileSelectionMode: readOnly ? "none" as const : "server-picker" as const,
  };
  const managementReadOnly = effectiveAccess.readOnly;
  const [including, setIncluding] = useState(false);
  const [publishingPlugin, setPublishingPlugin] = useState<PluginListItem>();
  const publicationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const publicationClient = (
    typeof client.selectDownloadCandidate === "function" &&
    typeof client.confirmDownloadPublication === "function" &&
    (effectiveAccess.fileSelectionMode !== "browser-upload"
      || typeof client.uploadDownloadCandidate === "function")
  ) ? client as PluginManagementClient & DownloadPublicationClient : undefined;

  useEffect(() => {
    if (!including) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIncluding(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [including]);

  useEffect(() => {
    if (!publishingPlugin) publicationTriggerRef.current?.focus();
  }, [publishingPlugin]);

  return <>
    <InteractiveHub
      readOnly={managementReadOnly}
      catalog={catalog}
      route={route}
      onNavigate={onNavigate}
      onInclude={() => setIncluding(true)}
      onPublish={publicationClient ? (plugin, trigger) => {
        publicationTriggerRef.current = trigger;
        setPublishingPlugin(plugin);
      } : undefined}
    />
    {!managementReadOnly && including ? <div className="hub-plugin-dialog-backdrop">
      <section className="hub-plugin-dialog" role="dialog" aria-modal="true" aria-label="纳入插件">
        <div className="hub-plugin-dialog-actions">
          <button type="button" onClick={() => setIncluding(false)}>关闭</button>
        </div>
        <PluginManager
          catalogRevision={catalog.revision}
          client={client}
          fileSelectionMode={effectiveAccess.fileSelectionMode}
          onChanged={async () => {
            await onCatalogChanged();
            setIncluding(false);
          }}
        />
      </section>
    </div> : null}
    {!managementReadOnly && publishingPlugin && publicationClient ? <DownloadPublisherDialog
      client={publicationClient}
      fileSelectionMode={effectiveAccess.fileSelectionMode}
      onClose={() => setPublishingPlugin(undefined)}
      onPublished={(receipt) => onDownloadPublished?.(receipt.pluginKey)}
      plugin={publishingPlugin}
    /> : null}
  </>;
}
