import type { ButtonHTMLAttributes } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderer = vi.hoisted(() => ({
  prepareScale: vi.fn(),
}));

vi.mock("./CoverAccretionBackground", () => ({
  CoverAccretionBackground: () => <div data-cover-accretion-background />,
}));

vi.mock("./CoverLiquidGlassButton", async () => {
  const React = await import("react");
  return {
    CoverLiquidGlassButton: React.forwardRef(function MockCoverLiquidGlassButton({
      children,
      className,
      disabled,
      onAnimationEnd,
      onClick,
      style,
    }: ButtonHTMLAttributes<HTMLButtonElement>, ref) {
      React.useImperativeHandle(ref, () => ({ prepareScale: renderer.prepareScale }), []);
      return <button
        className={className}
        data-cover-liquid-glass-button
        disabled={disabled}
        onAnimationEnd={onAnimationEnd}
        onClick={onClick}
        style={style}
        type="button"
      >{children}</button>;
    }),
  };
});

import { HubEntry } from "./HubEntry";

function renderCover(onNavigate = vi.fn()) {
  const result = render(<HubEntry
    catalog={{ revision: 0, items: [] }}
    client={{
      selectPluginDirectory: vi.fn(),
      previewImport: vi.fn(),
      promote: vi.fn(),
      rollback: vi.fn(),
    }}
    route="cover"
    onNavigate={onNavigate}
    onCatalogChanged={vi.fn()}
  />);
  return { ...result, onNavigate };
}

describe("HubEntry transition resolution preparation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    renderer.prepareScale.mockReset();
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("locks Start until the enlarged backing frame is ready, then runs the scaled transition", async () => {
    let resolvePreparation: (ready: boolean) => void = () => undefined;
    renderer.prepareScale.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolvePreparation = resolve;
    }));
    const { container, onNavigate } = renderCover();
    const start = screen.getByRole("button", { name: "Start" });

    fireEvent.click(start);
    expect(start).toBeDisabled();
    expect(container.querySelector("[data-hub-cover]")).toHaveAttribute("data-transition-preparing", "true");
    expect(container.querySelector("[data-hub-entry-phase]")).toHaveAttribute("data-hub-entry-phase", "idle");

    await act(async () => resolvePreparation(true));
    expect(container.querySelector("[data-hub-cover]")).toHaveAttribute("data-transition-mode", "scaled");
    expect(container.querySelector("[data-hub-entry-phase]")).toHaveAttribute("data-hub-entry-phase", "engulfing");
    expect(Number.parseFloat(start.style.getPropertyValue("--hub-entry-cover-scale"))).toBeGreaterThan(1);

    act(() => vi.advanceTimersByTime(950));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("hub");
  });

  it("uses a scale-one fade when preparation exceeds 250ms and resets the renderer", async () => {
    renderer.prepareScale
      .mockImplementationOnce(() => new Promise<boolean>(() => undefined))
      .mockResolvedValueOnce(true);
    const { container, onNavigate } = renderCover();
    const start = screen.getByRole("button", { name: "Start" });

    fireEvent.click(start);
    await act(async () => vi.advanceTimersByTime(250));

    const cover = container.querySelector("[data-hub-cover]");
    expect(cover).toHaveAttribute("data-transition-mode", "fade");
    expect(container.querySelector("[data-hub-entry-phase]")).toHaveAttribute("data-hub-entry-phase", "engulfing");
    expect(start.style.getPropertyValue("--hub-entry-cover-scale")).toBe("1");
    expect(renderer.prepareScale).toHaveBeenCalledTimes(2);
    expect(renderer.prepareScale).toHaveBeenLastCalledWith(1);

    act(() => vi.advanceTimersByTime(950));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("hub");
  });

  it("does not request enlarged textures when reduced motion is enabled", () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    const { container } = renderCover();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(renderer.prepareScale).not.toHaveBeenCalled();
    expect(container.querySelector("[data-hub-cover]")).toHaveAttribute("data-transition-mode", "fade");
    expect(container.querySelector("[data-hub-entry-phase]")).toHaveAttribute("data-hub-entry-phase", "engulfing");
  });
});
