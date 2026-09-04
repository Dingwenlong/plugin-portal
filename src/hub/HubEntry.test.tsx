import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HubEntry } from "./HubEntry";

vi.mock("./CoverAccretionBackground", () => ({
  CoverAccretionBackground: ({ onReady }: { onReady?: () => void }) => (
    <button data-testid="finish-cover-render" onClick={onReady} type="button">完成背景渲染</button>
  ),
}));

describe("HubEntry cover loading", () => {
  it("keeps Start absent and inactive until its WebGPU renderer is ready", () => {
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
    const start = container.querySelector("[data-cover-liquid-glass-button]");
    expect(status).toHaveClass("sr-only");
    expect(status).toHaveTextContent("正在加载封面");
    expect(screen.queryByText("Start")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute("aria-hidden", "true");
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
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(container.querySelector("[data-cover-liquid-glass-button]")).toBe(start);
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
    const include = screen.getByRole("button", { name: "纳入插件" });
    const heading = include.closest(".company-dev-hub-section-heading");
    expect(heading).not.toBeNull();
    const title = within(heading as HTMLElement).getByRole("heading", { level: 2, name: "插件" });
    expect(title.nextElementSibling).toBe(include);
    expect(include).not.toHaveTextContent("纳入插件");
    expect(include.querySelector("svg")).not.toBeNull();

    for (const item of catalog.items) {
      const entry = screen.getByRole("link", { name: item.name });
      const identity = entry.querySelector(".company-dev-hub-entry-identity");
      const icon = identity?.querySelector("img");
      expect(icon).toHaveAttribute("src", `/api/plugins/${encodeURIComponent(item.pluginKey)}/icon?revision=2`);
      expect(icon).toHaveAttribute("alt", "");
      expect(identity?.firstElementChild).toBe(icon);
      expect(identity?.lastElementChild).toHaveTextContent(item.name);
      expect(entry).toHaveAttribute("href", `#/plugins/${item.id}/overview`);
      expect(entry).not.toHaveTextContent("进入");
      expect(entry.querySelector(".company-dev-hub-entry-action")).toBeNull();
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
      .toHaveAttribute("src", "/api/plugins/company-dev%2Fproject-delivery-hub/icon?revision=2");
  });

  it("reloads a reused plugin icon when inclusion refreshes the catalog revision", () => {
    const client = { selectPluginDirectory: vi.fn(), previewImport: vi.fn(), promote: vi.fn(), rollback: vi.fn() };
    const props = {
      client,
      route: "hub" as const,
      onNavigate: vi.fn(),
      onCatalogChanged: vi.fn(),
    };
    const { rerender } = render(<HubEntry catalog={catalog} {...props} />);
    const entry = screen.getByRole("link", { name: "昱胜 Inc" });
    fireEvent.error(entry.querySelector("img")!);
    expect(entry.querySelector("img")).toBeNull();

    rerender(<HubEntry catalog={{ ...catalog, revision: 3 }} {...props} />);

    expect(screen.getByRole("link", { name: "昱胜 Inc" }).querySelector("img"))
      .toHaveAttribute("src", "/api/plugins/company-dev%2Fyusheng-inc/icon?revision=3");
  });

  it("offers local download publication, hides it in read-only mode, and restores trigger focus", async () => {
    const publicationClient = {
      selectPluginDirectory: vi.fn(),
      previewImport: vi.fn(),
      promote: vi.fn(),
      rollback: vi.fn(),
      selectDownloadCandidate: vi.fn().mockResolvedValue({ selected: false as const }),
      confirmDownloadPublication: vi.fn(),
    };
    const { rerender } = render(<HubEntry
      catalog={catalog}
      client={publicationClient}
      route="hub"
      onNavigate={vi.fn()}
      onCatalogChanged={vi.fn()}
    />);
    const trigger = screen.getByRole("button", { name: "发布 昱胜 Inc 下载" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "发布 昱胜 Inc 下载" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());

    rerender(<HubEntry
      catalog={catalog}
      client={publicationClient}
      readOnly
      route="hub"
      onNavigate={vi.fn()}
      onCatalogChanged={vi.fn()}
    />);
    expect(screen.queryByRole("button", { name: /发布 .* 下载/ })).not.toBeInTheDocument();
  });
});
