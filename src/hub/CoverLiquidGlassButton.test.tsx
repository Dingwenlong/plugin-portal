import { createRef } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderer = vi.hoisted(() => ({
  create: vi.fn(),
  prepareScale: vi.fn(),
  stop: vi.fn(),
  options: undefined as undefined | {
    canvas: HTMLCanvasElement;
    getTarget: () => { params: { speed: number; style: string } };
    onError: (error: Error) => void;
    onReady: () => void;
  },
}));

vi.mock("./orb/upstream/orb-renderer", () => ({
  createOrbRenderer: renderer.create,
}));

import {
  CoverLiquidGlassButton,
  type CoverLiquidGlassButtonHandle,
} from "./CoverLiquidGlassButton";

beforeEach(() => {
  vi.useFakeTimers();
  renderer.stop.mockReset();
  renderer.prepareScale.mockReset().mockResolvedValue(true);
  renderer.options = undefined;
  renderer.create.mockReset().mockImplementation((options) => {
    renderer.options = options;
    return { prepareScale: renderer.prepareScale, stop: renderer.stop };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Liquid Orb Start initialization lifetime", () => {
  it("keeps the Canvas hidden and inactive until the requested orb draws its first frame", () => {
    const onClick = vi.fn();
    const { container } = render(
      <CoverLiquidGlassButton onClick={onClick}>Start</CoverLiquidGlassButton>,
    );
    const button = container.querySelector<HTMLButtonElement>("[data-cover-liquid-glass-button]")!;
    const canvas = container.querySelector<HTMLCanvasElement>("[data-cover-liquid-glass-canvas]")!;

    expect(renderer.create).toHaveBeenCalledOnce();
    expect(renderer.options?.canvas).toBe(canvas);
    expect(renderer.options?.getTarget()).toMatchObject({
      state: "thinking",
      params: { style: "particleRibbon", speed: 0.72 },
    });
    expect(button).toHaveAttribute("data-render-state", "loading");
    expect(button).toHaveAttribute("data-renderer", "lersent-orb-particle-ribbon");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-hidden", "true");
    expect(button).toHaveTextContent("");
    expect(canvas).toHaveAttribute("data-orb-style", "particleRibbon");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    act(() => renderer.options?.onReady());

    expect(button).toHaveAttribute("data-render-state", "ready");
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-hidden");
    expect(button).toHaveTextContent("Start");
    expect(canvas).toHaveAttribute("data-rendered-frame", "1");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("stays hidden when the orb renderer fails", () => {
    const { container } = render(
      <CoverLiquidGlassButton onClick={() => undefined}>Start</CoverLiquidGlassButton>,
    );

    act(() => renderer.options?.onError(new Error("adapter unavailable")));

    const button = container.querySelector("[data-cover-liquid-glass-button]");
    expect(button).toHaveAttribute("data-render-state", "failed");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-hidden", "true");
    expect(button).toHaveTextContent("");
    expect(renderer.stop).toHaveBeenCalledOnce();
  });

  it("times out, ignores a late first frame and releases the renderer", () => {
    const { container } = render(
      <CoverLiquidGlassButton onClick={() => undefined}>Start</CoverLiquidGlassButton>,
    );
    const button = container.querySelector("[data-cover-liquid-glass-button]");

    act(() => vi.advanceTimersByTime(10_000));
    expect(button).toHaveAttribute("data-render-state", "failed");
    expect(renderer.stop).toHaveBeenCalledOnce();

    act(() => renderer.options?.onReady());
    expect(button).toHaveAttribute("data-render-state", "failed");
    expect(button).toHaveTextContent("");
  });

  it("releases the renderer when the cover unmounts", () => {
    const { unmount } = render(
      <CoverLiquidGlassButton onClick={() => undefined}>Start</CoverLiquidGlassButton>,
    );

    unmount();

    expect(renderer.stop).toHaveBeenCalledOnce();
  });

  it("exposes transition scale preparation without recreating the renderer", async () => {
    const ref = createRef<CoverLiquidGlassButtonHandle>();
    render(
      <CoverLiquidGlassButton ref={ref} onClick={() => undefined}>Start</CoverLiquidGlassButton>,
    );
    act(() => renderer.options?.onReady());

    await expect(ref.current?.prepareScale(7.25)).resolves.toBe(true);
    expect(renderer.prepareScale).toHaveBeenCalledExactlyOnceWith(7.25);
    expect(renderer.create).toHaveBeenCalledOnce();
  });
});
