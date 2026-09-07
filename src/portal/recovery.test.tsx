import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalModal, requestPortalNavigation } from "./PortalModal";
import { PluginManager } from "./PluginManager";
import { PortalRequestError } from "./requestState";
import { useResource } from "./useResource";
import { useSaveRecovery } from "./useSaveRecovery";
import { PromptsView } from "./views/PortalViews";
import type { PluginImportCandidate, PluginUploadReceipt, PromptDocument } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const uncertain = () => new PortalRequestError("结果待确认", "network_error", undefined, true);
const document: PromptDocument = {
  revision: 4, pluginKey: "company-dev/sample",
  items: [{ id: "prompt-1", scenario: "原始场景", content: "原始内容", createdAt: "2026-09-07T00:00:00Z" }],
};
const candidate: PluginImportCandidate = {
  candidateId: "candidate-1", pluginKey: document.pluginKey,
  snapshot: {
    schemaVersion: "1.0.0", plugin: { target: "company-dev", id: "sample", name: "示例", version: "1.0.0", summary: "公开内容" },
    skills: [], mcp: [], extensionTools: [], engineeringRules: [],
    provenance: { packageDigest: "sha256:" + "a".repeat(64), adapterVersion: "1.0.0", importedAt: "2026-09-07T00:00:00Z" },
  },
};
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("resource isolation", () => {
  it("aborts prior keys and ignores late replies after switching or unmounting", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const signals: AbortSignal[] = [];
    const load = vi.fn((key: string, signal: AbortSignal) => { signals.push(signal); return key === "a" ? first.promise : second.promise; });
    const { result, rerender, unmount } = renderHook(({ resourceKey }) => useResource(resourceKey, load), { initialProps: { resourceKey: "a" } });
    rerender({ resourceKey: "b" });
    expect(signals[0].aborted).toBe(true);
    await act(async () => { second.resolve("new"); });
    expect(result.current.value).toBe("new");
    await act(async () => { first.resolve("stale"); });
    expect(result.current.value).toBe("new");
    unmount();
    expect(signals[1].aborted).toBe(true);
  });

  it("aborts an in-flight GET before installing a saved value", async () => {
    const response = deferred<string>();
    let signal!: AbortSignal;
    const load = vi.fn((_key: string, incoming: AbortSignal) => { signal = incoming; return response.promise; });
    const { result } = renderHook(() => useResource("a", load));
    act(() => result.current.update("saved"));
    expect(signal.aborted).toBe(true);
    await act(async () => response.resolve("old server value"));
    expect(result.current.value).toBe("saved");
  });

  it.each(["A-B-A", "revision"])("rejects old update callbacks after a %s generation change", async (transition) => {
    const current = deferred<string>();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const load = vi.fn((_key: string, signal: AbortSignal) => {
      signals.push(signal);
      calls += 1;
      return calls === 1 ? Promise.resolve("first A") : current.promise;
    });
    const { result, rerender } = renderHook(({ resourceKey, revision }) => useResource(resourceKey, load, revision), { initialProps: { resourceKey: "a", revision: 1 } });
    await waitFor(() => expect(result.current.value).toBe("first A"));
    const oldUpdate = result.current.update;
    if (transition === "A-B-A") {
      rerender({ resourceKey: "b", revision: 1 });
      rerender({ resourceKey: "a", revision: 1 });
    } else rerender({ resourceKey: "a", revision: 2 });
    const currentSignal = signals.at(-1)!;
    let accepted: unknown;
    act(() => { accepted = oldUpdate("late save from first A"); });
    expect(accepted).toBe(false);
    expect(currentSignal.aborted).toBe(false);
    expect(result.current.value).not.toBe("late save from first A");
    await act(async () => current.resolve("current A"));
    expect(result.current).toMatchObject({ status: "ready", value: "current A" });
    act(() => { accepted = result.current.update("current save"); });
    expect(accepted).toBe(true);
    expect(result.current.value).toBe("current save");
  });

  it.each(["A-B-A", "revision"])("ignores old refresh callbacks without cancelling the current %s request", async (transition) => {
    const current = deferred<string>();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const load = vi.fn((_key: string, signal: AbortSignal) => {
      signals.push(signal);
      calls += 1;
      return calls === 1 ? Promise.resolve("first A") : current.promise;
    });
    const { result, rerender } = renderHook(({ resourceKey, revision }) => useResource(resourceKey, load, revision), { initialProps: { resourceKey: "a", revision: 1 } });
    await waitFor(() => expect(result.current.value).toBe("first A"));
    const oldRefresh = result.current.refresh;
    if (transition === "A-B-A") {
      rerender({ resourceKey: "b", revision: 1 });
      rerender({ resourceKey: "a", revision: 1 });
    } else rerender({ resourceKey: "a", revision: 2 });
    const expectedCalls = transition === "A-B-A" ? 3 : 2;
    const currentSignal = signals.at(-1)!;
    let oldResult!: Promise<string | undefined>;
    act(() => { oldResult = oldRefresh(); });
    expect(load).toHaveBeenCalledTimes(expectedCalls);
    expect(currentSignal.aborted).toBe(false);
    await act(async () => { current.resolve("current A"); await oldResult; });
    await expect(oldResult).resolves.toBeUndefined();
    expect(result.current).toMatchObject({ status: "ready", value: "current A" });
  });

  it("keeps stale content visible on failed refresh and retries independently", async () => {
    const load = vi.fn().mockResolvedValueOnce("cached").mockRejectedValueOnce(new Error("读取失败")).mockResolvedValueOnce("fresh");
    const { result } = renderHook(() => useResource("a", load));
    await waitFor(() => expect(result.current.value).toBe("cached"));
    await act(async () => { await result.current.refresh().catch(() => undefined); });
    expect(result.current).toMatchObject({ value: "cached", status: "error", error: "读取失败" });
    await act(async () => { await result.current.refresh(); });
    expect(result.current).toMatchObject({ value: "fresh", status: "ready" });
  });
});

