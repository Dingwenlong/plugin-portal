import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import App from "./App";

const plugins = [
  { id: "project-delivery-hub", name: "研发助手插件" },
  { id: "yusheng-inc", name: "昱勝 Inc" },
];

describe("App", () => {
  it("renders the seven fixed pages", () => {
    render(<App plugins={plugins} initialHash="#/plugins/project-delivery-hub/overview" />);

    for (const name of ["鸟瞰全景", "Skills", "Prompts", "MCP", "扩展工具", "工程规范", "版本沿革"]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
  });

  it("uses content-owner-specific empty states", () => {
    const { rerender } = render(
      <App plugins={plugins} initialHash="#/plugins/project-delivery-hub/skills" />,
    );
    expect(screen.getByText("该插件未提供 Skills")).toBeInTheDocument();

    rerender(<App plugins={plugins} initialHash="#/plugins/project-delivery-hub/prompts" />);
    expect(screen.getByText("尚未添加 Prompt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增 Prompt" })).toBeInTheDocument();
  });

  it("changes plugin while preserving the current page", () => {
    render(<App plugins={plugins} initialHash="#/plugins/project-delivery-hub/mcp" />);

    fireEvent.change(screen.getByLabelText("当前插件"), { target: { value: "yusheng-inc" } });

    expect(screen.getByRole("link", { name: "MCP" })).toHaveAttribute(
      "href",
      "#/plugins/yusheng-inc/mcp",
    );
    expect(screen.getByRole("heading", { name: "昱勝 Inc" })).toBeInTheDocument();
  });
});
