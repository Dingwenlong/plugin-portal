import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkflowEditor } from "./WorkflowEditor";

const emptyWorkflow = {
  revision: 0,
  pluginKey: "company-dev/sample-plugin",
  tabs: [],
};

describe("WorkflowEditor", () => {
  it("creates Tab, section and steps with an explicit next edge", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowEditor document={emptyWorkflow} onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "新增 Tab" }));
    fireEvent.change(screen.getByLabelText("Tab 标题"), { target: { value: "插件安装" } });
    fireEvent.click(screen.getByRole("button", { name: "新增流程区域" }));
    fireEvent.change(screen.getByLabelText("流程区域标题"), { target: { value: "首次安装" } });
    fireEvent.click(screen.getByRole("button", { name: "新增步骤" }));
    fireEvent.change(screen.getByLabelText("步骤标题"), { target: { value: "取得插件包" } });
    fireEvent.click(screen.getByRole("button", { name: "新增步骤" }));
    fireEvent.change(screen.getByLabelText("步骤标题"), { target: { value: "解压插件包" } });
    fireEvent.click(screen.getByRole("button", { name: "取得插件包" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "取得插件包 后续：解压插件包" }));
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][1];
    expect(saved.tabs[0].sections[0].steps[0].next).toEqual([saved.tabs[0].sections[0].steps[1].id]);
  });

  it("shows a save error without discarding the draft", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("流程包含循环"));
    render(<WorkflowEditor document={emptyWorkflow} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("流程包含循环");
    expect(screen.getByRole("button", { name: "新增 Tab" })).toBeInTheDocument();
  });

  it("edits step details, reorders, previews and deletes user-owned workflow content", () => {
    render(<WorkflowEditor document={emptyWorkflow} onSave={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "新增 Tab" }));
    fireEvent.click(screen.getByRole("button", { name: "新增流程区域" }));
    fireEvent.click(screen.getByRole("button", { name: "新增步骤" }));
    fireEvent.click(screen.getByRole("button", { name: "新增步骤" }));

    fireEvent.change(screen.getByLabelText("步骤角标"), { target: { value: "准备" } });
    fireEvent.change(screen.getByLabelText("步骤说明"), { target: { value: "取得正式插件包。" } });
    fireEvent.click(screen.getByRole("button", { name: "步骤上移" }));
    fireEvent.click(screen.getByRole("button", { name: "预览流程" }));

    expect(screen.getAllByText("取得正式插件包。")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "删除步骤" }));
    expect(screen.getByLabelText("步骤标题")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除流程区域" }));
    fireEvent.click(screen.getByRole("button", { name: "删除 Tab" }));
    expect(screen.queryByLabelText("Tab 标题")).not.toBeInTheDocument();
  });

  it("renders only the selected Tab, section and step editor in the cascade", () => {
    render(<WorkflowEditor document={emptyWorkflow} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "新增 Tab" }));
    fireEvent.click(screen.getByRole("button", { name: "新增 Tab" }));
    expect(screen.getAllByLabelText("Tab 标题")).toHaveLength(1);
    expect(screen.getAllByText(/新 Tab/).length).toBeGreaterThanOrEqual(2);
  });
});
