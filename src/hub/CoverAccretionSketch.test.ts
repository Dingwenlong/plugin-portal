import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coverAccretionBackingSize, mountAccretionSketch } from "./CoverAccretionSketch";

const fake = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("p5", () => ({
  default: class {
    constructor(sketch: (p: unknown) => void, host: HTMLElement) {
      const p = fake.create(host);
      sketch(p);
      return p;
    }
  },
}));

function setup() {
  const host = document.createElement("div");
  document.body.append(host);
  const canvas = document.createElement("canvas");
  const bufferCanvas = document.createElement("canvas");
  const gl = {
    LINK_STATUS: 1, NO_ERROR: 0,
    getProgramParameter: vi.fn(() => true),
    isContextLost: vi.fn(() => false),
    getError: vi.fn(() => 0),
    getExtension: vi.fn(() => ({ loseContext })),
  };
  const loseContext = vi.fn();
  const shader = { init: vi.fn(() => ({})), _glProgram: {}, setUniform: vi.fn() };
  const buffer = {
    canvas: bufferCanvas, drawingContext: gl,
    createShader: vi.fn(() => shader), shader: vi.fn(), rect: vi.fn(),
    resizeCanvas: vi.fn(), remove: vi.fn(),
  };
  const p = {
    width: 0, height: 0, mouseX: 0, mouseY: 0, WEBGL: "webgl",
    setup: () => undefined, draw: () => undefined,
    createCanvas: vi.fn((w: number, h: number) => {
      p.width = canvas.width = w; p.height = canvas.height = h;
      host.append(canvas);
      return { elt: canvas };
    }),
    pixelDensity: vi.fn(), noStroke: vi.fn(), createGraphics: vi.fn(() => buffer),
    millis: vi.fn(() => 2500),
    map: (x: number, a: number, b: number, c: number, d: number) => c + (x - a) / (b - a) * (d - c),
    image: vi.fn(), noLoop: vi.fn(), loop: vi.fn(), redraw: vi.fn(() => p.draw()),
    resizeCanvas: vi.fn((w: number, h: number) => {
      p.width = canvas.width = w; p.height = canvas.height = h;
    }),
    remove: vi.fn(() => canvas.remove()),
  };
  fake.create.mockReturnValue(p);
  const options = { frozen: false, onFrame: vi.fn(), onFailure: vi.fn(), onAnimationState: vi.fn() };
  const controller = mountAccretionSketch(host, options);
  return { p, buffer, shader, gl, canvas, bufferCanvas, options, controller, loseContext };
}

