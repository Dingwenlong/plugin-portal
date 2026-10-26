import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HubPluginEntries } from "../hub/HubPluginEntries";
import { groupCatalogPlugins } from "./catalogIdentity";
import { parsePortalRoute, portalHref } from "./routes";
import type { PluginListItem } from "./types";

const plugin = (target: string, version: string): PluginListItem => ({
  pluginKey: `${target}/project-delivery-hub`, id: "project-delivery-hub",
  name: "研发助手插件", version, summary: "",
});
const oldPlugin = plugin("company-dev", "3.7.17");
const newPlugin = plugin("company-internal", "4.3.6");

describe("catalog identities across marketplaces", () => {
  it("uses the new version for legacy bookmarks regardless of catalog order", () => {
    for (const items of [[oldPlugin, newPlugin], [newPlugin, oldPlugin]]) {
      expect(parsePortalRoute("#/plugins/project-delivery-hub/prompts", items)).toEqual({
        pluginId: newPlugin.pluginKey, page: "prompts",
      });
    }
  });
  it("keeps both exact identities reachable and rejects an unknown full identity", () => {
    for (const item of [oldPlugin, newPlugin]) {
      expect(parsePortalRoute(portalHref(item.pluginKey, "skills"), [oldPlugin, newPlugin])).toEqual({
        pluginId: item.pluginKey, page: "skills",
      });
    }
    expect(parsePortalRoute("#/plugins/another%2Fproject-delivery-hub/skills", [oldPlugin, newPlugin]).pluginId).toBe("");
  });
  it("orders numeric versions and prereleases using SemVer precedence", () => {
    const items = [plugin("a", "4.9.0"), plugin("b", "4.10.0-rc.9"), plugin("c", "4.10.0-rc.10"), plugin("d", "4.10.0")];
    expect(groupCatalogPlugins(items)[0].map((item) => item.version)).toEqual([
      "4.10.0", "4.10.0-rc.10", "4.10.0-rc.9", "4.9.0",
    ]);
    expect(items[0].version).toBe("4.9.0");
    expect(groupCatalogPlugins([plugin("a", "unknown"), newPlugin])[0][0]).toEqual(newPlugin);
  });
  it("shows one primary Hub entry with an explicit link to the older source", () => {
    const { container } = render(<HubPluginEntries catalog={{ revision: 18, items: [oldPlugin, newPlugin] }} interactive />);
    expect(container.querySelectorAll("[data-hub-entry]")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "研发助手插件" })).toHaveAttribute("href", portalHref(newPlugin.pluginKey, "overview"));
    expect(screen.getByText("v4.3.6")).toBeVisible();
    const history = container.querySelector("details")!;
    expect(history).not.toHaveAttribute("open");
    expect(within(history).getByRole("link", { hidden: true })).toHaveAttribute("href", portalHref(oldPlugin.pluginKey, "overview"));
  });
});
