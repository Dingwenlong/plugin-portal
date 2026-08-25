export const PORTAL_PAGES = [
  "overview",
  "skills",
  "prompts",
  "mcp",
  "extensions",
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

export function parsePortalRoute(hash: string, pluginIds: string[]): PortalRoute {
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
    return { pluginId: fallbackPluginId, page: "overview" };
  }

  const requestedPage = match[2];
  const page = PORTAL_PAGES.includes(requestedPage as PortalPage)
    ? (requestedPage as PortalPage)
    : "overview";

  return { pluginId: requestedPluginId, page };
}