describe("save recovery single flight", () => {
  it("freezes the attempted value and blocks duplicate writes until matching readback", async () => {
    const saving = deferred<void>();
    const write = vi.fn(() => saving.promise);
    const check = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("GET failed")).mockResolvedValueOnce(true);
    const success = vi.fn();
    const { result } = renderHook(() => useSaveRecovery(check, success));
    const value = { content: "frozen" };
    let run!: Promise<void>;
    act(() => { run = result.current.run(value, write); void result.current.run(value, write); });
    value.content = "changed";
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ content: "frozen" });
    await act(async () => { saving.reject(uncertain()); await run; });
    expect(result.current).toMatchObject({ pending: true, busy: false });
    expect(check).toHaveBeenLastCalledWith({ content: "frozen" });
    await act(async () => { await result.current.run(value, write); await result.current.check(); });
    expect(result.current.pending).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(success).not.toHaveBeenCalled();
    await act(async () => { await result.current.check(); });
    expect(result.current.pending).toBe(false);
    expect(success).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("uses the original readback and completion callbacks after rerender", async () => {
    const saving = deferred<void>();
    const oldCheck = vi.fn().mockResolvedValue(true);
    const newCheck = vi.fn().mockResolvedValue(true);
    const oldSuccess = vi.fn();
    const newSuccess = vi.fn();
    const { result, rerender } = renderHook(({ check, success }) => useSaveRecovery(check, success), { initialProps: { check: oldCheck, success: oldSuccess } });
    let run!: Promise<void>;
    act(() => { run = result.current.run({ text: "old route" }, () => saving.promise); });
    rerender({ check: newCheck, success: newSuccess });
    await act(async () => { saving.reject(uncertain()); await run; });
    expect(oldCheck).toHaveBeenCalledWith({ text: "old route" });
    expect(oldSuccess).toHaveBeenCalledTimes(1);
    expect(newCheck).not.toHaveBeenCalled();
    expect(newSuccess).not.toHaveBeenCalled();
  });

  it("exposes revision conflicts without calling uncertain readback", async () => {
    const check = vi.fn();
    const { result } = renderHook(() => useSaveRecovery(check));
    await act(async () => { await result.current.run({ text: "draft" }, async () => { throw new PortalRequestError("资料已更新", "revision_conflict", 409); }); });
    expect(result.current).toMatchObject({ conflict: true, pending: false, busy: false });
    expect(check).not.toHaveBeenCalled();
  });
});

