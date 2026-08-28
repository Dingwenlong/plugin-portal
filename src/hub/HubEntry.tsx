import {
  useEffect,
  useRef,
  useState,
  type AnimationEvent,
  type CSSProperties,
  type RefObject,
} from "react";

import { PluginManager, type PluginManagementClient } from "../portal/PluginManager";
import { portalHref } from "../portal/routes";
import type { PluginCatalog } from "../portal/types";
import { CoverAccretionBackground } from "./CoverAccretionBackground";
import { CoverLiquidGlassButton } from "./CoverLiquidGlassButton";

export type HubRoute = "cover" | "hub";
export type EntryPhase = "idle" | "engulfing" | "revealing" | "hub";
type EntryEvent = "start" | "covered" | "revealed" | "safety-timeout" | "reset";

const START_DIAMETER = 112;
const TIMING = Object.freeze({
  labelFadeMs: 120,
  engulfMs: 680,
  revealMs: 360,
  reducedPhaseMs: 120,
  safetyBufferMs: 150,
});
const ENGULF_ANIMATIONS = new Set(["hub-entry-engulf", "hub-entry-reduced-cover"]);
const REVEAL_ANIMATIONS = new Set(["hub-entry-reveal", "hub-entry-reduced-reveal"]);

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
}: {
  catalog: PluginCatalog;
  interactive: boolean;
  readOnly: boolean;
  firstEntryRef?: RefObject<HTMLAnchorElement | null>;
  includeButtonRef?: RefObject<HTMLButtonElement | null>;
  onInclude: () => void;
}) {
  return <main className="company-dev-hub" data-company-dev-hub aria-hidden={!interactive || undefined}>
    <h1 className="sr-only">已纳入插件</h1>
    <div className="company-dev-hub-sections">
      {!readOnly && <div className="company-dev-hub-toolbar">
        <button ref={includeButtonRef} type="button" tabIndex={interactive ? 0 : -1} onClick={onInclude}>纳入插件</button>
      </div>}
      <section className="company-dev-hub-section" data-hub-section="plugins">
        <h2>插件</h2>
        <div className="company-dev-hub-entry-list">
          {catalog.items.length === 0
            ? <p className="company-dev-hub-empty">尚未纳入插件</p>
            : catalog.items.map((item, index) => <a
                className="company-dev-hub-entry"
                aria-label={item.name}
                href={portalHref(item.id, "overview")}
                key={item.pluginKey}
                ref={index === 0 ? firstEntryRef : undefined}
                tabIndex={interactive ? 0 : -1}
                data-hub-entry={item.id}
              >
                <span>{item.name}</span>
                <span className="company-dev-hub-entry-action">进入</span>
              </a>)}
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
  firstEntryRef,
  includeButtonRef,
  onInclude,
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
  firstEntryRef?: RefObject<HTMLAnchorElement | null>;
  includeButtonRef?: RefObject<HTMLButtonElement | null>;
  onInclude: () => void;
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
    />}
    {showCover && <HubCover
      effectivePhase={effectivePhase}
      coverScale={coverScale}
      onStart={onStart}
      onButtonAnimationEnd={onButtonAnimationEnd}
      onCoverAnimationEnd={onCoverAnimationEnd}
    />}
  </div>;
}

function HubCover({
  effectivePhase,
  coverScale,
  onStart,
  onButtonAnimationEnd,
  onCoverAnimationEnd,
}: {
  effectivePhase: EntryPhase;
  coverScale: number;
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
      onAnimationEnd={onCoverAnimationEnd}
    >
      <h1 className="sr-only">Plugin Portal</h1>
      <CoverAccretionBackground
        frozen={effectivePhase !== "idle"}
        onReady={() => setCoverReady(true)}
      />
      <div
        aria-hidden={coverReady}
        aria-label="正在加载封面"
        aria-live="polite"
        className="hub-cover-loading"
        data-cover-loading-overlay
        data-ready={coverReady}
        role="status"
      >
        <span aria-hidden="true" className="hub-cover-loading-spinner" />
        <span>加载中</span>
      </div>
      {coverReady ? <CoverLiquidGlassButton
        className={`hub-entry-button is-${effectivePhase}`}
        disabled={effectivePhase !== "idle"}
        style={entryStyle}
        onClick={onStart}
        onAnimationEnd={onButtonAnimationEnd}
      >
        <span data-hub-start-size={START_DIAMETER}>Start</span>
      </CoverLiquidGlassButton> : <button
        className="portal-cover-enter"
        type="button"
        disabled
      >Start</button>}
      <footer className="hub-cover-attribution">
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
}: {
  catalog: PluginCatalog;
  route: HubRoute;
  readOnly: boolean;
  onNavigate: (route: HubRoute) => void;
  onInclude: () => void;
}) {
  const initial = route === "hub" ? "hub" : "idle";
  const [phase, setPhase] = useState<EntryPhase>(initial);
  const [coverScale, setCoverScale] = useState(1);
  const [reducedMotion, setReducedMotion] = useState(false);
  const phaseRef = useRef<EntryPhase>(initial);
  const timerRef = useRef<number | null>(null);
  const navigatedRef = useRef(route === "hub");
  const focusAfterTransitionRef = useRef(false);
  const firstEntryRef = useRef<HTMLAnchorElement>(null);
  const includeButtonRef = useRef<HTMLButtonElement>(null);

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

  function start() {
    if (phaseRef.current !== "idle") return;
    setCoverScale(Math.max(1, Math.hypot(window.innerWidth, window.innerHeight) / START_DIAMETER * 1.05));
    focusAfterTransitionRef.current = true;
    navigatedRef.current = false;
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

  useEffect(() => () => clearTimer(), []);

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
    firstEntryRef={firstEntryRef}
    includeButtonRef={includeButtonRef}
    onInclude={onInclude}
    onStart={start}
    onButtonAnimationEnd={(event) => animationCompleted(event.animationName)}
    onCoverAnimationEnd={(event) => {
      if (event.currentTarget === event.target) animationCompleted(event.animationName);
    }}
  />;
}

export function HubEntry({
  readOnly = false,
  catalog,
  client,
  route,
  onNavigate,
  onCatalogChanged,
}: {
  catalog: PluginCatalog;
  client: PluginManagementClient;
  readOnly?: boolean;
  route: HubRoute;
  onNavigate: (route: HubRoute) => void;
  onCatalogChanged: () => Promise<void>;
}) {
  const [including, setIncluding] = useState(false);

  useEffect(() => {
    if (!including) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIncluding(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [including]);

  return <>
    <InteractiveHub
      readOnly={readOnly}
      catalog={catalog}
      route={route}
      onNavigate={onNavigate}
      onInclude={() => setIncluding(true)}
    />
    {!readOnly && including ? <div className="hub-plugin-dialog-backdrop">
      <section className="hub-plugin-dialog" role="dialog" aria-modal="true" aria-label="纳入插件">
        <div className="hub-plugin-dialog-actions">
          <button type="button" onClick={() => setIncluding(false)}>关闭</button>
        </div>
        <PluginManager
          catalogRevision={catalog.revision}
          client={client}
          onChanged={async () => {
            await onCatalogChanged();
            setIncluding(false);
          }}
        />
      </section>
    </div> : null}
  </>;
}
