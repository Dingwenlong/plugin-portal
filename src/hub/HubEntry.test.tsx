import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HubEntry } from "./HubEntry";

vi.mock("./CoverAccretionBackground", () => ({
  CoverAccretionBackground: ({ onReady }: { onReady?: () => void }) => (
    <button data-testid="finish-cover-render" onClick={onReady} type="button">完成背景渲染</button>
  ),
}));

describe("HubEntry cover loading", () => {
  it("shows and activates Start immediately without a visual loading mask", () => {
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

    const status = container.querySelector("[data-cover-loading-status]");
    expect(status).not.toBeNull();
    const start = screen.getByRole("button", { name: "Start" });
    expect(status).toHaveClass("sr-only");
    expect(status).toHaveTextContent("正在加载封面");
    expect(start).toBeVisible();
    expect(start).toBeEnabled();
    expect(container.querySelector("[data-cover-liquid-glass-canvas]")).not.toBeNull();

    const attribution = container.querySelector(".hub-cover-attribution");
    expect(attribution).not.toBeNull();
    expect(attribution).toHaveClass("sr-only");
    expect(screen.getByRole("link", { name: "Accretion by Xor — jcponcemath" })).toHaveAttribute(
      "href", "https://openprocessing.org/@jcponcemath/2696126",
    );
    expect(screen.getByRole("link", { name: "CC BY-NC-SA 3.0" })).toHaveAttribute(
      "href", "https://creativecommons.org/licenses/by-nc-sa/3.0/",
    );

    fireEvent.click(screen.getByTestId("finish-cover-render"));

    expect(container.querySelector("[data-cover-loading-status]")).toBeNull();
    expect(screen.getByRole("button", { name: "Start" })).toBe(start);
    expect(container.querySelector("[data-cover-liquid-glass-canvas]")).not.toBeNull();
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

describe("HubEntry plugin icons", () => {
  const catalog = {
    revision: 2,
    items: [
      { pluginKey: "company-dev/project-delivery-hub", id: "project-delivery-hub", name: "研发助手插件", version: "1.0.0", summary: "" },
      { pluginKey: "company-dev/yusheng-inc", id: "yusheng-inc", name: "昱胜 Inc", version: "1.0.0", summary: "" },
    ],
  };

  function renderHub() {
    return render(<HubEntry
      catalog={catalog}
      client={{ selectPluginDirectory: vi.fn(), previewImport: vi.fn(), promote: vi.fn(), rollback: vi.fn() }}
      route="hub"
      onNavigate={vi.fn()}
      onCatalogChanged={vi.fn()}
    />);
  }

  it("shows each plugin's local icon before its name without changing the entry link", () => {
    renderHub();
    for (const item of catalog.items) {
      const entry = screen.getByRole("link", { name: item.name });
      const identity = entry.querySelector(".company-dev-hub-entry-identity");
      const icon = identity?.querySelector("img");
      expect(icon).toHaveAttribute("src", `/api/plugins/${encodeURIComponent(item.pluginKey)}/icon`);
      expect(icon).toHaveAttribute("alt", "");
      expect(identity?.firstElementChild).toBe(icon);
      expect(identity?.lastElementChild).toHaveTextContent(item.name);
      expect(entry).toHaveAttribute("href", `#/plugins/${item.id}/overview`);
      expect(entry).toHaveTextContent("进入");
    }
  });

  it("uses a decorative fallback for a missing icon without affecting other entries", () => {
    renderHub();
    const entry = screen.getByRole("link", { name: "昱胜 Inc" });
    const icon = entry.querySelector("img");
    expect(icon).not.toBeNull();
    fireEvent.error(icon!);
    expect(entry.querySelector("img")).toBeNull();
    expect(entry.querySelector(".portal-brand-fallback")).toHaveAttribute("aria-hidden", "true");
    expect(entry).toHaveAttribute("href", "#/plugins/yusheng-inc/overview");
    expect(screen.getByRole("link", { name: "研发助手插件" }).querySelector("img"))
      .toHaveAttribute("src", "/api/plugins/company-dev%2Fproject-delivery-hub/icon");
  });
});
