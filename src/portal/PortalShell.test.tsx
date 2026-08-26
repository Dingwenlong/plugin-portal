import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PortalShell, type PortalDataClient } from "./PortalShell";

function createClient(): PortalDataClient {
  const plugins = [
    {
      pluginKey: "company-dev/project-delivery-hub",
      id: "project-delivery-hub",
      name: "研发助手插件",
      version: "3.7.17",
      summary: "研发说明",
    },
    {
      pluginKey: "company-dev/yusheng-inc",
      id: "yusheng-inc",
      name: "昱勝 Inc",
      version: "1.1.4",
      summary: "昱勝说明",
    },
  ];
  return {
    listPlugins: async () => ({ revision: 2, items: plugins }),
    getSnapshot: async (pluginKey) => ({
      schemaVersion: "1.0.0",
      plugin: {
        target: "company-dev",
        id: pluginKey.split("/")[1],
        name: plugins.find((item) => item.pluginKey === pluginKey)!.name,
        version: plugins.find((item) => item.pluginKey === pluginKey)!.version,
        summary: "公开说明",
      },
      skills: [],
      mcp: [],
      extensionTools: [],
      engineeringRules: [],
      provenance: {
        packageDigest: `sha256:${"a".repeat(64)}`,
        adapterVersion: "1.0.0",
        importedAt: "2026-08-25T00:00:00Z",
      },
    }),
    getDownloadInfo: async (pluginKey) => ({
      available: pluginKey.endsWith("project-delivery-hub"),
      version: plugins.find((item) => item.pluginKey === pluginKey)!.version,
      href: pluginKey.endsWith("project-delivery-hub")
        ? "http://127.0.0.1:9134/downloads/project-delivery-hub-3.7.17-company-dev.zip"
        : null,
    }),
    getPrompts: async (pluginKey) => ({
      revision: 1,
      pluginKey,
      items: [
        {
          id: pluginKey.endsWith("yusheng-inc") ? "ys" : "pdh",
          scenario: pluginKey.endsWith("yusheng-inc") ? "昱勝 Prompt" : "研发 Prompt",
          content: "内容",
          createdAt: "2026-08-26T00:00:00Z",
        },
      ],
    }),
    savePrompts: async (pluginKey, _revision, items) => ({ revision: 2, pluginKey, items }),
    getWorkflows: async (pluginKey) => ({ revision: 0, pluginKey, tabs: [] }),
    saveWorkflows: async (_pluginKey, _revision, workflow) => ({ revision: 1, ...workflow }),
    selectPluginDirectory: async () => ({ selected: false }),
    previewImport: async () => { throw new Error("not used"); },
    promote: async () => { throw new Error("not used"); },
    rollback: async () => { throw new Error("not used"); },
  };
}

describe("PortalShell", () => {
  it("keeps the original cover as the canonical root entry", async () => {
    const { container } = render(
      <PortalShell
        client={createClient()}
        initialHash="#/"
      />,
    );

    expect(await screen.findByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(container.querySelector(".hub-cover")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "纳入插件" })).not.toBeInTheDocument();
  });

  it("adds plugin inclusion only to the original Hub page", async () => {
    render(
      <PortalShell
        client={createClient()}
        initialHash="#/hub"
      />,
    );

    expect(await screen.findByRole("button", { name: "纳入插件" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "研发助手插件" })).toHaveAttribute(
      "href",
      "#/plugins/project-delivery-hub/overview",
    );
    expect(screen.getByRole("link", { name: "昱勝 Inc" })).toHaveAttribute(
      "href",
      "#/plugins/yusheng-inc/overview",
    );
    expect(screen.queryByLabelText("插件管理")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /^管理 / })).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "纳入插件" }));
    expect(screen.getByRole("dialog", { name: "纳入插件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择插件目录" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "纳入插件" })).not.toBeInTheDocument();
  });

  it("turns each plugin page into a single-plugin site without management or switching", async () => {
    const { rerender } = render(
      <PortalShell
        client={createClient()}
        initialHash="#/plugins/yusheng-inc/prompts"
      />,
    );

    expect(await screen.findByText("昱勝 Prompt")).toBeInTheDocument();
    expect(screen.queryByText("研发 Prompt")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("当前插件")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理插件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "鸟瞰全景" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "昱勝 Inc" })).toHaveAttribute(
      "href",
      "#/plugins/yusheng-inc/overview",
    );

    rerender(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/prompts" />);
    await waitFor(() => expect(screen.getByText("研发 Prompt")).toBeInTheDocument());
    expect(screen.queryByText("昱勝 Prompt")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Prompts" })).toHaveAttribute(
      "href",
      "#/plugins/project-delivery-hub/prompts",
    );
  });

  it("opens workflow configuration as a dialog from the overview only", async () => {
    render(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/overview" />);
    const trigger = await screen.findByRole("button", { name: "配置流程" });
    expect(trigger.closest(".portal-header-actions")).not.toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "配置流程" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("restores the plugin brand, navigation icons and overview download action", async () => {
    const { container } = render(
      <PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/overview" />,
    );

    const brand = await screen.findByRole("link", { name: "研发助手插件" });
    const brandImage = brand.querySelector("img");
    expect(brandImage).not.toBeNull();
    fireEvent.error(brandImage!);
    expect(brand.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Skills" }).querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Prompts" }).querySelector("svg")).not.toBeNull();
    expect(container.querySelectorAll("nav[aria-label='插件内容'] svg")).toHaveLength(6);
    expect(await screen.findByRole("link", { name: "下载最新版 v3.7.17" })).toBeInTheDocument();
  });

  it("keeps a delayed download probe after the main plugin content renders", async () => {
    let resolveDownload!: (value: {
      available: boolean;
      version: string;
      href: string | null;
    }) => void;
    const client = {
      ...createClient(),
      getDownloadInfo: () => new Promise((resolve) => { resolveDownload = resolve; }),
    } satisfies PortalDataClient;

    render(<PortalShell client={client} initialHash="#/plugins/project-delivery-hub/overview" />);

    expect(await screen.findByRole("button", { name: "下载最新版 v3.7.17" })).toBeDisabled();
    resolveDownload({
      available: true,
      version: "3.7.17",
      href: "http://127.0.0.1:9134/downloads/project-delivery-hub-3.7.17-company-dev.zip",
    });

    expect(await screen.findByRole("link", { name: "下载最新版 v3.7.17" })).toBeInTheDocument();
  });

  it("shows the same verified download action on releases", async () => {
    render(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/releases" />);

    expect(await screen.findByRole("link", { name: "下载最新版 v3.7.17" })).toBeInTheDocument();
  });

  it("does not expose a broken download link when the formal package is unavailable", async () => {
    render(<PortalShell client={createClient()} initialHash="#/plugins/yusheng-inc/releases" />);

    const unavailable = await screen.findByRole("button", { name: "下载最新版 v1.1.4" });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveAttribute("title", "该插件未提供可下载版本");
    expect(screen.queryByRole("link", { name: "下载最新版 v1.1.4" })).not.toBeInTheDocument();
  });
});
