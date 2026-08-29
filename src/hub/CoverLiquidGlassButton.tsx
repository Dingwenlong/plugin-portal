import {
  useEffect,
  useRef,
  useState,
  type AnimationEventHandler,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  COVER_LIQUID_ORB_STATIC_TARGET,
  COVER_LIQUID_ORB_TARGET,
} from "./orb/CoverLiquidOrbConfig";
import { createOrbRenderer } from "./orb/upstream/orb-renderer";

type RenderState = "loading" | "ready" | "failed";
type AnimationState = "running" | "static";

function asError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}

export function CoverLiquidGlassButton({
  children,
  onClick,
  className,
  disabled,
  style,
  onAnimationEnd,
}: {
  children: ReactNode;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  style?: CSSProperties;
  onAnimationEnd?: AnimationEventHandler<HTMLButtonElement>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderState, setRenderState] = useState<RenderState>("loading");
  const [animationState, setAnimationState] = useState<AnimationState>("running");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotionState = () => setAnimationState(motionQuery.matches ? "static" : "running");
    updateMotionState();
    motionQuery.addEventListener("change", updateMotionState);

    let disposed = false;
    let settled = false;
    let stopRenderer: () => void = () => undefined;
    const fail = (_error: Error) => {
      if (disposed || settled) return;
      settled = true;
      window.clearTimeout(initializationTimeout);
      stopRenderer();
      setAnimationState("static");
      setRenderState("failed");
    };
    const ready = () => {
      if (disposed || settled) return;
      settled = true;
      window.clearTimeout(initializationTimeout);
      setRenderState("ready");
    };
    const initializationTimeout = window.setTimeout(
      () => fail(new Error("Liquid Orb initialization timed out.")),
      10_000,
    );

    try {
      stopRenderer = createOrbRenderer({
        canvas,
        getTarget: () => motionQuery.matches
          ? COVER_LIQUID_ORB_STATIC_TARGET
          : COVER_LIQUID_ORB_TARGET,
        onError: (error) => fail(asError(error)),
        onReady: ready,
      });
    } catch (error) {
      fail(asError(error));
    }

    return () => {
      disposed = true;
      window.clearTimeout(initializationTimeout);
      motionQuery.removeEventListener("change", updateMotionState);
      stopRenderer();
    };
  }, []);

  return <button
    className={`portal-cover-enter${className ? ` ${className}` : ""}`}
    type="button"
    onClick={onClick}
    disabled={Boolean(disabled) || renderState !== "ready"}
    aria-hidden={renderState === "ready" ? undefined : true}
    tabIndex={renderState === "ready" ? undefined : -1}
    style={style}
    onAnimationEnd={onAnimationEnd}
    data-animation-state={animationState}
    data-cover-liquid-glass-button="true"
    data-renderer="lersent-orb-particle-ribbon"
    data-render-state={renderState}
  >
    <canvas
      ref={canvasRef}
      className="portal-cover-enter-canvas"
      aria-hidden="true"
      data-cover-liquid-glass-canvas
      data-orb-style="particleRibbon"
      data-render-state={renderState}
      data-rendered-frame={renderState === "ready" ? "1" : "0"}
      data-shape="circle"
    />
    {renderState === "ready" && <span className="portal-cover-enter-label">{children}</span>}
  </button>;
}
