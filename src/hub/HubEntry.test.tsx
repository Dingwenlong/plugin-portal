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

    fireEvent.click(screen.getByTestId("finish-cover-render"));

    expect(overlay).toHaveAttribute("data-ready", "true");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(start).toBeEnabled();
  });
});
