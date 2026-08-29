import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortalThemeProvider, ThemeToggle } from "./PortalTheme";

describe("PortalThemeProvider", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); document.documentElement.removeAttribute("data-portal-theme"); });

  it("defaults to dark even when the initial storage read is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    render(<PortalThemeProvider><ThemeToggle /></PortalThemeProvider>);
    expect(document.documentElement).toHaveAttribute("data-portal-theme", "dark");
    const toggle = screen.getByRole("button", { name: "切换为浅色" });
    expect(toggle).toHaveTextContent("浅色");
    fireEvent.click(toggle);
    expect(document.documentElement).toHaveAttribute("data-portal-theme", "light");
  });

  it("shares changes from another tab without replacing mounted children or their focus", () => {
    render(<PortalThemeProvider><ThemeToggle /><input aria-label="草稿" defaultValue="保留内容" /></PortalThemeProvider>);
    const input = screen.getByRole("textbox");
    act(() => input.focus());
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "plugin-portal.theme", newValue: "light" })));
    expect(document.documentElement).toHaveAttribute("data-portal-theme", "light");
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("保留内容");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "another-key", newValue: "dark" })));
    expect(document.documentElement).toHaveAttribute("data-portal-theme", "light");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "plugin-portal.theme", newValue: "invalid" })));
    expect(document.documentElement).toHaveAttribute("data-portal-theme", "dark");
  });

  it("restores the previous root attribute and removes its listener on unmount", () => {
    document.documentElement.setAttribute("data-portal-theme", "light");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<PortalThemeProvider><ThemeToggle /></PortalThemeProvider>);
    expect(document.documentElement).toHaveAttribute("data-portal-theme", "dark");
    unmount();
    expect(document.documentElement).toHaveAttribute("data-portal-theme", "light");
    expect(remove).toHaveBeenCalledWith("storage", expect.any(Function));
  });
});
