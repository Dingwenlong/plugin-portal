import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowGraph } from "./WorkflowGraph";
import { PortalRequestError } from "../requestState";
import type { WorkflowDocument, WorkflowImageReceipt } from "../types";

const base: WorkflowDocument = { revision: 0, pluginKey: "company-dev/sample-plugin", tabs: [
  { id: "tab", title: "Install", sections: [{ id: "section", title: "First", steps: [
    { id: "one", label: "1", title: "Prepare", description: "Saved text", next: [] },
  ] }] },
] };

const createUrl = vi.fn(() => "blob:preview");
const revokeUrl = vi.fn();
beforeEach(() => {
  createUrl.mockClear(); revokeUrl.mockClear();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = createUrl; static revokeObjectURL = revokeUrl; });
});
afterEach(() => vi.unstubAllGlobals());

const file = (name = "one.png") => new File(["png"], name, { type: "image/png" });
const choose = (...files: File[]) => fireEvent.change(screen.getByLabelText("添加步骤图片"), { target: { files } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe("workflow images", () => {
  it("shows each image's own substep title and description", () => {
    const document = structuredClone(base);
    document.tabs[0].sections[0].steps[0].images = [
      { assetId: "a".repeat(64), title: "打开面板", alt: "发送打开面板指令" },
      { assetId: "b".repeat(64), title: "选择任务", alt: "选择需要处理的任务" },
    ];
    render(<WorkflowGraph document={document} />);
    fireEvent.click(screen.getByRole("button", { name: "查看图片：发送打开面板指令" }));
    const viewer = within(screen.getByRole("dialog", { name: "步骤图片" }));
    expect(viewer.getByRole("heading", { name: "打开面板" })).toBeVisible();
    expect(viewer.getByText("发送打开面板指令")).toBeVisible();
    fireEvent.click(viewer.getByRole("button", { name: "下一子步骤" }));
    expect(viewer.getByRole("heading", { name: "选择任务" })).toBeVisible();
    expect(viewer.getByText("选择需要处理的任务")).toBeVisible();
    expect(viewer.queryByText("发送打开面板指令")).not.toBeInTheDocument();
  });
  it("navigates visible step order including steps without images and restores focus", () => {
    const document = structuredClone(base);
    document.tabs[0].sections[0].steps[0].images = [{ assetId: "a".repeat(64), alt: "First image" }];
    document.tabs[0].sections.push({ id: "second-section", title: "Next section", steps: [
      { id: "two", label: "2", title: "No image", description: "Second description", next: [] },
      { id: "three", label: "3", title: "Finish", description: "Final description", next: [], images: [{ assetId: "b".repeat(64), alt: "Final image" }] },
    ] });
    render(<WorkflowGraph document={document} />);
    const open = screen.getByRole("button", { name: "查看图片：First image" });
    fireEvent.click(open);
    const viewer = within(screen.getByRole("dialog", { name: "步骤图片" }));
    expect(viewer.getByText("First image")).toBeVisible();
    fireEvent.click(viewer.getByRole("button", { name: "隐藏控件" }));
    expect(viewer.queryByRole("region", { name: "步骤说明" })).not.toBeInTheDocument();
    expect(viewer.queryByRole("button", { name: "下一步骤" })).not.toBeInTheDocument();
    expect(viewer.getByAltText("First image")).toBeVisible();
    expect(viewer.getByRole("button", { name: "显示控件" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(viewer.getByRole("button", { name: "显示控件" }));
    expect(viewer.getByText("First image")).toBeVisible();
    fireEvent.click(viewer.getByRole("button", { name: "下一步骤" }));
    expect(viewer.getByText("Second description")).toBeVisible();
    expect(viewer.getByText("该步骤暂无图片")).toBeVisible();
    fireEvent.click(viewer.getByRole("button", { name: "下一步骤" }));
    expect(viewer.getByAltText("Final image")).toBeVisible();
    expect(viewer.getByRole("button", { name: "已是最后一步" })).toBeDisabled();
    fireEvent.click(viewer.getByRole("button", { name: "上一步骤" }));
    expect(viewer.getByRole("heading", { name: "No image" })).toBeVisible();
    fireEvent.click(viewer.getByRole("button", { name: "关闭" }));
    expect(open).toHaveFocus();
    expect(screen.getByRole("button", { name: "查看图片：First image" })).toBeVisible();
  });
  it("routes dropped and pasted images through the existing upload queue without intercepting text", async () => {
    const upload = vi.fn().mockResolvedValueOnce({ assetId: "a".repeat(64), width: 80, height: 40 })
      .mockResolvedValueOnce({ assetId: "b".repeat(64), width: 80, height: 40 });
    render(<WorkflowEditor document={base} onSave={vi.fn()} onExit={vi.fn()} onUploadImage={upload} />);
    const images = screen.getByRole("region", { name: "步骤图片" });
    fireEvent.drop(images, { dataTransfer: { files: [file("drop.png")] } });
    fireEvent.paste(images, { clipboardData: { files: [file("paste.png")] } });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls.map((call) => call[0].name)).toEqual(["drop.png", "paste.png"]);
    const textPaste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(textPaste, "clipboardData", { value: { files: [] } });
    fireEvent(screen.getByLabelText("子步骤 1 说明"), textPaste);
    expect(textPaste.defaultPrevented).toBe(false);
  });

  it("uploads images, edits alt and saves only references without nested buttons", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const upload = vi.fn().mockResolvedValue({ assetId: "a".repeat(64), width: 80, height: 40 });
    const { container } = render(<WorkflowEditor document={base} onSave={onSave} onUploadImage={upload} />);
    fireEvent.change(screen.getByLabelText("添加步骤图片"), { target: { files: [new File(["png"], "one.png", { type: "image/png" })] } });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存流程" })).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("子步骤 1 说明"), { target: { value: "Install screenshot" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][1].tabs[0].sections[0].steps[0].images).toEqual([
      { assetId: "a".repeat(64), alt: "Install screenshot" },
    ]);
    expect(container.querySelector("button button")).toBeNull();
  });

  it("preserves failed image and text drafts, then allows a retry", async () => {
    const upload = vi.fn().mockRejectedValueOnce(new Error("Upload failed"))
      .mockResolvedValue({ assetId: "a".repeat(64), width: 80, height: 40 });
    render(<WorkflowEditor document={base} onSave={vi.fn()} onUploadImage={upload} />);
    fireEvent.change(screen.getByLabelText("步骤说明"), { target: { value: "Keep draft" } });
    fireEvent.change(screen.getByLabelText("添加步骤图片"), { target: { files: [new File(["png"], "one.png", { type: "image/png" })] } });
    expect(await screen.findByText("Upload failed")).toBeVisible();
    expect(screen.getByRole("button", { name: "保存流程" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重试图片 1" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存流程" })).not.toBeDisabled());
    expect(screen.getByLabelText("步骤说明")).toHaveValue("Keep draft");
  });

  it("renders thumbnails and closes a keyboard-accessible viewer", async () => {
    const document = structuredClone(base);
    document.tabs[0].sections[0].steps[0].images = [
      { assetId: "a".repeat(64), alt: "First image" }, { assetId: "b".repeat(64), alt: "Second image" },
    ];
    render(<WorkflowGraph document={document} />);
    const open = screen.getByRole("button", { name: "查看图片：First image" });
    open.focus(); fireEvent.click(open);
    const viewer = screen.getByRole("dialog", { name: "步骤图片" });
    expect(within(viewer).getByAltText("First image")).toBeVisible();
    fireEvent.keyDown(viewer, { key: "ArrowRight" });
    expect(within(viewer).getByAltText("Second image")).toBeVisible();
    fireEvent.keyDown(viewer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(open).toHaveFocus();
  });

  it("preserves chosen order when uploads finish in reverse, and saves reordered references", async () => {
    const first = deferred<WorkflowImageReceipt>(); const second = deferred<WorkflowImageReceipt>();
    const upload = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const save = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowEditor document={base} onSave={save} onUploadImage={upload} />);
    choose(file("first.png"), file("second.png"));
    await act(async () => second.resolve({ assetId: "b".repeat(64), width: 80, height: 40 }));
    expect(screen.getByRole("button", { name: "保存流程" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("子步骤 1 说明"), { target: { value: "first" } });
    fireEvent.change(screen.getByLabelText("子步骤 2 说明"), { target: { value: "second" } });
    await act(async () => first.resolve({ assetId: "a".repeat(64), width: 80, height: 40 }));
    fireEvent.click(screen.getByRole("button", { name: "图片 2 前移" }));
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));
    expect(save.mock.calls[0][1].tabs[0].sections[0].steps[0].images).toEqual([
      { assetId: "b".repeat(64), alt: "second" }, { assetId: "a".repeat(64), alt: "first" },
    ]);
  });

  it.each(["image", "step", "unmount"])("aborts and ignores late responses after removing %s", async (remove) => {
    const pending = deferred<WorkflowImageReceipt>(); const upload = vi.fn().mockReturnValue(pending.promise);
    const { unmount } = render(<WorkflowEditor document={base} onSave={vi.fn()} onUploadImage={upload} />);
    choose(file());
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const signal = upload.mock.calls[0][1] as AbortSignal;
    if (remove === "unmount") unmount();
    else fireEvent.click(screen.getByRole("button", { name: remove === "step" ? "删除步骤" : "删除图片 1" }));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ assetId: "a".repeat(64), width: 80, height: 40 }));
    expect(screen.queryByLabelText("子步骤 1 说明")).not.toBeInTheDocument();
    expect(revokeUrl).toHaveBeenCalledTimes(1);
  });

  it("caps each step at six images and processing at two uploads", async () => {
    const upload = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<WorkflowEditor document={base} onSave={vi.fn()} onUploadImage={upload} />);
    choose(...Array.from({ length: 7 }, (_, i) => file(`${i}.png`)));
    expect(screen.getAllByLabelText(/子步骤 \d 说明/)).toHaveLength(6);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("添加步骤图片")).toBeDisabled();
    expect(screen.getByText("每个步骤最多 6 张图片。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "删除图片 1" }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
  });

  it("rejects unsupported, empty and oversized local files without starting upload", () => {
    const upload = vi.fn();
    render(<WorkflowEditor document={base} onSave={vi.fn()} onUploadImage={upload} />);
    choose(new File(["svg"], "bad.svg", { type: "image/svg+xml" }), new File([], "empty.png", { type: "image/png" }),
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }));
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("10 MiB");
    expect(screen.getByRole("button", { name: "保存流程" })).not.toBeDisabled();
  });

  it("deduplicates identical uploads and releases redundant previews", async () => {
    const upload = vi.fn().mockResolvedValue({ assetId: "a".repeat(64), width: 80, height: 40 });
    const { unmount } = render(<WorkflowEditor document={base} onSave={vi.fn()} onUploadImage={upload} />);
    choose(file("one.png"), file("duplicate.png"));
    await waitFor(() => expect(screen.queryByLabelText("子步骤 2 说明")).not.toBeInTheDocument());
    await waitFor(() => expect(revokeUrl).toHaveBeenCalledTimes(1));
    unmount(); expect(revokeUrl).toHaveBeenCalledTimes(2);
  });

  it("locks a single save and confirms a lost receipt using frozen image references and order", async () => {
    const saved = structuredClone(base);
    saved.tabs[0].sections[0].steps[0].images = [{ assetId: "a".repeat(64), alt: "first" }, { assetId: "b".repeat(64), alt: "second" }];
    const write = deferred<unknown>(); const save = vi.fn().mockReturnValue(write.promise);
    const check = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<WorkflowEditor document={saved} onSave={save} onCheckSaved={check} />);
    fireEvent.click(screen.getByRole("button", { name: "图片 2 前移" }));
    const submit = screen.getByRole("button", { name: "保存流程" });
    fireEvent.click(submit); fireEvent.click(submit);
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("步骤说明")).toBeDisabled();
    await act(async () => write.resolve(Promise.reject(new PortalRequestError("lost", "network_error", undefined, true))));
    expect(await screen.findByText(/结果待确认。草稿/)).toBeVisible();
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "核对保存结果" }));
    await waitFor(() => expect(submit).not.toBeDisabled());
    expect(check.mock.calls[0][0].tabs[0].sections[0].steps[0].images).toEqual([
      { assetId: "b".repeat(64), alt: "second" }, { assetId: "a".repeat(64), alt: "first" },
    ]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps image and text drafts on revision conflict and offers latest data without overwriting", async () => {
    const saved = structuredClone(base); saved.tabs[0].sections[0].steps[0].images = [{ assetId: "a".repeat(64), alt: "original" }];
    render(<WorkflowEditor document={saved} onSave={vi.fn().mockRejectedValue(new PortalRequestError("conflict", "revision_conflict", 409))}
      onReadLatest={vi.fn().mockResolvedValue({ ...base, revision: 2 })} />);
    fireEvent.change(screen.getByLabelText("子步骤 1 说明"), { target: { value: "Keep alt" } });
    fireEvent.change(screen.getByLabelText("步骤说明"), { target: { value: "Keep text" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看最新内容" }));
    await screen.findByRole("button", { name: "载入最新版本" });
    expect(screen.getByLabelText("子步骤 1 说明")).toHaveValue("Keep alt");
    expect(screen.getByLabelText("步骤说明")).toHaveValue("Keep text");
  });

  it("can re-upload expired staging from the retained file without losing alt or replaying save", async () => {
    const nextUpload = deferred<WorkflowImageReceipt>();
    const originalFile = file();
    const upload = vi.fn().mockResolvedValueOnce({ assetId: "a".repeat(64), width: 80, height: 40 })
      .mockReturnValueOnce(nextUpload.promise);
    const save = vi.fn().mockRejectedValueOnce(new PortalRequestError("暂存已过期，请重新上传", "image_not_found", 404))
      .mockResolvedValue(undefined);
    render(<WorkflowEditor document={base} onSave={save} onUploadImage={upload} />);
    choose(originalFile);
    await waitFor(() => expect(screen.getByRole("button", { name: "保存流程" })).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("子步骤 1 说明"), { target: { value: "Keep description" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));
    fireEvent.click(await screen.findByRole("button", { name: "重新上传图片 1" }));
    expect(screen.getByRole("button", { name: "保存流程" })).toBeDisabled();
    expect(upload.mock.calls[1][0]).toBe(originalFile);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => nextUpload.resolve({ assetId: "a".repeat(64), width: 80, height: 40 }));
    expect(screen.getByLabelText("子步骤 1 说明")).toHaveValue("Keep description");
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][1].tabs[0].sections[0].steps[0].images).toEqual([
      { assetId: "a".repeat(64), alt: "Keep description" },
    ]);
  });
});
