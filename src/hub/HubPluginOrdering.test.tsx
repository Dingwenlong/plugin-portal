import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HubPluginActions } from "./HubPluginActions";
import { HubPluginEntries } from "./HubPluginEntries";
import { PortalRequestError } from "../portal/requestState";
import type { PluginCatalog } from "../portal/types";

const items = ["alpha", "beta", "gamma"].map((id) => ({ id, name: id, pluginKey: `company-dev/${id}`, version: "1.0.0", summary: "test" }));
const alternative = { ...items[1], pluginKey: "company-internal/beta", version: "2.0.0" };
function setup(enabled = true) {
  let latest: PluginCatalog = { revision: 4, items: [...items, alternative] };
  const client = { selectPluginDirectory: vi.fn(), previewImport: vi.fn(), promote: vi.fn(), rollback: vi.fn(), removePlugin: vi.fn(),
    listPlugins: vi.fn(async () => latest),
    reorderPlugins: vi.fn(async (ids: string[], revision: number) => {
      latest = { revision: revision + 1, items: ids.flatMap((id) => latest.items.filter((item) => item.id === id)) };
      return { revision: latest.revision, pluginIds: ids };
    }) };
  function Harness() {
    const [catalog, setCatalog] = useState(latest);
    return <HubPluginActions catalog={catalog} client={client} enabled={enabled} onCatalogChanged={async () => setCatalog(await client.listPlugins())}>
      <HubPluginEntries catalog={catalog} interactive />
    </HubPluginActions>;
  }
  render(<Harness />);
  const order = () => Array.from(document.querySelectorAll('[data-family-id]')).map((node) => node.getAttribute('data-family-id'));
  const move = (id: string, direction: string) => {
    fireEvent.contextMenu(screen.getByRole("link", { name: id }));
    fireEvent.click(screen.getByRole("menuitem", { name: direction }));
  };
  return { client, order, move, setLatest: (catalog: PluginCatalog) => { latest = catalog; } };
}

describe("Hub plugin family ordering", () => {
  it("moves a whole family from the menu, persists and restores focus", async () => {
    const { move, order, client } = setup();
    move("beta", "上移");
    await waitFor(() => expect(order()).toEqual(["beta", "alpha", "gamma"]));
    expect(client.reorderPlugins).toHaveBeenCalledExactlyOnceWith(["beta", "alpha", "gamma"], 4);
    expect(screen.getByRole("link", { name: "beta" })).toHaveFocus();
    expect(screen.getByRole("link", { name: "beta" })).toHaveAttribute("href", "#/plugins/company-internal%2Fbeta/overview");
  });
  it("supports a touch-friendly handle and disables boundary moves", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "调整 alpha 顺序" }));
    expect(screen.getByRole("menuitem", { name: "上移" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "下移" })).toBeEnabled();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "删除" }), { key: "Home" });
    expect(screen.getByRole("menuitem", { name: "下移" })).toHaveFocus();
  });
  it("retains pending order and reconciles an uncertain response without retrying", async () => {
    const { client, move, order, setLatest } = setup();
    client.reorderPlugins.mockRejectedValue(new PortalRequestError("timeout", "request_timeout", undefined, true));
    move("gamma", "上移");
    await screen.findByText("排序结果待确认，请先核对，避免重复提交。");
    expect(screen.getByRole("button", { name: "调整 alpha 顺序" })).toBeDisabled();
    setLatest({ revision: 5, items: [items[0], items[2], items[1], alternative] });
    fireEvent.click(screen.getByRole("button", { name: "核对排序结果" }));
    await waitFor(() => expect(order()).toEqual(["alpha", "gamma", "beta"]));
    expect(client.reorderPlugins).toHaveBeenCalledTimes(1);
  });
  it("requires refreshed selection after a conflict", async () => {
    const { client, move } = setup();
    client.reorderPlugins.mockRejectedValue(new PortalRequestError("changed", "revision_conflict", 409));
    move("beta", "上移");
    await screen.findByText("列表已变化，请刷新后重新调整顺序。");
    fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
    await waitFor(() => expect(screen.queryByText("列表已变化，请刷新后重新调整顺序。")).not.toBeInTheDocument());
    expect(client.reorderPlugins).toHaveBeenCalledTimes(1);
  });
  it("does not expose ordering in read-only mode", () => {
    const { client } = setup(false);
    expect(screen.queryByRole("button", { name: /调整 .* 顺序/ })).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByRole("link", { name: "alpha" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(client.reorderPlugins).not.toHaveBeenCalled();
  });
});
