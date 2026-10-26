import { groupCatalogPlugins } from "./catalogIdentity";
import type { PluginListItem } from "./types";

export const PORTAL_PAGES = [
  "overview",
  "skills",
  "prompts",
  "mcp",
  "rules",
  "releases",
] as const;

export type PortalPage = (typeof PORTAL_PAGES)[number];

export interface PortalRoute {
  pluginId: string;
  page: PortalPage;
}

export function portalHref(pluginId: string, page: PortalPage): string {
  return `#/plugins/${encodeURIComponent(pluginId)}/${page}`;
}

export function parsePortalRoute(hash: string, plugins: readonly string[] | readonly PluginListItem[]): PortalRoute {
  const items = plugins.filter((plugin): plugin is PluginListItem => typeof plugin !== "string");
  const pluginIds = plugins.map((plugin) => typeof plugin === "string" ? plugin : plugin.pluginKey);
  const fallbackPluginId = pluginIds[0] ?? "";
  const match = /^#\/plugins\/([^/]+)\/([^/]+)$/.exec(hash);
  if (!match) {
    return { pluginId: fallbackPluginId, page: "overview" };
  }

  let requestedPluginId: string;
  try {
    requestedPluginId = decodeURIComponent(match[1]);
  } catch {
    return { pluginId: fallbackPluginId, page: "overview" };
  }

  if (!pluginIds.includes(requestedPluginId)) {
    const legacy = groupCatalogPlugins(items).find(([plugin]) => plugin.id === requestedPluginId)?.[0];
    if (legacy) requestedPluginId = legacy.pluginKey;
    else if (requestedPluginId.includes("/")) return { pluginId: "", page: "overview" };
    else return { pluginId: fallbackPluginId, page: "overview" };
  }

  const requestedPage = match[2] === "extensions" ? "mcp" : match[2];
  const page = PORTAL_PAGES.includes(requestedPage as PortalPage)
    ? (requestedPage as PortalPage)
    : "overview";

  return { pluginId: requestedPluginId, page };
}
