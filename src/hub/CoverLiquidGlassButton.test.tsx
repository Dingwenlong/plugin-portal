import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoverLiquidGlassButton } from "./CoverLiquidGlassButton";

const fallback = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock("./CoverLiquidGlassButtonFallback", () => ({
  coverLiquidGlassBackingSize: () => ({ width: 112, height: 112 }),
  startCoverLiquidGlassFallback: fallback.start,
}));

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function setupGpu() {
  const frameCallbacks: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  const pipeline = { getBindGroupLayout: vi.fn(() => ({})) };
  const device = {
    destroy: vi.fn(), addEventListener: vi.fn(),
    lost: new Promise<never>(() => undefined),
    createShaderModule: vi.fn(() => ({ getCompilationInfo: async () => ({ messages: [] }) })),
    createRenderPipelineAsync: vi.fn(async () => pipeline),
    createBuffer: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: () => ({ draw: vi.fn(), end: vi.fn(), setBindGroup: vi.fn(), setPipeline: vi.fn() }),
      finish: () => ({}),
    })),
    queue: { writeBuffer: vi.fn(), submit: vi.fn() },
  };
  const adapter = { requestDevice: vi.fn(async () => device) };
  Object.defineProperty(navigator, "gpu", { configurable: true, value: {
    requestAdapter: async () => adapter, getPreferredCanvasFormat: () => "bgra8unorm",
  } });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    configure: vi.fn(), getCurrentTexture: () => ({ createView: () => ({}) }),
  } as never);
  return { device, adapter, pipeline, frameCallbacks, getContext };
}

beforeEach(() => {
  vi.useFakeTimers();
  fallback.start.mockReset().mockImplementation(({ canvas, onReady }) => {
    canvas.dataset.renderedFrame = "1";
    onReady();
    return fallback.stop;
  });
  fallback.stop.mockReset();
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "gpu");
});
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }

describe("liquid Start initialization lifetime", () => {
  it("keeps the original async renderer after its first frame", async () => {
    const { frameCallbacks, device } = setupGpu();
    const { container, unmount } = render(<CoverLiquidGlassButton onClick={() => undefined}>Start</CoverLiquidGlassButton>);
    await settle();
    act(() => frameCallbacks.shift()?.(100));
    expect(container.firstChild).toHaveAttribute("data-render-state", "ready");
    act(() => vi.advanceTimersByTime(10_001));
    expect(fallback.start).not.toHaveBeenCalled();
    expect(device.queue.submit).toHaveBeenCalledOnce();
    unmount();
  });

  it("uses the existing Canvas fallback at ten seconds and rejects a late pipeline", async () => {
    const { device, pipeline, getContext } = setupGpu();
    const compilation = pending<typeof pipeline>();
    device.createRenderPipelineAsync.mockReturnValue(compilation.promise);
    const { container, unmount } = render(<CoverLiquidGlassButton onClick={() => undefined}>Start</CoverLiquidGlassButton>);
    await settle();
    expect(getContext).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(9_999));
    expect(fallback.start).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(container.firstChild).toHaveAttribute("data-render-state", "fallback");
    expect(fallback.start).toHaveBeenCalledOnce();
    expect(device.destroy).toHaveBeenCalledOnce();
    compilation.resolve(pipeline);
    await settle();
    expect(device.createBuffer).not.toHaveBeenCalled();
    expect(device.queue.submit).not.toHaveBeenCalled();
    expect(container.firstChild).toHaveAttribute("data-render-state", "fallback");
    unmount();
    expect(fallback.stop).toHaveBeenCalledOnce();
  });

  it("destroys a device that arrives after the initialization deadline", async () => {
    const { device, adapter } = setupGpu();
    const request = pending<typeof device>();
    adapter.requestDevice.mockReturnValue(request.promise);
    const { unmount } = render(<CoverLiquidGlassButton onClick={() => undefined}>Start</CoverLiquidGlassButton>);
    await settle();
    act(() => vi.advanceTimersByTime(10_000));
    expect(fallback.start).toHaveBeenCalledOnce();
    request.resolve(device);
    await settle();
    expect(device.destroy).toHaveBeenCalledOnce();
    expect(device.createShaderModule).not.toHaveBeenCalled();
    unmount();
  });

  it("does not render or install listeners when a pipeline resolves after unmount", async () => {
    const { device, pipeline } = setupGpu();
    const compilation = pending<typeof pipeline>();
    device.createRenderPipelineAsync.mockReturnValue(compilation.promise);
    const { unmount } = render(<CoverLiquidGlassButton onClick={() => undefined}>Start</CoverLiquidGlassButton>);
    await settle();
    unmount();
    compilation.resolve(pipeline);
    await settle();
    act(() => vi.advanceTimersByTime(10_000));
    expect(device.queue.submit).not.toHaveBeenCalled();
    expect(device.addEventListener).not.toHaveBeenCalled();
    expect(fallback.start).not.toHaveBeenCalled();
  });
});