let motion: EventTarget & { matches: boolean };
beforeEach(() => {
  fake.create.mockReset();
  Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  motion = Object.assign(new EventTarget(), { matches: false });
  vi.spyOn(window, "matchMedia").mockReturnValue(motion as unknown as MediaQueryList);
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("p5 original sketch lifecycle", () => {
  it("cancels pending document readiness without creating a p5 instance", () => {
    Object.defineProperty(document, "readyState", { configurable: true, value: "loading" });
    const { options, controller } = setup();
    const callsBeforeLoad = fake.create.mock.calls.length;
    controller.dispose();
    window.dispatchEvent(new Event("load"));
    expect(callsBeforeLoad).toBe(0);
    expect(fake.create).not.toHaveBeenCalled();
    expect(options.onFrame).not.toHaveBeenCalled();
    expect(options.onFailure).not.toHaveBeenCalled();
  });

  it("creates one instance only after document readiness and reports a real first frame", () => {
    Object.defineProperty(document, "readyState", { configurable: true, value: "loading" });
    const { p, options, controller } = setup();
    const callsBeforeLoad = fake.create.mock.calls.length;
    window.dispatchEvent(new Event("load"));
    window.dispatchEvent(new Event("load"));
    const callsAfterLoad = fake.create.mock.calls.length;
    const framesBeforeDraw = options.onFrame.mock.calls.length;
    p.setup(); p.draw();
    controller.dispose();
    expect(callsBeforeLoad).toBe(0);
    expect(callsAfterLoad).toBe(1);
    expect(framesBeforeDraw).toBe(0);
    expect(options.onFrame).toHaveBeenCalledOnce();
    expect(options.onFailure).not.toHaveBeenCalled();
  });

  it("keeps native one-pixel-density size, the original drawing sequence and time rate", () => {
    expect(coverAccretionBackingSize(1912, 948)).toEqual({ width: 1912, height: 948 });
    expect(coverAccretionBackingSize(768, 1024)).toEqual({ width: 768, height: 1024 });
    const { p, buffer, shader, options, controller } = setup();
    p.setup();
    expect(p.pixelDensity).toHaveBeenCalledWith(1);
    expect(options.onFrame).not.toHaveBeenCalled();
    p.draw();
    expect(buffer.shader).toHaveBeenCalledWith(shader);
    expect(shader.setUniform).toHaveBeenCalledWith("iTime", 2.5);
    expect(buffer.rect).toHaveBeenCalledWith(0, 0, p.width, p.height);
    expect(p.image).toHaveBeenCalledWith(buffer, 0, 0, p.width, p.height);
    expect(buffer.rect.mock.invocationCallOrder[0]).toBeLessThan(p.image.mock.invocationCallOrder[0]);
    expect(p.image.mock.invocationCallOrder[0]).toBeLessThan(options.onFrame.mock.invocationCallOrder[0]);
    expect(options.onFrame).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it.each(["compile", "link", "draw"] as const)("fails closed on %s errors and removes both surfaces", (failure) => {
    const { p, buffer, shader, gl, options, controller, loseContext } = setup();
    if (failure === "compile") shader.init.mockReturnValue(null as never);
    if (failure === "link") gl.getProgramParameter.mockReturnValue(false);
    if (failure === "draw") p.image.mockImplementation(() => { throw new Error("draw"); });
    p.setup(); p.draw();
    expect(options.onFailure).toHaveBeenCalledOnce();
    expect(options.onFrame).not.toHaveBeenCalled();
    expect(buffer.remove).toHaveBeenCalledOnce();
    expect(p.remove).toHaveBeenCalled();
    expect(loseContext).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("resizes the main canvas and WebGL buffer before drawing", () => {
    const { p, buffer, shader, controller } = setup();
    p.setup(); p.draw();
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 844);
    window.dispatchEvent(new Event("resize"));
    expect(p.resizeCanvas).toHaveBeenLastCalledWith(390, 844, true);
    expect(buffer.resizeCanvas).toHaveBeenLastCalledWith(390, 844);
    expect(shader.setUniform).toHaveBeenCalledWith("iResolution", [390, 844]);
    expect(buffer.resizeCanvas.mock.invocationCallOrder[0]).toBeLessThan(p.image.mock.invocationCallOrder.at(-1)!);
    controller.dispose();
    vi.unstubAllGlobals();
  });

  it("checks the first frame without synchronously draining the GPU on every animation frame", () => {
    const { p, gl, bufferCanvas, options, controller } = setup();
    p.setup(); p.draw(); p.draw(); p.draw();
    expect(gl.getError).toHaveBeenCalledOnce();
    expect(options.onFrame).toHaveBeenCalledOnce();
    bufferCanvas.dispatchEvent(new Event("webglcontextlost"));
    expect(options.onFailure).toHaveBeenCalledOnce();
    p.draw();
    expect(p.image).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  it("draws a static frame in reduced motion, and resumes when the setting changes", () => {
    motion.matches = true;
    const { p, shader, options, controller } = setup();
    p.setup(); p.draw();
    expect(shader.setUniform).toHaveBeenCalledWith("iTime", 0);
    expect(p.noLoop).toHaveBeenCalled();
    expect(options.onAnimationState).toHaveBeenLastCalledWith("static");
    motion.matches = false;
    motion.dispatchEvent(new Event("change"));
    expect(p.loop).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("pauses in the background and resumes without replacing the renderer", () => {
    const { p, options, controller } = setup();
    p.setup(); p.draw();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(options.onAnimationState).toHaveBeenLastCalledWith("paused");
    p.draw();
    expect(p.image).toHaveBeenCalledOnce();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(p.loop).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("freezes on Start and does not advance time on resize or visibility changes", () => {
    const { p, shader, options, controller } = setup();
    p.setup(); p.draw();
    controller.setFrozen(true);
    p.millis.mockReturnValue(9000);
    p.draw();
    expect(p.image).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("resize"));
    expect(shader.setUniform).toHaveBeenCalledWith("iTime", 2.5);
    expect(shader.setUniform).not.toHaveBeenCalledWith("iTime", 9);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(p.loop).not.toHaveBeenCalled();
    expect(options.onAnimationState).toHaveBeenLastCalledWith("frozen");
    controller.dispose();
  });

  it("removes listeners, graphics and loops, and rejects callbacks after disposal", () => {
    const { p, buffer, bufferCanvas, options, controller, loseContext } = setup();
    p.setup(); p.draw();
    controller.dispose();
    controller.dispose();
    p.draw();
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("visibilitychange"));
    motion.dispatchEvent(new Event("change"));
    bufferCanvas.dispatchEvent(new Event("webglcontextlost"));
    expect(buffer.remove).toHaveBeenCalledOnce();
    expect(loseContext).not.toHaveBeenCalled();
    expect(p.image).toHaveBeenCalledOnce();
    expect(p.resizeCanvas).not.toHaveBeenCalled();
    expect(options.onFailure).not.toHaveBeenCalled();
  });

  it("uses p5 disposal without forcing a synchronous GPU context shutdown", () => {
    const { p, buffer, gl, controller, loseContext } = setup();
    p.setup(); p.draw();
    controller.dispose();
    expect(p.noLoop).toHaveBeenCalled();
    expect(buffer.remove).toHaveBeenCalledOnce();
    expect(p.remove).toHaveBeenCalledOnce();
    expect(gl.getExtension).not.toHaveBeenCalledWith("WEBGL_lose_context");
    expect(loseContext).not.toHaveBeenCalled();
  });

  it("rejects a late p5 setup after disposal", () => {
    const { p, options, controller } = setup();
    controller.dispose();
    p.setup(); p.draw();
    expect(p.createCanvas).not.toHaveBeenCalled();
    expect(options.onFrame).not.toHaveBeenCalled();
  });
});
