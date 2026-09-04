import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PortalShell, type PortalDataClient } from "./PortalShell";

function createClient(): PortalDataClient {
  const plugins = [
    {
      pluginKey: "company-dev/project-delivery-hub",
      id: "project-delivery-hub",
      name: "研发助手插件",
      version: "3.7.17",
      summary: "研发说明",
    },
    {
      pluginKey: "company-dev/yusheng-inc",
      id: "yusheng-inc",
      name: "昱勝 Inc",
      version: "1.1.4",
      summary: "昱勝说明",
    },
  ];
  return {
    getAccessMode: async () => ({ readOnly: false, fileSelectionMode: "server-picker" }),
    listPlugins: async () => ({ revision: 2, items: plugins }),
    getSnapshot: async (pluginKey) => ({
      schemaVersion: "1.0.0",
      plugin: {
        target: "company-dev",
        id: pluginKey.split("/")[1],
        name: plugins.find((item) => item.pluginKey === pluginKey)!.name,
        version: plugins.find((item) => item.pluginKey === pluginKey)!.version,
        summary: "公开说明",
      },
      skills: [],
      mcp: [],
      extensionTools: [],
      engineeringRules: [],
      provenance: {
        packageDigest: `sha256:${"a".repeat(64)}`,
        adapterVersion: "1.0.0",
        importedAt: "2026-08-25T00:00:00Z",
      },
    }),
    getDownloadInfo: async (pluginKey) => ({
      available: pluginKey.endsWith("project-delivery-hub"),
      version: plugins.find((item) => item.pluginKey === pluginKey)!.version,
      href: pluginKey.endsWith("project-delivery-hub")
        ? "http://127.0.0.1:9134/downloads/project-delivery-hub-3.7.17-company-dev.zip"
        : null,
    }),
    getPrompts: async (pluginKey) => ({
      revision: 1,
      pluginKey,
      items: [
        {
          id: pluginKey.endsWith("yusheng-inc") ? "ys" : "pdh",
          scenario: pluginKey.endsWith("yusheng-inc") ? "昱勝 Prompt" : "研发 Prompt",
          content: "内容",
          createdAt: "2026-08-26T00:00:00Z",
        },
      ],
    }),
    savePrompts: async (pluginKey, _revision, items) => ({ revision: 2, pluginKey, items }),
    getWorkflows: async (pluginKey) => ({ revision: 0, pluginKey, tabs: [] }),
    saveWorkflows: async (_pluginKey, _revision, workflow) => ({ revision: 1, ...workflow }),
    selectPluginDirectory: async () => ({ selected: false }),
    uploadPluginArchive: async () => { throw new Error("not used"); },
    selectDownloadCandidate: async () => ({ selected: false }),
    uploadDownloadCandidate: async () => { throw new Error("not used"); },
    confirmDownloadPublication: async () => { throw new Error("not used"); },
    previewImport: async () => { throw new Error("not used"); },
    promote: async () => { throw new Error("not used"); },
    rollback: async () => { throw new Error("not used"); },
  };
}

