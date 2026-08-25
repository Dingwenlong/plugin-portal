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
          title: pluginKey.endsWith("yusheng-inc") ? "昱勝 Prompt" : "研发 Prompt",
          content: "内容",
        },
      ],
    }),
    savePrompts: async (pluginKey, _revision, items) => ({ revision: 2, pluginKey, items }),
    getWorkflows: async (pluginKey) => ({ revision: 0, pluginKey, tabs: [] }),
    saveWorkflows: async (_pluginKey, _revision, workflow) => ({ revision: 1, ...workflow }),
  };
}

describe("PortalShell", () => {
  it("keeps plugin-owned Prompts isolated while switching plugin", async () => {
    render(
      <PortalShell
        client={createClient()}
        initialHash="#/plugins/yusheng-inc/prompts"
      />,
    );

    expect(await screen.findByText("昱勝 Prompt")).toBeInTheDocument();
    expect(screen.queryByText("研发 Prompt")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("当前插件"), {
      target: { value: "project-delivery-hub" },
    });

    await waitFor(() => expect(screen.getByText("研发 Prompt")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Prompts" })).toHaveAttribute(
      "href",
      "#/plugins/project-delivery-hub/prompts",
    );
  });
});
