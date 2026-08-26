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
    const { container, rerender } = render(<SkillsView snapshot={snapshot} />);
    expect(screen.getByText("sample-skill")).toBeInTheDocument();
    expect(container.querySelector("td small")).toHaveTextContent("示例技能");
    expect(screen.queryByText(/工具数量|transport|timeout/i)).not.toBeInTheDocument();

    rerender(<McpView snapshot={snapshot} />);
    expect(screen.getByText("sample-mcp")).toBeInTheDocument();

    rerender(<ExtensionsView snapshot={snapshot} />);
    expect(screen.getByText("查看测试结果。")).toBeInTheDocument();
  });

  it("never substitutes the purpose for a missing Chinese skill name", () => {
    const migrated = {
      ...snapshot,
      skills: [{ id: "code-development", name: "code-development", description: "业务代码开发与修复。" }],
    };

    const { container } = render(<SkillsView snapshot={migrated} />);
    expect(container.querySelector("td small")).toBeNull();
    expect(screen.getByText("业务代码开发与修复。")).toBeInTheDocument();
    expect(screen.getAllByText("业务代码开发与修复。")).toHaveLength(1);
  });

  it("orders Skills by ID without mutating the plugin snapshot", () => {
    const unordered = {
      ...snapshot,
      skills: [
        { id: "code-development", name: "业务代码开发", description: "处理业务代码。" },
        { id: "delivery-hub-navigator", name: "先锋", description: "选择交付路径。" },
        { id: "api-test-db-fixture-preparer", name: "测试库资料准备", description: "准备测试资料。" },
      ],
    };

    const { container } = render(<SkillsView snapshot={unordered} />);
    const renderedIDs = Array.from(container.querySelectorAll("tbody tr strong"), (node) => node.textContent);

    expect(renderedIDs).toEqual([
      "api-test-db-fixture-preparer",
      "code-development",
      "delivery-hub-navigator",
    ]);
    expect(unordered.skills.map((skill) => skill.id)).toEqual([
      "code-development",
      "delivery-hub-navigator",
      "api-test-db-fixture-preparer",
    ]);
  });

  it("shows an extension tool ID only when the public name is Chinese", () => {
    const tools = {
      ...snapshot,
      extensionTools: [
        { id: "sonarqube", name: "SonarQube", purpose: "检查代码质量。", url: "https://example.com/sonarqube" },
        { id: "allure-report", name: "测试报告", purpose: "查看测试结果。", url: "https://example.com/allure" },
      ],
    };

    const { container } = render(<ExtensionsView snapshot={tools} />);

    expect(screen.getByText("SonarQube")).toBeInTheDocument();
    expect(screen.queryByText("sonarqube")).not.toBeInTheDocument();
    expect(screen.getByText("测试报告")).toBeInTheDocument();
    expect(container.querySelectorAll("td small")).toHaveLength(1);
    expect(container.querySelector("td small")).toHaveTextContent("allure-report");
  });

  it("keeps extension names wider and the resource column on one line", () => {
    render(<ExtensionsView snapshot={snapshot} />);

    const nameHeading = screen.getByRole("columnheader", { name: "名称" });
    expect(nameHeading.closest("table")).toHaveClass("extensions-table");
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
  it("reserves a wider column for common scenarios", () => {
    render(
      <PromptsView
        document={{
          revision: 4,
          pluginKey: "company-dev/sample-plugin",
          items: [{ id: "check", scenario: "检查设计", content: "检查字段。", createdAt: "2026-08-12T07:38:30.798Z" }],
        }}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "常用场景" }).closest("table")).toHaveClass("prompts-table");
  });

  it("adds a Prompt through the supplied revision-aware callback", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PromptsView
        document={{ revision: 3, pluginKey: "company-dev/sample-plugin", items: [] }}
        onSave={onSave}
      />,
    );

    const trigger = screen.getByRole("button", { name: "新增 Prompt" });
    expect(trigger).toHaveClass("portal-page-action");
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "新增 Prompt" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("常用场景"), { target: { value: "检查设计" } });
    fireEvent.change(screen.getByLabelText("Prompt 内容"), { target: { value: "检查字段与回应码。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onSave).toHaveBeenCalledWith(3, [
      expect.objectContaining({ scenario: "检查设计", content: "检查字段与回应码。", createdAt: expect.stringMatching(/Z$/) }),
    ]);
  });

  it("edits and deletes an existing Prompt without crossing plugin ownership", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PromptsView
        document={{
          revision: 4,
          pluginKey: "company-dev/sample-plugin",
          items: [{ id: "check", scenario: "检查设计", content: "旧内容", createdAt: "2026-08-12T07:38:30.798Z" }],
        }}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑 检查设计" }));
    fireEvent.change(screen.getByLabelText("Prompt 内容"), { target: { value: "新内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onSave).toHaveBeenLastCalledWith(4, [
      { id: "check", scenario: "检查设计", content: "新内容", createdAt: "2026-08-12T07:38:30.798Z" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "删除 检查设计" }));
    expect(onSave).toHaveBeenLastCalledWith(4, []);
  });

  it("closes the Prompt dialog with Escape and restores focus", async () => {
    render(<PromptsView document={{ revision: 0, pluginKey: "company-dev/sample-plugin", items: [] }} onSave={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "新增 Prompt" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "新增 Prompt" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "新增 Prompt" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
