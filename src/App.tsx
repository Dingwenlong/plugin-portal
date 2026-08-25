import { useEffect, useMemo, useState } from "react";

import { parsePortalRoute, portalHref, type PortalPage } from "./portal/routes";

export interface PortalPluginSummary {
  id: string;
  name: string;
}

interface AppProps {
  plugins?: PortalPluginSummary[];
  initialHash?: string;
}

const NAVIGATION: ReadonlyArray<{ page: PortalPage; label: string }> = [
  { page: "overview", label: "鸟瞰全景" },
  { page: "skills", label: "Skills" },
  { page: "prompts", label: "Prompts" },
  { page: "mcp", label: "MCP" },
  { page: "extensions", label: "扩展工具" },
  { page: "rules", label: "工程规范" },
  { page: "releases", label: "版本沿革" },
];

const EMPTY_COPY: Record<PortalPage, string> = {
  overview: "尚未配置鸟瞰全景流程",
  skills: "该插件未提供 Skills",
  prompts: "尚未添加 Prompt",
  mcp: "该插件未提供 MCP",
  extensions: "该插件未配置扩展工具",
  rules: "该插件未提供公开工程规范",
  releases: "该插件尚无导入记录",
};

export default function App({ plugins = [], initialHash }: AppProps) {
  const [browserHash, setBrowserHash] = useState(() => initialHash ?? window.location.hash);
  const routeHash = initialHash ?? browserHash;
  const pluginIds = useMemo(() => plugins.map((plugin) => plugin.id), [plugins]);
  const parsedRoute = parsePortalRoute(routeHash, pluginIds);
  const [selectedPluginId, setSelectedPluginId] = useState(parsedRoute.pluginId);

  useEffect(() => {
    setSelectedPluginId(parsedRoute.pluginId);
  }, [parsedRoute.pluginId]);

  useEffect(() => {
    if (initialHash !== undefined) return undefined;
    const onHashChange = () => setBrowserHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [initialHash]);

  const selectedPlugin =
    plugins.find((plugin) => plugin.id === selectedPluginId) ?? plugins[0];

  if (!selectedPlugin) {
    return (
      <main className="portal-empty-root">
        <h1>Plugin Portal</h1>
        <p>尚未人工纳入插件</p>
      </main>
    );
  }

  return (
    <div className="portal-layout">
      <aside className="portal-sidebar">
        <a className="portal-brand" href={portalHref(selectedPlugin.id, "overview")}>
          Plugin Portal
        </a>

        <label className="plugin-selector">
          <span>当前插件</span>
          <select
            aria-label="当前插件"
            value={selectedPlugin.id}
            onChange={(event) => setSelectedPluginId(event.currentTarget.value)}
          >
            {plugins.map((plugin) => (
              <option key={plugin.id} value={plugin.id}>
                {plugin.name}
              </option>
            ))}
          </select>
        </label>

        <nav aria-label="插件内容">
          {NAVIGATION.map((item) => (
            <a
              aria-current={item.page === parsedRoute.page ? "page" : undefined}
              href={portalHref(selectedPlugin.id, item.page)}
              key={item.page}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </aside>

      <main className="portal-main">
        <header className="portal-header">
          <h1>{selectedPlugin.name}</h1>
          <span className="plugin-identity">{selectedPlugin.id}</span>
        </header>

        <section className="empty-state" aria-labelledby="page-title">
          <h2 id="page-title">
            {NAVIGATION.find((item) => item.page === parsedRoute.page)?.label}
          </h2>
          <p>{EMPTY_COPY[parsedRoute.page]}</p>
          {parsedRoute.page === "prompts" ? <button type="button">新增 Prompt</button> : null}
        </section>
      </main>
    </div>
  );
}
