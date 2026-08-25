export type CoverLiquidGlassFallbackFrame = {
  highlightX: number;
  highlightY: number;
  secondaryX: number;
  secondaryY: number;
  sheenAngle: number;
};

type FallbackOptions = {
  canvas: HTMLCanvasElement;
  motionQuery: MediaQueryList;
  onReady: () => void;
  onAnimationStateChange?: (state: "running" | "static") => void;
  isPaused?: () => boolean;
};

export function coverLiquidGlassBackingSize({
  clientWidth,
  clientHeight,
  transformedWidth,
  transformedHeight,
  devicePixelRatio,
}: {
  clientWidth: number;
  clientHeight: number;
  transformedWidth: number;
  transformedHeight: number;
  devicePixelRatio: number;
}) {
  const dpr = Math.min(2, Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1));
  const layoutWidth = clientWidth > 0 ? clientWidth : transformedWidth;
  const layoutHeight = clientHeight > 0 ? clientHeight : transformedHeight;
  return {
    width: Math.min(512, Math.max(1, Math.round((Number.isFinite(layoutWidth) ? layoutWidth : 1) * dpr))),
    height: Math.min(512, Math.max(1, Math.round((Number.isFinite(layoutHeight) ? layoutHeight : 1) * dpr))),
  };
}
export function coverLiquidGlassFallbackFrame(
  timeSeconds: number,
): CoverLiquidGlassFallbackFrame {
  const time = Number.isFinite(timeSeconds) && timeSeconds > 0 ? timeSeconds : 0;
  return {
    highlightX: 0.5 + Math.cos(time * 0.82) * 0.24,
    highlightY: 0.5 + Math.sin(time * 0.67) * 0.22,
    secondaryX: 0.5 + Math.cos(time * 0.49 + 2.1) * 0.31,
    secondaryY: 0.5 + Math.sin(time * 0.58 + 1.3) * 0.27,
    sheenAngle: time * 0.36,
  };
}

function resizeCanvas(canvas: HTMLCanvasElement) {
  const bounds = canvas.getBoundingClientRect();
  const { width, height } = coverLiquidGlassBackingSize({
    clientWidth: canvas.clientWidth,
    clientHeight: canvas.clientHeight,
    transformedWidth: bounds.width,
    transformedHeight: bounds.height,
    devicePixelRatio: window.devicePixelRatio || 1,
  });
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height };
}

function drawFallbackFrame(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  timeSeconds: number,
) {
  const { width, height } = resizeCanvas(canvas);
  const frame = coverLiquidGlassFallbackFrame(timeSeconds);
  const radius = Math.min(width, height) / 2;

  context.clearRect(0, 0, width, height);
  context.save();
  context.beginPath();
  context.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
  context.clip();

  const base = context.createRadialGradient(
    width * 0.46,
    height * 0.42,
    radius * 0.08,
    width * 0.5,
    height * 0.5,
    radius,
  );
  base.addColorStop(0, "#242a32");
  base.addColorStop(0.48, "#090b0f");
  base.addColorStop(1, "#020305");
  context.fillStyle = base;
  context.fillRect(0, 0, width, height);

  context.globalCompositeOperation = "screen";
  const primary = context.createRadialGradient(
    width * frame.highlightX,
    height * frame.highlightY,
    0,
    width * frame.highlightX,
    height * frame.highlightY,
    radius * 0.78,
  );
  primary.addColorStop(0, "rgba(255,255,255,.92)");
  primary.addColorStop(0.18, "rgba(190,210,232,.46)");
  primary.addColorStop(0.52, "rgba(103,142,189,.12)");
  primary.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = primary;
  context.fillRect(0, 0, width, height);

  const secondary = context.createRadialGradient(
    width * frame.secondaryX,
    height * frame.secondaryY,
    0,
    width * frame.secondaryX,
    height * frame.secondaryY,
    radius * 0.64,
  );
  secondary.addColorStop(0, "rgba(255,255,255,.56)");
  secondary.addColorStop(0.25, "rgba(188,195,207,.22)");
  secondary.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = secondary;
  context.fillRect(0, 0, width, height);

  context.translate(width / 2, height / 2);
  context.rotate(frame.sheenAngle);
  const sheen = context.createLinearGradient(-radius, 0, radius, 0);
  sheen.addColorStop(0, "rgba(255,255,255,0)");
  sheen.addColorStop(0.42, "rgba(255,255,255,.02)");
  sheen.addColorStop(0.5, "rgba(255,255,255,.4)");
  sheen.addColorStop(0.58, "rgba(255,255,255,.02)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = sheen;
  context.fillRect(-radius, -radius * 1.5, radius * 2, radius * 3);
  context.restore();

  context.save();
  context.beginPath();
  context.arc(width / 2, height / 2, Math.max(0, radius - 1), 0, Math.PI * 2);
  context.strokeStyle = "rgba(216,232,248,.34)";
  context.lineWidth = Math.max(1, radius * 0.018);
  context.stroke();
  context.restore();
}

export function startCoverLiquidGlassFallback({
  canvas,
  motionQuery,
  onReady,
  onAnimationStateChange,
  isPaused = () => false,
}: FallbackOptions) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The Canvas 2D fallback context is unavailable.");

  let disposed = false;
  let animationFrame = 0;
  let renderedFrames = 0;
  let readyNotified = false;
  let startedAt = performance.now();

  const render = (timeSeconds: number) => {
    if (disposed) return;
    drawFallbackFrame(canvas, context, timeSeconds);
    renderedFrames += 1;
    canvas.dataset.renderedFrame = String(renderedFrames);
    canvas.dataset.renderedClock = timeSeconds.toFixed(6);
    canvas.dataset.fallbackRenderer = "canvas-2d";
    if (!readyNotified) {
      readyNotified = true;
      onReady();
    }
  };

  const animate = (now: number) => {
    if (disposed || motionQuery.matches || isPaused()) return;
    render(Math.max(0, (now - startedAt) / 1000));
    animationFrame = window.requestAnimationFrame(animate);
  };

  const applyMotionPreference = () => {
    window.cancelAnimationFrame(animationFrame);
    if (motionQuery.matches) {
      onAnimationStateChange?.("static");
      render(0);
      return;
    }
    onAnimationStateChange?.("running");
    if (isPaused()) return;
    startedAt = performance.now();
    render(0);
    animationFrame = window.requestAnimationFrame(animate);
  };

  const handleResize = () => {
    if (motionQuery.matches) render(0);
  };

  motionQuery.addEventListener("change", applyMotionPreference);
  window.addEventListener("resize", handleResize);
  applyMotionPreference();

  return () => {
    disposed = true;
    window.cancelAnimationFrame(animationFrame);
    motionQuery.removeEventListener("change", applyMotionPreference);
    window.removeEventListener("resize", handleResize);
  };
}
