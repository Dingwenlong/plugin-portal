import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HubPluginActions } from "./HubPluginActions";
import { HubPluginEntries } from "./HubPluginEntries";
import { PortalRequestError } from "../portal/requestState";
import type { PluginCatalog } from "../portal/types";

const primary = { id: "sample", pluginKey: "company-internal/sample", version: "2.0.0", name: "示例插件", summary: "示例" };
const old = { ...primary, pluginKey: "company-dev/sample", version: "1.0.0" };
const initial = { revision: 2, items: [primary, old] };

function setup({ enabled = true, catalog = initial } = {}) {
  let latest: PluginCatalog = catalog;
  const client = {
    selectPluginDirectory: vi.fn(), previewImport: vi.fn(), promote: vi.fn(), rollback: vi.fn(),
    removePlugin: vi.fn(async (key: string, revision: number) => {
      latest = { revision: revision + 1, items: latest.items.filter((item) => item.pluginKey !== key) };
      return { pluginKey: key, revision: revision + 1 };
    }),
    listPlugins: vi.fn(async () => latest),
  };
  const refresh = vi.fn(async () => client.listPlugins());
  function Harness() {
    const [value, setValue] = useState(catalog);
    return <HubPluginActions catalog={value} client={client} enabled={enabled} onCatalogChanged={async () => setValue(await refresh())}>
      <button aria-label="纳入插件">+</button>
      <HubPluginEntries catalog={value} interactive />
    </HubPluginActions>;
  }
  render(<Harness />);
  const entry = () => screen.getByRole("link", { name: "示例插件" });
  const open = () => { fireEvent.contextMenu(entry(), { clientX: 180, clientY: 210 }); fireEvent.click(screen.getByRole("menuitem", { name: "删除" })); };
  return { client, refresh, entry, open, setLatest: (value: PluginCatalog) => { latest = value; } };
}

describe("Hub plugin deletion", () => {
  it("opens at the selected row without navigating, then cancels with focus restored", () => {
    const { entry, open, client } = setup();
    open();
    expect(screen.getByText(primary.pluginKey)).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByText("v2.0.0")).toBeVisible();
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(entry()).toHaveFocus();
    expect(client.removePlugin).not.toHaveBeenCalled();
  });

  it("supports keyboard invocation, Escape and outside click dismissal", () => {
    const { entry } = setup();
    entry().focus();
    fireEvent.keyDown(entry(), { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "删除" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(entry()).toHaveFocus();
    fireEvent.keyDown(entry(), { key: "ContextMenu" });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not replace the native menu in read-only mode", () => {
    const { entry, client } = setup({ enabled: false });
    expect(fireEvent.contextMenu(entry())).toBe(true);
    fireEvent.keyDown(entry(), { key: "F10", shiftKey: true });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(client.removePlugin).not.toHaveBeenCalled();
  });

  it("deletes only an expanded alternative's full identity", async () => {
    const { entry, client } = setup();
    fireEvent.click(screen.getByText("其他来源与版本"));
    const alternative = screen.getByRole("link", { name: "示例插件 v1.0.0 · company-dev" });
    fireEvent.contextMenu(alternative);
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(screen.getByText(old.pluginKey)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.removePlugin).toHaveBeenCalledExactlyOnceWith(old.pluginKey, 2);
    expect(entry()).toHaveAttribute("href", "#/plugins/company-internal%2Fsample/overview");
    expect(entry()).toHaveFocus();
    expect(screen.queryByText("其他来源与版本")).not.toBeInTheDocument();
  });

  it("promotes the remaining source in the list and focuses inclusion after deleting the last entry", async () => {
    const { open, entry, client } = setup();
    open(); fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(entry()).toHaveAttribute("href", "#/plugins/company-dev%2Fsample/overview");
    open(); fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "纳入插件" })).toHaveFocus();
    expect(client.removePlugin).toHaveBeenLastCalledWith(old.pluginKey, 3);
  });

  it("requires refreshed selection after a conflict and never silently advances the revision", async () => {
    const { open, client } = setup();
    client.removePlugin.mockRejectedValue(new PortalRequestError("changed", "revision_conflict", 409));
    open(); fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await screen.findByText("插件列表已更新，请刷新列表后重新选择要删除的插件。");
    expect(screen.queryByRole("button", { name: "确认删除" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新列表并关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.removePlugin).toHaveBeenCalledTimes(1);
  });

  it("reconciles an unknown result by reading the full identity, without repeating deletion", async () => {
    const { open, client, setLatest } = setup();
    client.removePlugin.mockRejectedValue(new PortalRequestError("timeout", "request_timeout", undefined, true));
    open(); fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await screen.findByText("删除结果待确认。请核对列表，暂时不要重复删除。");
    expect(screen.queryByRole("button", { name: "确认删除" })).not.toBeInTheDocument();
    setLatest({ revision: 3, items: [old] });
    fireEvent.click(screen.getByRole("button", { name: "核对删除结果" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.removePlugin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "示例插件" })).toHaveAttribute("href", "#/plugins/company-dev%2Fsample/overview");
  });

  it("keeps a confirmed removal visible when list refresh fails and only retries the read", async () => {
    const { open, client, refresh } = setup();
    refresh.mockRejectedValueOnce(new Error("offline"));
    open(); fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await screen.findByText("列表刷新失败：offline");
    expect(screen.getByText("已删除插件条目。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "刷新列表并关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.removePlugin).toHaveBeenCalledTimes(1);
  });
});
