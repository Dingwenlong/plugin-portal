import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowEditor } from "./WorkflowEditor";
import { requestPortalNavigation } from "../PortalModal";
import { PortalRequestError } from "../requestState";

afterEach(() => vi.restoreAllMocks());

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
  it("shows one saving status while a page save is pending", async () => {
    let finish!: () => void;
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<WorkflowEditor document={configuredWorkflow} onSave={onSave} onExit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("步骤说明"), { target: { value: "Updated description" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));
    expect(screen.getAllByText("正在保存…")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "保存流程" })).toBeDisabled();
    await act(async () => finish());
    expect(onSave).toHaveBeenCalledTimes(1);
  });
  it("retains both step drafts when switching selection in page edit mode", () => {
    render(<WorkflowEditor document={configuredWorkflow} onSave={vi.fn()} onExit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("步骤说明"), { target: { value: "第一步草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "解压至独立目录" }));
    fireEvent.change(screen.getByLabelText("步骤说明"), { target: { value: "第二步草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "取得正式插件包" }));
    expect(screen.getByLabelText("步骤说明")).toHaveValue("第一步草稿");
    expect(screen.getByRole("region", { name: "流程画布" })).toHaveTextContent("第二步草稿");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("confirms dirty exit, keeps drafts on cancel and guards browser unload", () => {
    const exit = vi.fn();
    const view = render(<WorkflowEditor document={configuredWorkflow} onSave={vi.fn()} onExit={exit} />);
    fireEvent.change(screen.getByLabelText("步骤标题"), { target: { value: "保留草稿" } });
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "退出编辑" }));
    expect(screen.getByRole("dialog", { name: "退出流程编辑" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("步骤标题")).toHaveValue("保留草稿");
    expect(exit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "退出编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃并退出" }));
    expect(exit).toHaveBeenCalledTimes(1);
    view.unmount();
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after); expect(after.defaultPrevented).toBe(false);
  });

  it("only continues guarded navigation after explicit discard", () => {
    const navigate = vi.fn();
    render(<WorkflowEditor document={configuredWorkflow} onSave={vi.fn()} onExit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("步骤标题"), { target: { value: "草稿" } });
    act(() => { expect(requestPortalNavigation(navigate)).toBe(false); });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    act(() => { requestPortalNavigation(navigate); });
    fireEvent.click(screen.getByRole("button", { name: "放弃并退出" }));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("locks edits, exit and navigation for the single in-flight save, exiting only on success", async () => {
    let resolve!: () => void;
    const save = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const exit = vi.fn(); const navigate = vi.fn();
    render(<WorkflowEditor document={configuredWorkflow} onSave={save} onExit={exit} />);
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));
    expect(screen.getByLabelText("步骤标题")).toBeDisabled();
    expect(screen.getByRole("button", { name: "退出编辑" })).toBeDisabled();
    act(() => { requestPortalNavigation(navigate); });
    expect(navigate).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("allows explicit exit from an unconfirmed result without replaying the save", async () => {
    const save = vi.fn().mockRejectedValue(new PortalRequestError("断线", "network_error", undefined, true));
    const exit = vi.fn();
    render(<WorkflowEditor document={configuredWorkflow} onSave={save} onCheckSaved={async () => false} onExit={exit} />);
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));
    await screen.findByRole("button", { name: "核对保存结果" });
    await waitFor(() => expect(screen.getByRole("button", { name: "退出编辑" })).not.toBeDisabled());
    expect(exit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "退出编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "退出并稍后核对" }));
    expect(exit).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledTimes(1);
  });

  it("returns from compact inspector to the selected step without losing its draft", () => {
    const originalMedia = window.matchMedia("(max-width: 899px)");
    vi.spyOn(window, "matchMedia").mockReturnValue({ ...originalMedia, matches: true });
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    render(<WorkflowEditor document={configuredWorkflow} onSave={vi.fn()} onExit={vi.fn()} />);
    const card = screen.getByRole("button", { name: "解压至独立目录" });
    card.focus(); fireEvent.click(card);
    expect(screen.getByLabelText("步骤标题")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("步骤说明"), { target: { value: "手机草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "返回流程" }));
    expect(card).toHaveFocus();
    expect(screen.getByRole("region", { name: "流程编辑" })).toHaveAttribute("data-inspector-open", "false");
    fireEvent.click(card);
    expect(screen.getByLabelText("步骤说明")).toHaveValue("手机草稿");
  });

  it("returns focus to the nearest surviving step after deleting the compact inspector trigger", () => {
    const originalMedia = window.matchMedia("(max-width: 899px)");
    vi.spyOn(window, "matchMedia").mockReturnValue({ ...originalMedia, matches: true });
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    render(<WorkflowEditor document={configuredWorkflow} onSave={vi.fn()} onExit={vi.fn()} />);
    const card = screen.getByRole("button", { name: "取得正式插件包" });
    card.focus(); fireEvent.click(card);
    fireEvent.click(screen.getByRole("button", { name: "删除步骤" }));
    fireEvent.click(screen.getByRole("button", { name: "返回流程" }));
    expect(screen.getByRole("button", { name: "解压至独立目录" })).toHaveFocus();
  });

  it("creates Tab, section and steps in their visible order", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][1];
    expect(saved.tabs[0].sections[0].steps.map((step: { title: string }) => step.title)).toEqual(["取得插件包", "解压插件包"]);
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
