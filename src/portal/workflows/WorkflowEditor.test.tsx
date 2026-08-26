import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkflowEditor } from "./WorkflowEditor";

const emptyWorkflow = {
  revision: 0,
  pluginKey: "company-dev/sample-plugin",
  tabs: [],
};

const configuredWorkflow = {
  revision: 4,
  pluginKey: "company-dev/sample-plugin",
  tabs: [
    {
      id: "installation",
      title: "插件安装",
      sections: [
        {
          id: "first-installation",
          title: "首次安装并配置",
          steps: [
            {
              id: "download",
              label: "准备",
              title: "取得正式插件包",
              description: "从正式下载入口取得插件包。",
              next: ["extract"],
            },
            {
              id: "extract",
              label: "解压",
              title: "解压至独立目录",
              description: "保留插件目录结构。",
              next: [],
            },
          ],
        },
      ],
    },
    { id: "design", title: "设计交付", sections: [] },
  ],
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
    fireEvent.click(screen.getByRole("button", { name: "新增 Tab" }));
    fireEvent.change(screen.getByLabelText("Tab 标题"), { target: { value: "保留的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("流程包含循环");
    expect(screen.getByLabelText("Tab 标题")).toHaveValue("保留的草稿");
  });

  it("renders the external workflow hierarchy as a selectable canvas with one inspector", () => {
    render(<WorkflowEditor document={configuredWorkflow} onSave={vi.fn()} />);

    const canvas = screen.getByRole("region", { name: "流程画布" });
    expect(within(canvas).getByRole("tablist", { name: "流程" })).toBeInTheDocument();
    expect(within(canvas).getByRole("tab", { name: "插件安装" })).toHaveAttribute("aria-selected", "true");
    expect(within(canvas).getByRole("button", { name: "首次安装并配置" })).toBeInTheDocument();
    expect(within(canvas).getByRole("button", { name: "取得正式插件包" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "属性栏" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "编辑具体步骤" })).toBeInTheDocument();
    expect(screen.getByLabelText("步骤标题")).toHaveValue("取得正式插件包");
    expect(screen.queryByRole("button", { name: "预览流程" })).not.toBeInTheDocument();
  });

  it("updates the canvas live and switches the inspector by selected hierarchy", () => {
    render(<WorkflowEditor document={configuredWorkflow} onSave={vi.fn()} />);
    const canvas = screen.getByRole("region", { name: "流程画布" });

    fireEvent.change(screen.getByLabelText("步骤标题"), { target: { value: "下载正式插件包" } });
    expect(within(canvas).getByRole("button", { name: "下载正式插件包" })).toBeInTheDocument();

    fireEvent.click(within(canvas).getByRole("button", { name: "首次安装并配置" }));
    expect(screen.getByRole("heading", { name: "编辑流程区域" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("流程区域标题"), { target: { value: "首次安装" } });
    expect(within(canvas).getByRole("button", { name: "首次安装" })).toBeInTheDocument();

    fireEvent.click(within(canvas).getByRole("tab", { name: "设计交付" }));
    expect(screen.getByRole("heading", { name: "编辑 Tab" })).toBeInTheDocument();
    expect(screen.getByLabelText("Tab 标题")).toHaveValue("设计交付");
  });

  it("focuses each newly created hierarchy title", async () => {
    render(<WorkflowEditor document={emptyWorkflow} onSave={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "新增 Tab" }));
    await waitFor(() => expect(screen.getByLabelText("Tab 标题")).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "新增流程区域" }));
    await waitFor(() => expect(screen.getByLabelText("流程区域标题")).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "新增步骤" }));
    await waitFor(() => expect(screen.getByLabelText("步骤标题")).toHaveFocus());
  });

  it("keeps selection and removes incoming edges when deleting a step", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowEditor document={configuredWorkflow} onSave={onSave} />);
    const canvas = screen.getByRole("region", { name: "流程画布" });

    fireEvent.click(within(canvas).getByRole("button", { name: "解压至独立目录" }));
    fireEvent.click(screen.getByRole("button", { name: "删除步骤" }));
    expect(screen.getByLabelText("步骤标题")).toHaveValue("取得正式插件包");
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][1].tabs[0].sections[0].steps).toEqual([
      expect.objectContaining({ id: "download", next: [] }),
    ]);
  });

  it("keeps the selected object by ID while moving it", () => {
    render(<WorkflowEditor document={configuredWorkflow} onSave={vi.fn()} />);
    const canvas = screen.getByRole("region", { name: "流程画布" });

    fireEvent.click(within(canvas).getByRole("button", { name: "解压至独立目录" }));
    fireEvent.click(screen.getByRole("button", { name: "步骤上移" }));

    expect(screen.getByLabelText("步骤标题")).toHaveValue("解压至独立目录");
    expect(within(canvas).getByRole("button", { name: "解压至独立目录" })).toHaveAttribute("aria-current", "true");
  });

  it("falls back from an emptied section to its parent Tab", () => {
    render(<WorkflowEditor document={configuredWorkflow} onSave={vi.fn()} />);
    const canvas = screen.getByRole("region", { name: "流程画布" });

    fireEvent.click(within(canvas).getByRole("button", { name: "首次安装并配置" }));
    fireEvent.click(screen.getByRole("button", { name: "删除流程区域" }));

    expect(screen.getByRole("heading", { name: "编辑 Tab" })).toBeInTheDocument();
    expect(screen.getByLabelText("Tab 标题")).toHaveValue("插件安装");
  });

  it("selects the nearest same-level object after deleting a Tab or section", () => {
    render(<WorkflowEditor document={emptyWorkflow} onSave={vi.fn()} />);
    const canvas = screen.getByRole("region", { name: "流程画布" });

    fireEvent.click(screen.getByRole("button", { name: "新增 Tab" }));
    fireEvent.change(screen.getByLabelText("Tab 标题"), { target: { value: "第一个 Tab" } });
    fireEvent.click(screen.getByRole("button", { name: "新增 Tab" }));
    fireEvent.click(screen.getByRole("button", { name: "删除 Tab" }));
    expect(screen.getByLabelText("Tab 标题")).toHaveValue("第一个 Tab");

    fireEvent.click(screen.getByRole("button", { name: "新增流程区域" }));
    fireEvent.change(screen.getByLabelText("流程区域标题"), { target: { value: "第一区域" } });
    fireEvent.click(screen.getByRole("button", { name: "新增流程区域" }));
    fireEvent.click(screen.getByRole("button", { name: "删除流程区域" }));
    expect(screen.getByLabelText("流程区域标题")).toHaveValue("第一区域");
    expect(within(canvas).getByRole("button", { name: "第一区域" })).toHaveAttribute("aria-current", "true");
  });

  it("edits step details, reorders and deletes user-owned workflow content", () => {
    render(<WorkflowEditor document={emptyWorkflow} onSave={vi.fn().mockResolvedValue(undefined)} />);
    const canvas = screen.getByRole("region", { name: "流程画布" });
    fireEvent.click(screen.getByRole("button", { name: "新增 Tab" }));
    fireEvent.click(screen.getByRole("button", { name: "新增流程区域" }));
    fireEvent.click(screen.getByRole("button", { name: "新增步骤" }));
    fireEvent.click(screen.getByRole("button", { name: "新增步骤" }));

    fireEvent.change(screen.getByLabelText("步骤角标"), { target: { value: "准备" } });
    fireEvent.change(screen.getByLabelText("步骤说明"), { target: { value: "取得正式插件包。" } });
    fireEvent.click(screen.getByRole("button", { name: "步骤上移" }));

    expect(within(canvas).getByText("取得正式插件包。")).toBeInTheDocument();
    expect(screen.getByLabelText("步骤说明")).toHaveValue("取得正式插件包。");
    fireEvent.click(screen.getByRole("button", { name: "删除步骤" }));
    expect(screen.getByLabelText("步骤标题")).toBeInTheDocument();
    fireEvent.click(within(canvas).getByRole("button", { name: "新流程区域" }));
    fireEvent.click(screen.getByRole("button", { name: "删除流程区域" }));
    fireEvent.click(screen.getByRole("button", { name: "删除 Tab" }));
    expect(screen.queryByLabelText("Tab 标题")).not.toBeInTheDocument();
  });

  it("renders only the selected Tab, section and step form in the inspector", () => {
    render(<WorkflowEditor document={emptyWorkflow} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "新增 Tab" }));
    fireEvent.click(screen.getByRole("button", { name: "新增 Tab" }));
    expect(screen.getAllByLabelText("Tab 标题")).toHaveLength(1);
    expect(screen.getAllByRole("tab", { name: /新 Tab/ })).toHaveLength(2);
  });
});
