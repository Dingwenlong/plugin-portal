import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AccretionController } from "./CoverAccretionSketch";

type RenderState = "loading" | "ready" | "fallback";
export type AnimationState = "running" | "static" | "frozen" | "paused";
export const COVER_ACCRETION_INITIALIZATION_TIMEOUT_MS = 10_000;

export function CoverAccretionBackground({
  frozen = false,
  onReady,
}: {
  frozen?: boolean;
  onReady?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frozenRef = useRef(frozen);
  const onReadyRef = useRef(onReady);
  const controllerRef = useRef<AccretionController | null>(null);
  const [renderState, setRenderState] = useState<RenderState>("loading");
  const [animationState, setAnimationState] = useState<AnimationState>("running");
  frozenRef.current = frozen;
  onReadyRef.current = onReady;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let active = true;
    let ready = false;
    let controller: AccretionController | undefined;
    const deadline = performance.now() + COVER_ACCRETION_INITIALIZATION_TIMEOUT_MS;
    const notify = () => {
      if (ready) return;
      ready = true;
      onReadyRef.current?.();
    };
    const fail = () => {
      if (!active) return;
      active = false;
      window.clearTimeout(timeout);
      controller?.dispose();
      controllerRef.current = null;
      setRenderState("fallback");
      setAnimationState("static");
      notify();
    };
    const timeout = window.setTimeout(fail, COVER_ACCRETION_INITIALIZATION_TIMEOUT_MS);
    setRenderState("loading");

    // Neither p5 nor the original shader is fetched on a direct Hub visit.
    void import("./CoverAccretionSketch").then(({ mountAccretionSketch }) => {
      if (!active) return;
      if (performance.now() >= deadline) { fail(); return; }
      controller = mountAccretionSketch(host, {
        frozen: frozenRef.current,
        onFrame: () => {
          if (!active) return;
          if (!ready && performance.now() >= deadline) { fail(); return; }
          window.clearTimeout(timeout);
          setRenderState("ready");
          notify();
        },
        onFailure: fail,
        onAnimationState: (state) => { if (active) setAnimationState(state); },
      });
      // setup/draw may fail synchronously during the p5 constructor.
      if (!active) controller.dispose();
      else {
        controllerRef.current = controller;
        controller.setFrozen(frozenRef.current);
      }
    }).catch(fail);

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller?.dispose();
      controllerRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    controllerRef.current?.setFrozen(frozen);
  }, [frozen]);

  return <div
    className="portal-cover-accretion"
    data-animation-state={animationState}
    data-render-state={renderState}
    data-cover-accretion-background
    aria-hidden="true"
  >
    <div className="portal-cover-accretion-host" ref={hostRef} />
    {renderState === "fallback" && <canvas
      className="portal-cover-accretion-canvas"
      data-cover-accretion-canvas
      data-render-state="fallback"
      data-rendered-frame="0"
    />}
  </div>;
}
