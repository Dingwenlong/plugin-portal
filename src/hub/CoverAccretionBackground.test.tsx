import { act, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoverAccretionBackground } from "./CoverAccretionBackground";

const mock = vi.hoisted(() => ({
  mount: vi.fn(),
  dispose: vi.fn(),
  setFrozen: vi.fn(),
}));
vi.mock("./CoverAccretionSketch", () => ({ mountAccretionSketch: mock.mount }));

let callbacks: { onFrame(): void; onFailure(): void; onAnimationState(state: string): void };
beforeEach(() => {
  mock.dispose.mockReset();
  mock.setFrozen.mockReset();
  mock.mount.mockReset().mockImplementation((_host, options) => {
    callbacks = options;
    return { dispose: mock.dispose, setFrozen: mock.setFrozen };
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function loadModule() { await act(async () => { await vi.dynamicImportSettled(); }); }

describe("cover loading lifecycle", () => {
  it("does not release the mask just because the module or p5 constructor is ready", async () => {
    const onReady = vi.fn();
    const { container } = render(<CoverAccretionBackground onReady={onReady} />);
    await loadModule();
    expect(mock.mount).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
    expect(container.firstChild).toHaveAttribute("data-render-state", "loading");
    act(() => callbacks.onFrame());
    expect(container.firstChild).toHaveAttribute("data-render-state", "ready");
    expect(onReady).toHaveBeenCalledTimes(1);
    act(() => callbacks.onFrame());
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("falls back on compilation failure and ignores late frames", async () => {
    const onReady = vi.fn();
    const { container } = render(<CoverAccretionBackground onReady={onReady} />);
    await loadModule();
    act(() => callbacks.onFailure());
    expect(mock.dispose).toHaveBeenCalledOnce();
    expect(container.querySelector("canvas")).toHaveAttribute("data-render-state", "fallback");
    act(() => callbacks.onFrame());
    expect(container.firstChild).toHaveAttribute("data-render-state", "fallback");
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("releases a failed module initialization", async () => {
    mock.mount.mockImplementation(() => { throw new Error("initialization failed"); });
    const onReady = vi.fn();
    const { container } = render(<CoverAccretionBackground onReady={onReady} />);
    await loadModule();
    expect(container.firstChild).toHaveAttribute("data-render-state", "fallback");
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("stops initialization at ten seconds and does not accept a late result", async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const { container } = render(<CoverAccretionBackground onReady={onReady} />);
    await loadModule();
    act(() => vi.advanceTimersByTime(9_999));
    expect(onReady).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(mock.dispose).toHaveBeenCalledOnce();
    expect(container.firstChild).toHaveAttribute("data-render-state", "fallback");
    act(() => { callbacks.onFrame(); callbacks.onAnimationState("running"); });
    expect(container.firstChild).toHaveAttribute("data-animation-state", "static");
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("cancels the deadline after a real frame and forwards freeze without reinitializing", async () => {
    vi.useFakeTimers();
    const { container, rerender, unmount } = render(<CoverAccretionBackground />);
    await loadModule();
    act(() => callbacks.onFrame());
    rerender(<CoverAccretionBackground frozen />);
    expect(mock.setFrozen).toHaveBeenLastCalledWith(true);
    act(() => vi.advanceTimersByTime(10_001));
    expect(container.firstChild).toHaveAttribute("data-render-state", "ready");
    expect(mock.mount).toHaveBeenCalledOnce();
    unmount();
    expect(mock.dispose).toHaveBeenCalledOnce();
  });

  it("freezes before the transition is painted rather than waiting for a passive effect", async () => {
    const painted = vi.fn();
    function Cover({ frozen }: { frozen: boolean }) {
      useLayoutEffect(() => {
        if (frozen) painted(mock.setFrozen.mock.lastCall?.[0]);
      }, [frozen]);
      return <CoverAccretionBackground frozen={frozen} />;
    }
    const { rerender } = render(<Cover frozen={false} />);
    await loadModule();
    act(() => callbacks.onFrame());
    rerender(<Cover frozen />);
    expect(painted).toHaveBeenCalledWith(true);
  });

  it("does not mount a module that arrives after unmount", async () => {
    const onReady = vi.fn();
    const { unmount } = render(<CoverAccretionBackground onReady={onReady} />);
    unmount();
    await loadModule();
    expect(mock.mount).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });
});