describe("Prompt draft recovery", () => {
  it("retains the opening revision and item set when props refresh during editing", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<PromptsView document={document} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑 原始场景" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt 内容" }), { target: { value: "本地草稿" } });
    rerender(<PromptsView document={{ ...document, revision: 5, items: [] }} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(4, [{ ...document.items[0], content: "本地草稿" }]));
  });

  it("closes unchanged drafts directly but confirms when both original fields are cleared", () => {
    render(<PromptsView document={document} onSave={vi.fn()} />);
    const opener = screen.getByRole("button", { name: "编辑 原始场景" });
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    fireEvent.click(opener);
    fireEvent.change(screen.getByRole("textbox", { name: "常用场景" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt 内容" }), { target: { value: "" } });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "放弃并关闭" })).toBeInTheDocument();
  });

  it("refuses to load a latest document that deleted the edited Prompt", async () => {
    const onSave = vi.fn().mockRejectedValue(new PortalRequestError("冲突", "revision_conflict", 409));
    const onApplyLatest = vi.fn();
    render(<PromptsView document={document} onSave={onSave} onReadLatest={async () => ({ ...document, revision: 5, items: [] })} onApplyLatest={onApplyLatest} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑 原始场景" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt 内容" }), { target: { value: "保留这份草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看最新内容" }));
    fireEvent.click(await screen.findByRole("button", { name: "载入最新版本" }));
    expect(onApplyLatest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认载入" }));
    expect(await screen.findByText(/这条 Prompt 已被删除/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prompt 内容" })).toHaveValue("保留这份草稿");
    expect(onApplyLatest).not.toHaveBeenCalled();
  });

  it("locks all draft controls during saving, including already-open discard confirmation", async () => {
    const saving = deferred<void>();
    const onSave = vi.fn(() => saving.promise);
    render(<PromptsView document={document} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑 原始场景" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt 内容" }), { target: { value: "新内容" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    for (const name of ["保存", "取消", "关闭", "放弃并关闭"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "常用场景" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Prompt 内容" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "放弃并关闭" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => saving.resolve());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("modal keyboard and navigation boundaries", () => {
  it("traps focus on the dialog when every control is disabled and restores its opener", () => {
    const opener = globalThis.document.createElement("button");
    globalThis.document.body.append(opener); opener.focus();
    const close = vi.fn();
    const { unmount } = render(<PortalModal title="忙碌操作" onClose={close} busy><fieldset disabled><input aria-label="禁用输入" /><button type="button">禁用按钮</button></fieldset></PortalModal>);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(dialog).toHaveFocus();
    opener.focus();
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.mouseDown(dialog.parentElement!);
    expect(requestPortalNavigation(vi.fn())).toBe(false);
    expect(close).not.toHaveBeenCalled();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("requires explicit discard before navigating away from a dirty draft", () => {
    const close = vi.fn();
    const proceed = vi.fn();
    render(<PortalModal title="编辑" dirty onClose={close}><input /></PortalModal>);
    act(() => { expect(requestPortalNavigation(proceed)).toBe(false); });
    expect(proceed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃并关闭" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(proceed).not.toHaveBeenCalled();
  });
});

describe("import confirmation recovery", () => {
  it("single-flights upload and preview while keeping import controls and closing locked", async () => {
    const uploading = deferred<PluginUploadReceipt>();
    const previewing = deferred<PluginImportCandidate>();
    const uploadPluginArchive = vi.fn(() => uploading.promise);
    const previewImport = vi.fn(() => previewing.promise);
    const close = vi.fn();
    const client = { selectPluginDirectory: vi.fn(), uploadPluginArchive, previewImport, promote: vi.fn(), rollback: vi.fn() };
    render(<PortalModal title="纳入插件" onClose={close}><PluginManager catalogRevision={4} client={client} onChanged={vi.fn()} fileSelectionMode="browser-upload" /></PortalModal>);
    const input = screen.getByLabelText("插件 ZIP");
    const file = new File(["zip"], "sample.zip");
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.change(input, { target: { files: [file] } });
    expect(uploadPluginArchive).toHaveBeenCalledTimes(1);
    for (const label of ["插件 ZIP", "发布者", "公开规范相对路径", "扩展工具 JSON"]) expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    await act(async () => uploading.resolve({ uploadId: "upload-1", fileName: file.name, archiveBytes: file.size }));
    expect(previewImport).toHaveBeenCalledTimes(1);
    expect(input).toBeDisabled();
    expect(screen.queryByRole("button", { name: "确认纳入" })).not.toBeInTheDocument();
    await act(async () => previewing.resolve(candidate));
    expect(screen.getByRole("button", { name: "确认纳入" })).toBeEnabled();
    expect(client.promote).not.toHaveBeenCalled();
  });

  it("never replays an uncertain promotion and waits for matching snapshot readback", async () => {
    const promotion = deferred<never>();
    const getSnapshot = vi.fn().mockResolvedValueOnce({ ...candidate.snapshot, skills: [{ id: "different", name: "不同", description: "不同" }] }).mockResolvedValueOnce(candidate.snapshot);
    const promote = vi.fn(() => promotion.promise);
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const client = { selectPluginDirectory: vi.fn().mockResolvedValue({ selected: true, path: "fixtures/sample" }), previewImport: vi.fn().mockResolvedValue(candidate), promote, rollback: vi.fn(), getSnapshot };
    render(<PluginManager catalogRevision={4} client={client} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "选择插件目录" }));
    const confirm = await screen.findByRole("button", { name: "确认纳入" });
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(promote).toHaveBeenCalledTimes(1);
    await act(async () => promotion.reject(uncertain()));
    expect(await screen.findByText(/结果待确认：/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认纳入" })).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "核对纳入结果" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("sample"));
    expect(promote).toHaveBeenCalledTimes(1);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("requires a fresh preview and human confirmation after invalid_session", async () => {
    const promote = vi.fn().mockRejectedValueOnce(new PortalRequestError("会话失效", "invalid_session", 401)).mockResolvedValueOnce({ revision: 5, pluginKey: candidate.pluginKey, snapshotId: "a".repeat(64) });
    const previewImport = vi.fn().mockResolvedValueOnce(candidate).mockResolvedValueOnce({ ...candidate, candidateId: "candidate-2" });
    const client = { selectPluginDirectory: vi.fn().mockResolvedValue({ selected: true, path: "fixtures/sample" }), previewImport, promote, rollback: vi.fn() };
    render(<PluginManager catalogRevision={4} client={client} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "选择插件目录" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认纳入" }));
    fireEvent.click(await screen.findByRole("button", { name: "重新生成预览并确认" }));
    const confirm = await screen.findByRole("button", { name: "确认纳入" });
    expect(promote).toHaveBeenCalledTimes(1);
    fireEvent.click(confirm);
    await waitFor(() => expect(promote).toHaveBeenLastCalledWith(candidate.pluginKey, "candidate-2", 4));
    expect(previewImport).toHaveBeenCalledTimes(2);
  });
});