describe("PortalShell", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-portal-theme");
  });

  it("keeps a separate glass layer underneath the interactive capsule", async () => {
    render(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/skills" />);
    const capsule = await screen.findByRole("banner", { name: "插件导航" });
    const glass = capsule.querySelector(".portal-capsule-glass");
    expect(glass).toHaveAttribute("aria-hidden", "true");
    expect(glass?.querySelector("a, button, nav")).toBeNull();
    expect(within(capsule).getByRole("navigation", { name: "插件内容" }).parentElement).toBe(capsule);
  });

  it("shows only the download version and opens theme settings from the trailing triangle", async () => {
    render(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/prompts" />);
    const download = await screen.findByRole("link", { name: "下载最新版 v3.7.17" });
    expect(download).toHaveTextContent(/^v3\.7\.17$/);
    const settings = screen.getByRole("button", { name: "外观设置" });
    expect(settings).toHaveAttribute("aria-expanded", "false");
    expect(download.nextElementSibling).toBe(settings);
    expect(screen.queryByRole("group", { name: "主题设置" })).not.toBeInTheDocument();
    fireEvent.click(settings);
    const panel = screen.getByRole("group", { name: "主题设置" });
    fireEvent.click(within(panel).getByRole("button", { name: "切换为浅色" }));
    expect(document.documentElement).toHaveAttribute("data-portal-theme", "light");
    expect(window.localStorage.getItem("plugin-portal.theme")).toBe("light");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(settings).toHaveFocus();
    expect(settings).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(settings);
    fireEvent.pointerDown(document.body);
    expect(settings).toHaveAttribute("aria-expanded", "false");
  });

  it("restores the shared theme on Hub and keeps it available in read-only mode", async () => {
    window.localStorage.setItem("plugin-portal.theme", "light");
    const client = createClient();
    client.getAccessMode = async () => ({ readOnly: true, fileSelectionMode: "none" });
    const { rerender } = render(<PortalShell client={client} initialHash="#/hub" />);
    const toggle = await screen.findByRole("button", { name: "切换为深色" });
    expect(screen.queryByRole("button", { name: "纳入插件" })).not.toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-portal-theme", "light");
    fireEvent.click(toggle);
    expect(document.documentElement).toHaveAttribute("data-portal-theme", "dark");
    rerender(<PortalShell client={client} initialHash="#/plugins/yusheng-inc/mcp" />);
    const settings = await screen.findByRole("button", { name: "外观设置" });
    fireEvent.click(settings);
    fireEvent.click(within(screen.getByRole("group", { name: "主题设置" })).getByRole("button", { name: "切换为浅色" }));
    expect(document.documentElement).toHaveAttribute("data-portal-theme", "light");
    expect(screen.queryByRole("button", { name: /配置流程|新增 Prompt/ })).not.toBeInTheDocument();
  });

  it("changes theme without replacing the page, an open Prompt draft, scroll position or focus", async () => {
    render(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/prompts" />);
    const trigger = await screen.findByRole("button", { name: "新增 Prompt" });
    const main = screen.getByRole("main", { name: "Prompts" });
    fireEvent.click(trigger);
    const draft = screen.getByLabelText("常用场景");
    fireEvent.change(draft, { target: { value: "尚未保存的草稿" } });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 160 });
    fireEvent.click(screen.getByRole("button", { name: "外观设置" }));
    const toggle = within(screen.getByRole("group", { name: "主题设置" })).getByRole("button", { name: "切换为浅色" });
    act(() => toggle.focus());
    fireEvent.click(toggle);
    expect(toggle).toHaveFocus();
    expect(window.scrollY).toBe(160);
    expect(screen.getByRole("main", { name: "Prompts" })).toBe(main);
    expect(screen.getByLabelText("常用场景")).toBe(draft);
    expect(draft).toHaveValue("尚未保存的草稿");
  });

  it("falls back to dark for invalid preferences and still toggles when storage is blocked", async () => {
    window.localStorage.setItem("plugin-portal.theme", "invalid");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      render(<PortalShell client={createClient()} initialHash="#/hub" />);
      const toggle = await screen.findByRole("button", { name: "切换为浅色" });
      expect(document.documentElement).toHaveAttribute("data-portal-theme", "dark");
      fireEvent.click(toggle);
      expect(document.documentElement).toHaveAttribute("data-portal-theme", "light");
    } finally {
      setItem.mockRestore();
    }
  });

  it.each(["#/hub", "#/plugins/project-delivery-hub/overview", "#/plugins/project-delivery-hub/prompts"])(
    "keeps LAN content readable without management controls at %s", async (initialHash) => {
      const client = createClient();
      client.getAccessMode = async () => ({ readOnly: true, fileSelectionMode: "none" });
      render(<PortalShell client={client} initialHash={initialHash} />);
      if (initialHash.endsWith("prompts")) {
        expect(await screen.findByText("研发 Prompt")).toBeInTheDocument();
      } else if (initialHash.endsWith("overview")) {
        expect(await screen.findByRole("main", { name: "鸟瞰全景" })).toBeInTheDocument();
      } else {
        expect(await screen.findByRole("link", { name: "研发助手插件" })).toBeInTheDocument();
      }
      expect(screen.queryByRole("button", { name: /纳入插件|配置流程|新增 Prompt|编辑|删除/ })).not.toBeInTheDocument();
    },
  );

  it("does not enable editing when access metadata fails", async () => {
    const client = createClient();
    client.getAccessMode = async () => { throw new Error("无法确认访问模式"); };
    render(<PortalShell client={client} initialHash="#/plugins/project-delivery-hub/prompts" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法确认访问模式");
    expect(screen.queryByRole("button", { name: "新增 Prompt" })).not.toBeInTheDocument();
  });

  it("keeps the original cover as the canonical root entry", async () => {
    const { container } = render(
      <PortalShell
        client={createClient()}
        initialHash="#/"
      />,
    );

    await waitFor(() => expect(container.querySelector(".hub-cover")).toBeInTheDocument());
    const start = container.querySelector("[data-cover-liquid-glass-button]");
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute("aria-hidden", "true");
    expect(start).toHaveTextContent("");
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "纳入插件" })).not.toBeInTheDocument();
  });

  it("adds plugin inclusion only to the original Hub page", async () => {
    render(
      <PortalShell
        client={createClient()}
        initialHash="#/hub"
      />,
    );

    expect(await screen.findByRole("button", { name: "纳入插件" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "研发助手插件" })).toHaveAttribute(
      "href",
      "#/plugins/project-delivery-hub/overview",
    );
    expect(screen.getByRole("link", { name: "昱勝 Inc" })).toHaveAttribute(
      "href",
      "#/plugins/yusheng-inc/overview",
    );
    expect(screen.queryByLabelText("插件管理")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /^管理 / })).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "纳入插件" }));
    expect(screen.getByRole("dialog", { name: "纳入插件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择插件目录" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "纳入插件" })).not.toBeInTheDocument();
  });

  it("passes remote browser-upload capability to Hub management without hiding actions", async () => {
    const client = createClient();
    client.getAccessMode = async () => ({ readOnly: false, fileSelectionMode: "browser-upload" });
    render(<PortalShell client={client} initialHash="#/hub" />);

    fireEvent.click(await screen.findByRole("button", { name: "纳入插件" }));
    expect(screen.getByLabelText("插件 ZIP")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "选择插件目录" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /发布 .* 下载/ })).not.toHaveLength(0);
  });

  it("refreshes the Hub catalog revision and plugin icon after remote inclusion", async () => {
    const client = createClient();
    const initial = await client.listPlugins();
    client.getAccessMode = async () => ({ readOnly: false, fileSelectionMode: "browser-upload" });
    client.listPlugins = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ ...initial, revision: initial.revision + 1 });
    client.uploadPluginArchive = vi.fn().mockResolvedValue({
      uploadId: "upload-one", fileName: "plugin.zip", archiveBytes: 3,
    });
    client.previewImport = vi.fn().mockResolvedValue({
      candidateId: "candidate-one",
      pluginKey: initial.items[0].pluginKey,
      snapshot: await client.getSnapshot(initial.items[0].pluginKey),
    });
    client.promote = vi.fn().mockResolvedValue({
      revision: initial.revision + 1,
      pluginKey: initial.items[0].pluginKey,
      snapshotId: "c".repeat(64),
    });
    render(<PortalShell client={client} initialHash="#/hub" />);

    const entry = await screen.findByRole("link", { name: initial.items[0].name });
    expect(entry.querySelector("img")).toHaveAttribute(
      "src", `/api/plugins/${encodeURIComponent(initial.items[0].pluginKey)}/icon?revision=${initial.revision}`,
    );
    fireEvent.click(screen.getByRole("button", { name: "纳入插件" }));
    fireEvent.change(screen.getByLabelText("插件 ZIP"), {
      target: { files: [new File(["zip"], "plugin.zip", { type: "application/zip" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "确认纳入" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "纳入插件" })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: initial.items[0].name }).querySelector("img")).toHaveAttribute(
      "src", `/api/plugins/${encodeURIComponent(initial.items[0].pluginKey)}/icon?revision=${initial.revision + 1}`,
    );
  });

  it("reloads the selected plugin data after that plugin is included again", async () => {
    const client = createClient();
    const initial = await client.listPlugins();
    const plugin = initial.items[0];
    const initialSnapshot = await client.getSnapshot(plugin.pluginKey);
    const getSnapshot = vi.spyOn(client, "getSnapshot");
    const getPrompts = vi.spyOn(client, "getPrompts");
    const getWorkflows = vi.spyOn(client, "getWorkflows");
    client.getAccessMode = async () => ({ readOnly: false, fileSelectionMode: "browser-upload" });
    client.listPlugins = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue({ ...initial, revision: initial.revision + 1 });
    client.uploadPluginArchive = vi.fn().mockResolvedValue({
      uploadId: "upload-refresh", fileName: "plugin.zip", archiveBytes: 3,
    });
    client.previewImport = vi.fn().mockResolvedValue({
      candidateId: "candidate-refresh",
      pluginKey: plugin.pluginKey,
      snapshot: initialSnapshot,
    });
    client.promote = vi.fn().mockResolvedValue({
      revision: initial.revision + 1,
      pluginKey: plugin.pluginKey,
      snapshotId: "d".repeat(64),
    });
    window.location.hash = `#/plugins/${plugin.id}/overview`;
    render(<PortalShell client={client} />);

    expect(await screen.findByText("尚未配置鸟瞰全景流程")).toBeInTheDocument();
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(getPrompts).toHaveBeenCalledTimes(1);
    expect(getWorkflows).toHaveBeenCalledTimes(1);

    act(() => {
      window.location.hash = "#/hub";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    fireEvent.click(await screen.findByRole("button", { name: "纳入插件" }));
    fireEvent.change(screen.getByLabelText("插件 ZIP"), {
      target: { files: [new File(["zip"], "plugin.zip", { type: "application/zip" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "确认纳入" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "纳入插件" })).not.toBeInTheDocument());

    act(() => {
      window.location.hash = `#/plugins/${plugin.id}/overview`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(screen.queryByText("正在读取公开资料…")).not.toBeInTheDocument());
    expect(await screen.findByText("尚未配置鸟瞰全景流程")).toBeInTheDocument();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(getPrompts).toHaveBeenCalledTimes(2);
    expect(getWorkflows).toHaveBeenCalledTimes(2);
  });

  it("turns each plugin page into a single-plugin site without management or switching", async () => {
    const { rerender } = render(
      <PortalShell
        client={createClient()}
        initialHash="#/plugins/yusheng-inc/prompts"
      />,
    );

    expect(await screen.findByText("昱勝 Prompt")).toBeInTheDocument();
    expect(screen.queryByText("研发 Prompt")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("当前插件")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理插件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "鸟瞰全景" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "昱勝 Inc" })).toHaveAttribute(
      "href",
      "#/plugins/yusheng-inc/overview",
    );

    rerender(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/prompts" />);
    await waitFor(() => expect(screen.getByText("研发 Prompt")).toBeInTheDocument());
    expect(screen.queryByText("昱勝 Prompt")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Prompts" })).toHaveAttribute(
      "href",
      "#/plugins/project-delivery-hub/prompts",
    );
  });

  it("opens workflow configuration as a dialog from the overview only", async () => {
    render(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/overview" />);
    const trigger = await screen.findByRole("button", { name: "配置流程" });
    expect(trigger.closest(".portal-page-actions")).not.toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "配置流程" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("replaces the sidebar and page heading with one floating capsule", async () => {
    const { container } = render(
      <PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/overview" />,
    );

    const capsule = await screen.findByRole("banner", { name: "插件导航" });
    expect(capsule).toHaveClass("portal-capsule");
    expect(container.querySelector(".portal-sidebar")).toBeNull();
    expect(within(capsule).getByRole("link", { name: "研发助手插件" })).toBeInTheDocument();
    expect(within(capsule).getByRole("navigation", { name: "插件内容" })).toBeInTheDocument();
    expect(await within(capsule).findByRole("link", { name: "下载最新版 v3.7.17" })).toBeInTheDocument();
    expect(await within(capsule).findByRole("button", { name: "配置流程" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole("main", { name: "鸟瞰全景" })).toBeInTheDocument();
  });

  it("mounts page-owned Prompt actions in the capsule without losing modal focus restoration", async () => {
    render(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/prompts" />);

    const capsule = await screen.findByRole("banner", { name: "插件导航" });
    const trigger = await within(capsule).findByRole("button", { name: "新增 Prompt" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "新增 Prompt" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each(["overview", "prompts", "skills"])("keeps download after page actions and before appearance settings on %s", async (page) => {
    render(<PortalShell client={createClient()} initialHash={`#/plugins/project-delivery-hub/${page}`} />);

    const download = await screen.findByRole("link", { name: "下载最新版 v3.7.17" });
    const actions = download.closest(".portal-capsule-actions")!;
    expect(actions.lastElementChild).toBe(screen.getByRole("button", { name: "外观设置" }));
    expect(download.previousElementSibling).toHaveClass("portal-page-actions");
  });

  it("hides after sustained downward scrolling and restores on upward scrolling, focus and route changes", async () => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    const { rerender } = render(
      <PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/skills" />,
    );
    const capsule = await screen.findByRole("banner", { name: "插件导航" });
    expect(capsule).toHaveAttribute("data-visibility", "visible");

    Object.defineProperty(window, "scrollY", { configurable: true, value: 24 });
    fireEvent.scroll(window);
    await waitFor(() => expect(capsule).toHaveAttribute("data-visibility", "visible"));
    Object.defineProperty(window, "scrollY", { configurable: true, value: 48 });
    fireEvent.scroll(window);
    await waitFor(() => expect(capsule).toHaveAttribute("data-visibility", "hidden"));

    Object.defineProperty(window, "scrollY", { configurable: true, value: 38 });
    fireEvent.scroll(window);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 21 });
    fireEvent.scroll(window);
    await waitFor(() => expect(capsule).toHaveAttribute("data-visibility", "visible"));

    Object.defineProperty(window, "scrollY", { configurable: true, value: 104 });
    fireEvent.scroll(window);
    await waitFor(() => expect(capsule).toHaveAttribute("data-visibility", "hidden"));
    fireEvent.focus(within(capsule).getByRole("link", { name: "Skills" }));
    expect(capsule).toHaveAttribute("data-visibility", "visible");

    Object.defineProperty(window, "scrollY", { configurable: true, value: 104 });
    rerender(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/mcp" />);
    await waitFor(() => expect(capsule).toHaveAttribute("data-visibility", "visible"));
  });

  it("uses an exact 24px threshold in both directions outside the top guard", async () => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: 100 });
    render(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/skills" />);
    const capsule = await screen.findByRole("banner", { name: "插件导航" });
    const scroll = async (position: number) => {
      await act(async () => {
        Object.defineProperty(window, "scrollY", { configurable: true, value: position });
        fireEvent.scroll(window);
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      });
    };

    await scroll(123);
    expect(capsule).toHaveAttribute("data-visibility", "visible");
    await scroll(124);
    expect(capsule).toHaveAttribute("data-visibility", "hidden");
    await scroll(101);
    expect(capsule).toHaveAttribute("data-visibility", "hidden");
    await scroll(100);
    expect(capsule).toHaveAttribute("data-visibility", "visible");
    await scroll(0);
    expect(capsule).toHaveAttribute("data-visibility", "visible");
  });

  it("uses input events instead of a persistent focus-visible state to protect keyboard navigation", async () => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: 100 });
    render(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/skills" />);
    const capsule = await screen.findByRole("banner", { name: "插件导航" });
    const skills = within(capsule).getByRole("link", { name: /^Skills$/ });
    const originalMatches = skills.matches.bind(skills);
    const matches = vi.spyOn(skills, "matches").mockImplementation((selector) => (
      selector === ":focus-visible" || originalMatches(selector)
    ));
    const scroll = async (position: number) => {
      await act(async () => {
        Object.defineProperty(window, "scrollY", { configurable: true, value: position });
        fireEvent.scroll(window);
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      });
    };

    try {
      fireEvent.keyDown(window, { key: "Tab" });
      act(() => skills.focus());
      await scroll(124);
      expect(capsule).toHaveAttribute("data-visibility", "visible");

      fireEvent.pointerDown(skills);
      fireEvent.click(skills);
      await scroll(148);
      expect(capsule).toHaveAttribute("data-visibility", "hidden");

      await scroll(124);
      expect(capsule).toHaveAttribute("data-visibility", "visible");
      fireEvent.keyDown(window, { key: "Tab" });
      await scroll(148);
      expect(capsule).toHaveAttribute("data-visibility", "visible");

      fireEvent.pointerDown(document.body);
      await scroll(172);
      expect(capsule).toHaveAttribute("data-visibility", "hidden");
    } finally {
      matches.mockRestore();
    }
  });

  it("offers the same six links from the compact navigation and restores focus when it closes", async () => {
    render(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/mcp" />);

    const capsule = await screen.findByRole("banner", { name: "插件导航" });
    expect(within(capsule).getByText("MCP", { selector: ".portal-capsule-current span" })).toBeInTheDocument();
    const more = within(capsule).getByRole("button", { name: "打开导航菜单" });
    const navigation = within(capsule).getByRole("navigation", { name: "插件内容" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(navigation).toHaveAttribute("data-expanded", "false");

    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(navigation).toHaveAttribute("data-expanded", "true");
    expect(within(navigation).getAllByRole("link")).toHaveLength(6);
    expect(within(navigation).getByRole("link", { name: "MCP" })).toHaveAttribute("aria-current", "page");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveFocus();

    fireEvent.click(more);
    fireEvent.pointerDown(document.body);
    expect(more).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(more);
    const skills = within(navigation).getByRole("link", { name: "Skills" });
    skills.focus();
    fireEvent.click(skills);
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveFocus();
  });

  it("forces a hidden capsule back into view while a modal is open", async () => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    render(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/overview" />);
    const capsule = await screen.findByRole("banner", { name: "插件导航" });
    const trigger = await within(capsule).findByRole("button", { name: "配置流程" });

    Object.defineProperty(window, "scrollY", { configurable: true, value: 70 });
    fireEvent.scroll(window);
    await waitFor(() => expect(capsule).toHaveAttribute("data-visibility", "hidden"));
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "配置流程" })).toBeInTheDocument();
    await waitFor(() => expect(capsule).toHaveAttribute("data-visibility", "visible"));
  });

  it("restores the plugin brand, navigation icons and overview download action", async () => {
    const { container } = render(
      <PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/overview" />,
    );

    const brand = await screen.findByRole("link", { name: "研发助手插件" });
    const brandImage = brand.querySelector("img");
    expect(brandImage).not.toBeNull();
    fireEvent.error(brandImage!);
    expect(brand.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Skills" }).querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Prompts" }).querySelector("svg")).not.toBeNull();
    expect(container.querySelectorAll("nav[aria-label='插件内容'] svg")).toHaveLength(6);
    expect(await screen.findByRole("link", { name: "下载最新版 v3.7.17" })).toBeInTheDocument();
  });

  it("uses the selected menu name as the accessible main label and keeps download in the capsule", async () => {
    const { rerender } = render(
      <PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/overview" />,
    );

    expect(await screen.findByRole("main", { name: "鸟瞰全景" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    const download = await screen.findByRole("link", { name: "下载最新版 v3.7.17" });
    expect(download.closest(".portal-capsule-actions")).not.toBeNull();

    rerender(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/skills" />);
    expect(await screen.findByRole("main", { name: "Skills" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载最新版 v3.7.17" })).toBeInTheDocument();

    rerender(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/releases" />);
    expect(await screen.findByRole("main", { name: "版本沿革" })).toBeInTheDocument();
  });

  it("keeps a delayed download probe after the main plugin content renders", async () => {
    let resolveDownload!: (value: {
      available: boolean;
      version: string;
      href: string | null;
    }) => void;
    const client = {
      ...createClient(),
      getDownloadInfo: () => new Promise((resolve) => { resolveDownload = resolve; }),
    } satisfies PortalDataClient;

    render(<PortalShell client={client} initialHash="#/plugins/project-delivery-hub/overview" />);

    expect(await screen.findByRole("button", { name: "下载最新版 v3.7.17" })).toBeDisabled();
    resolveDownload({
      available: true,
      version: "3.7.17",
      href: "http://127.0.0.1:9134/downloads/project-delivery-hub-3.7.17-company-dev.zip",
    });

    expect(await screen.findByRole("link", { name: "下载最新版 v3.7.17" })).toBeInTheDocument();
  });

  it("shows the same verified download action on releases", async () => {
    render(<PortalShell client={createClient()} initialHash="#/plugins/project-delivery-hub/releases" />);

    expect(await screen.findByRole("link", { name: "下载最新版 v3.7.17" })).toBeInTheDocument();
  });

  it("does not expose a broken download link when the formal package is unavailable", async () => {
    render(<PortalShell client={createClient()} initialHash="#/plugins/yusheng-inc/releases" />);

    const unavailable = await screen.findByRole("button", { name: "下载最新版 v1.1.4" });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveAttribute("title", "该插件未提供可下载版本");
    expect(screen.queryByRole("link", { name: "下载最新版 v1.1.4" })).not.toBeInTheDocument();
  });
});
