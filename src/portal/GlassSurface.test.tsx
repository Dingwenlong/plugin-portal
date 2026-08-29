import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlassSurface } from "./GlassSurface";
import { glassMaps } from "./glassDisplacement";

vi.mock("./glassDisplacement", () => ({ glassMaps: { get: vi.fn() } }));

describe("GlassSurface", () => {
  let width: number;
  let reduced: boolean;
  let mediaChanged: () => void;
  let resized: () => void;
  let frame: FrameRequestCallback | undefined;
  let disconnect: ReturnType<typeof vi.fn>;
  let removeMediaListener: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    width = 1440;
    reduced = false;
    frame = undefined;
    disconnect = vi.fn();
    removeMediaListener = vi.fn();
    vi.mocked(glassMaps.get).mockReset().mockReturnValue("data:image/png;base64,bWFw");
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Chrome/140.0.0.0");
    vi.stubGlobal("CSS", { supports: () => true });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe() { /* Initial measurement is synchronous. */ }
      disconnect = disconnect;
    });
    vi.spyOn(window, "matchMedia").mockImplementation(() => ({
      get matches() { return reduced; },
      addEventListener: (_event: string, listener: () => void) => { mediaChanged = listener; },
      removeEventListener: removeMediaListener,
    } as unknown as MediaQueryList));
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({
      width, height: 62, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 62, toJSON: () => ({}),
    }));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 9; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => { frame = undefined; });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const flush = () => act(() => { const pending = frame; frame = undefined; pending?.(0); });

  it("builds a noninteractive local displacement filter with separate color channels", () => {
    const { container } = render(<GlassSurface />);
    const surface = container.firstElementChild;
    const fog = container.querySelector(".portal-capsule-glass-fog");
    const refraction = container.querySelector<HTMLElement>(".portal-capsule-glass-refraction");
    expect(glassMaps.get).toHaveBeenCalledExactlyOnceWith(1440, 62);
    expect(surface).toHaveAttribute("data-glass-mode", "refractive");
    expect(surface).toHaveAttribute("aria-hidden", "true");
    expect(fog).not.toBeNull();
    expect(refraction).not.toBeNull();
    expect(refraction?.style.backdropFilter).toContain(`url("#capsule-glass-`);
    expect((surface as HTMLElement).style.backdropFilter).toBe("");
    expect(container.querySelectorAll("feDisplacementMap")).toHaveLength(3);
    expect(container.querySelector("feImage")).toHaveAttribute("href", "data:image/png;base64,bWFw");
    expect(container.querySelector("button, a, nav")).toBeNull();
  });

  it("coalesces resize measurements and reuses the map while scrolling", () => {
    const { container } = render(<GlassSurface />);
    act(() => { resized(); resized(); });
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    flush();
    expect(glassMaps.get).toHaveBeenCalledTimes(1);
    width = 800;
    act(() => resized());
    flush();
    expect(glassMaps.get).toHaveBeenLastCalledWith(800, 62);
    expect(container.querySelector("filter")).toHaveAttribute("width", "800");
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(glassMaps.get).toHaveBeenCalledTimes(2);
    expect(frame).toBeUndefined();
  });

  it("uses clear glass for reduced motion and responds to a preference change", () => {
    reduced = true;
    const { container } = render(<GlassSurface />);
    expect(container.firstElementChild).toHaveAttribute("data-glass-mode", "clear");
    expect(container.querySelector(".portal-capsule-glass-fog")).not.toBeNull();
    expect(container.querySelector(".portal-capsule-glass-refraction")).toBeNull();
    expect(glassMaps.get).not.toHaveBeenCalled();
    reduced = false;
    act(() => mediaChanged());
    flush();
    expect(container.firstElementChild).toHaveAttribute("data-glass-mode", "refractive");
    reduced = true;
    act(() => mediaChanged());
    flush();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector(".portal-capsule-glass-fog")).not.toBeNull();
    expect(container.querySelector(".portal-capsule-glass-refraction")).toBeNull();
    expect(container.firstElementChild).toHaveAttribute("data-glass-mode", "clear");
  });

  it.each(["browser", "filter", "observer"])("uses clear glass when %s support is absent", (missing) => {
    if (missing === "browser") vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Version/18.0 Safari/605.1.15");
    if (missing === "filter") vi.stubGlobal("CSS", { supports: () => false });
    if (missing === "observer") vi.stubGlobal("ResizeObserver", undefined);
    const { container } = render(<GlassSurface />);
    expect(container.firstElementChild).toHaveAttribute("data-glass-mode", "clear");
    expect(glassMaps.get).not.toHaveBeenCalled();
  });

  it("fails safely when map allocation fails and can recover on a later resize", () => {
    vi.mocked(glassMaps.get).mockImplementationOnce(() => { throw new Error("unavailable canvas"); });
    const { container } = render(<GlassSurface />);
    expect(container.firstElementChild).toHaveAttribute("data-glass-mode", "clear");
    width = 1000;
    act(() => resized());
    flush();
    expect(container.firstElementChild).toHaveAttribute("data-glass-mode", "refractive");
  });

  it("cancels scheduled work, disconnects observers and ignores callbacks after unmount", () => {
    const { unmount } = render(<GlassSurface />);
    act(() => resized());
    const lateFrame = frame;
    unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(9);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(removeMediaListener).toHaveBeenCalledWith("change", expect.any(Function));
    act(() => { lateFrame?.(0); resized(); mediaChanged(); });
    expect(glassMaps.get).toHaveBeenCalledTimes(1);
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
});
