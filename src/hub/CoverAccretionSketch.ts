// Adaptation of Accretion by Xor (jcponcemath), CC BY-NC-SA 3.0.
// See THIRD_PARTY-NOTICE-Accretion.txt. Original GLSL is imported unchanged.
import p5 from "p5";
import type { AnimationState } from "./CoverAccretionBackground";
import {
  COVER_ACCRETION_FIELD_FRAGMENT_SHADER,
  COVER_ACCRETION_FIELD_VERTEX_SHADER,
} from "./CoverAccretionFieldShader";

export interface AccretionController {
  setFrozen(frozen: boolean): void;
  dispose(): void;
}

interface SketchOptions {
  frozen: boolean;
  onFrame(): void;
  onFailure(): void;
  onAnimationState(state: AnimationState): void;
}

export function coverAccretionBackingSize(width: number, height: number) {
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

export function mountAccretionSketch(host: HTMLElement, options: SketchOptions): AccretionController {
  let instance: p5 | undefined;
  let buffer: (p5.Graphics & { canvas: HTMLCanvasElement }) | undefined;
  let shader: p5.Shader | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let disposed = false;
  let initialized = false;
  let frozen = options.frozen;
  let frames = 0;
  let lastClock = 0;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("load", startSketch);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", updatePlayback);
    motion.removeEventListener("change", updatePlayback);
    canvas?.removeEventListener("contextlost", fail);
    buffer?.canvas.removeEventListener("webglcontextlost", fail);
    instance?.noLoop();
    buffer?.remove();
    instance?.remove();
    // p5 removes the surfaces and listeners. Release our references too;
    // forcing WebGL context loss can synchronously wait for unrelated GPU work.
    instance = undefined;
    buffer = undefined;
    shader = undefined;
    canvas = undefined;
  };
  const fail = () => {
    if (disposed) return;
    dispose();
    options.onFailure();
  };
  const playbackState = (): AnimationState =>
    frozen ? "frozen" : document.hidden ? "paused" : motion.matches ? "static" : "running";

  function updatePlayback() {
    if (disposed || !initialized || !instance) return;
    const state = playbackState();
    options.onAnimationState(state);
    if (state === "running") instance.loop();
    else {
      instance.noLoop();
      if (state === "static") instance.redraw();
    }
  }

  function resize() {
    if (disposed || !initialized || !instance || !buffer) return;
    try {
      const { width, height } = coverAccretionBackingSize(window.innerWidth, window.innerHeight);
      // Resize both surfaces before drawing, unlike the original standalone host.
      instance.resizeCanvas(width, height, true);
      buffer.resizeCanvas(width, height);
      if (!document.hidden) renderFrame(true);
    } catch { fail(); }
  }

  function renderFrame(resized = false) {
    if (disposed || !initialized || !instance || !buffer || !shader || !canvas) return;
    if (document.hidden || (frozen && frames > 0 && !resized)) {
      instance.noLoop();
      return;
    }
    try {
      const { width, height } = instance;
      buffer.shader(shader);
      const yMouse = (instance.map(instance.mouseY, 0, height, height, 0) / height) * 2 - 1;
      const xMouse = ((instance.mouseX / width) * 2 - 1) * width / height;
      const seconds = frozen && frames > 0 ? lastClock : motion.matches ? 0 : instance.millis() / 1000.0;
      shader.setUniform("iResolution", [width, height]);
      shader.setUniform("iTime", seconds);
      shader.setUniform("iMouse", [xMouse, yMouse]);
      buffer.rect(0, 0, width, height);
      instance.image(buffer, 0, 0, width, height);
      const gl = buffer.drawingContext as WebGLRenderingContext;
      // Validate readiness once. Repeated getError calls synchronously drain
      // the GPU; subsequent failures are handled by context-loss and draw errors.
      if (gl.isContextLost() || (frames === 0 && gl.getError() !== gl.NO_ERROR)) throw new Error("Cover frame failed.");
      lastClock = seconds;
      frames += 1;
      canvas.dataset.renderedFrame = String(frames);
      canvas.dataset.renderedClock = seconds.toFixed(6);
      canvas.dataset.renderState = "ready";
      if (frames === 1) options.onFrame();
      if (disposed) return;
      options.onAnimationState(playbackState());
      if (frozen || motion.matches) instance.noLoop();
    } catch { fail(); }
  }

  function startSketch() {
    window.removeEventListener("load", startSketch);
    if (disposed || instance) return;
    try {
      const created = new p5((p) => {
        instance = p;
        p.setup = () => {
          if (disposed) { p.remove(); return; }
          try {
            const { width, height } = coverAccretionBackingSize(window.innerWidth, window.innerHeight);
            canvas = p.createCanvas(width, height).elt as HTMLCanvasElement;
            canvas.className = "portal-cover-accretion-canvas";
            canvas.dataset.coverAccretionCanvas = "";
            canvas.dataset.renderState = "loading";
            canvas.dataset.renderedFrame = "0";
            canvas.addEventListener("contextlost", fail);
            p.pixelDensity(1);
            p.noStroke();
            const graphics = p.createGraphics(width, height, p.WEBGL) as p5.Graphics & { canvas: HTMLCanvasElement };
            buffer = graphics;
            const gl = graphics.drawingContext as WebGLRenderingContext;
            graphics.canvas.addEventListener("webglcontextlost", fail);
            shader = graphics.createShader(COVER_ACCRETION_FIELD_VERTEX_SHADER, COVER_ACCRETION_FIELD_FRAGMENT_SHADER);
            // p5 1.11.8 reports compile errors but does not throw. Check its result
            // explicitly so a black/invalid frame cannot dismiss the loading mask.
            const compiled = shader as p5.Shader & { init(): unknown; _glProgram: WebGLProgram | null };
            if (!compiled.init() || !compiled._glProgram || !gl.getProgramParameter(compiled._glProgram, gl.LINK_STATUS)) {
              throw new Error("Cover shader compilation failed.");
            }
            initialized = true;
            if (document.hidden) p.noLoop();
          } catch { fail(); }
        };
        p.draw = () => renderFrame();
      }, host);
      // A synchronous setup failure can occur before p5 finishes its constructor.
      if (disposed) created.remove();
    } catch { fail(); }
  }

  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", updatePlayback);
  motion.addEventListener("change", updatePlayback);
  // Before load, p5 cannot fully remove its own listeners without a canvas.
  // Wait outside p5 so an early exit only needs to cancel this one listener.
  if (document.readyState === "complete") startSketch();
  else window.addEventListener("load", startSketch, { once: true });

  return {
    dispose,
    setFrozen(value) {
      if (disposed || frozen === value) return;
      frozen = value;
      updatePlayback();
    },
  };
}
