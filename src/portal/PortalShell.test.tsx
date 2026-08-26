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

    fireEvent.click(screen.getByRole("button", { name: "纳入插件" }));
    expect(screen.getByRole("dialog", { name: "纳入插件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择插件目录" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "纳入插件" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "管理 研发助手插件" }));
    expect(await screen.findByRole("dialog", { name: "管理 研发助手插件" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "刷新或回滚插件" })).toBeInTheDocument();
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
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "配置流程" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
