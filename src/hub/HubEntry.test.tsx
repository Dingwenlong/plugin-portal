import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HubEntry } from "./HubEntry";

vi.mock("./CoverAccretionBackground", () => ({
  CoverAccretionBackground: ({ onReady }: { onReady?: () => void }) => (
    <button data-testid="finish-cover-render" onClick={onReady} type="button">完成背景渲染</button>
  ),
}));

describe("HubEntry cover loading", () => {
  it("blocks Start behind a loading mask until the cover background is ready", () => {
    const { container } = render(
      <HubEntry
        catalog={{ revision: 0, items: [] }}
        client={{
          selectPluginDirectory: vi.fn(),
          previewImport: vi.fn(),
          promote: vi.fn(),
          rollback: vi.fn(),
        }}
        route="cover"
        onNavigate={vi.fn()}
        onCatalogChanged={vi.fn()}
      />,
    );

    const overlay = container.querySelector("[data-cover-loading-overlay]");
    expect(overlay).not.toBeNull();
    const start = screen.getByRole("button", { name: "Start" });
    expect(overlay).toHaveAttribute("data-ready", "false");
    expect(overlay).toHaveAttribute("aria-hidden", "false");
    expect(start).toBeDisabled();
    expect(container.querySelector("[data-cover-liquid-glass-canvas]")).toBeNull();

    fireEvent.click(screen.getByTestId("finish-cover-render"));

    expect(overlay).toHaveAttribute("data-ready", "true");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect(container.querySelector("[data-cover-liquid-glass-canvas]")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Accretion by Xor — jcponcemath" })).toHaveAttribute(
      "href", "https://openprocessing.org/@jcponcemath/2696126",
    );
    expect(screen.getByRole("link", { name: "CC BY-NC-SA 3.0" })).toHaveAttribute(
      "href", "https://creativecommons.org/licenses/by-nc-sa/3.0/",
    );
  });

  it("does not mount cover resources on a direct Hub visit", () => {
    render(<HubEntry
      catalog={{ revision: 0, items: [] }}
      client={{ selectPluginDirectory: vi.fn(), previewImport: vi.fn(), promote: vi.fn(), rollback: vi.fn() }}
      route="hub"
      onNavigate={vi.fn()}
      onCatalogChanged={vi.fn()}
    />);
    expect(screen.queryByTestId("finish-cover-render")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "纳入插件" })).toBeVisible();
  });
});
