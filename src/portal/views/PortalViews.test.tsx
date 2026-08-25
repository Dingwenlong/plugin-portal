import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ExtensionsView,
  McpView,
  OverviewView,
  PromptsView,
  ReleasesView,
  RulesView,
  SkillsView,
} from "./PortalViews";

const snapshot = {
  schemaVersion: "1.0.0" as const,
  plugin: {
    target: "company-dev",
    id: "sample-plugin",
    name: "示例插件",
    version: "1.2.3",
    summary: "公开说明",
  },
  skills: [{ id: "sample-skill", name: "示例技能", description: "完成示例工作。" }],
  mcp: [{ id: "sample-mcp" }],
  extensionTools: [
    { id: "allure", name: "Allure Report", purpose: "查看测试结果。", url: "https://example.com" },
  ],
  engineeringRules: [
    { path: "rules/public.md", bodyMarkdown: "# 公开规范\n\n只读正文。\n\n<script>blocked</script>" },
  ],
  provenance: {
    packageDigest: `sha256:${"a".repeat(64)}`,
    adapterVersion: "1.0.0",
    importedAt: "2026-08-25T00:00:00Z",
  },
};

describe("snapshot views", () => {
  it("renders Skills, MCP and extension purposes without implementation statistics", () => {
    const { rerender } = render(<SkillsView snapshot={snapshot} />);
    expect(screen.getByText("示例技能")).toBeInTheDocument();
    expect(screen.queryByText(/工具数量|transport|timeout/i)).not.toBeInTheDocument();

    rerender(<McpView snapshot={snapshot} />);
    expect(screen.getByText("sample-mcp")).toBeInTheDocument();

    rerender(<ExtensionsView snapshot={snapshot} />);
    expect(screen.getByText("查看测试结果。")).toBeInTheDocument();
  });

  it("renders approved Markdown as safe elements rather than HTML", () => {
    render(<RulesView snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "rules/public.md" }));

    expect(screen.getByRole("heading", { name: "公开规范" })).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>blocked</script>")).toBeInTheDocument();
  });

  it("shows the imported version and workflow hierarchy", () => {
    const { rerender } = render(<ReleasesView snapshot={snapshot} />);
    expect(screen.getByText("v1.2.3")).toBeInTheDocument();

    rerender(
      <OverviewView
        workflow={{
          revision: 1,
          pluginKey: "company-dev/sample-plugin",
          tabs: [
            {
              id: "installation",
              title: "插件安装",
              sections: [
                {
                  id: "first",
                  title: "首次安装",
                  steps: [
                    { id: "prepare", label: "准备", title: "取得插件包", description: "", next: [] },
                  ],
                },
              ],
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole("tab", { name: "插件安装" })).toBeInTheDocument();
    expect(screen.getByText("首次安装")).toBeInTheDocument();
    expect(screen.getByText("取得插件包")).toBeInTheDocument();
  });
});

describe("PromptsView", () => {
  it("adds a Prompt through the supplied revision-aware callback", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PromptsView
        document={{ revision: 3, pluginKey: "company-dev/sample-plugin", items: [] }}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新增 Prompt" }));
    fireEvent.change(screen.getByLabelText("Prompt 标题"), { target: { value: "检查设计" } });
    fireEvent.change(screen.getByLabelText("Prompt 内容"), { target: { value: "检查字段与回应码。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Prompt" }));

    expect(onSave).toHaveBeenCalledWith(3, [
      expect.objectContaining({ title: "检查设计", content: "检查字段与回应码。" }),
    ]);
  });

  it("edits and deletes an existing Prompt without crossing plugin ownership", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PromptsView
        document={{
          revision: 4,
          pluginKey: "company-dev/sample-plugin",
          items: [{ id: "check", title: "检查设计", content: "旧内容" }],
        }}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑 检查设计" }));
    fireEvent.change(screen.getByLabelText("Prompt 内容"), { target: { value: "新内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Prompt" }));
    expect(onSave).toHaveBeenLastCalledWith(4, [
      { id: "check", title: "检查设计", content: "新内容" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "删除 检查设计" }));
    expect(onSave).toHaveBeenLastCalledWith(4, []);
  });
});
