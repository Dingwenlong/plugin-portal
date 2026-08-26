import { expect, test } from "@playwright/test";

import { startTestPortal, type TestPortal } from "./testServer";

test.describe.serial("Plugin Portal", () => {
  let portal: TestPortal;

  test.beforeAll(async () => {
    portal = await startTestPortal();
  });

  test.afterAll(async () => {
    await portal?.stop();
  });

  test("keeps the original cover and opens plugin inclusion from the Hub", async ({ page }) => {
    const remoteRequests: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(portal.baseUrl)) remoteRequests.push(request.url());
    });
    await page.goto(`${portal.baseUrl}/#/`);
    await expect(page.locator(".hub-cover")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
    await expect(page.locator("[data-cover-accretion-canvas]")).toHaveAttribute("data-render-state", "ready");
    await expect(page.getByRole("button", { name: "纳入插件" })).toHaveCount(0);

    await page.getByRole("button", { name: "Start" }).click();
    await expect(page).toHaveURL(`${portal.baseUrl}/#/hub`);
    await expect(page.getByRole("button", { name: "纳入插件" })).toBeVisible();
    await page.getByRole("button", { name: "纳入插件" }).click();
    await expect(page.getByRole("dialog", { name: "纳入插件" })).toBeVisible();
    await expect(page.getByLabel("插件目录")).toHaveAttribute("readonly", "");
    await expect(page.getByLabel("插件 ID")).toHaveCount(0);

    await page.getByRole("button", { name: "选择插件目录" }).click();
    await expect(page.getByText("将纳入 研发助手插件 v3.7.19")).toBeVisible();
    await page.getByRole("button", { name: "确认纳入" }).click();

    await expect(page.getByRole("dialog", { name: "纳入插件" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "研发助手插件" })).toHaveAttribute(
      "href",
      "#/plugins/project-delivery-hub/overview",
    );
    await expect.poll(() => portal.listPlugins()).toMatchObject({
      revision: 1,
      items: [{ id: "project-delivery-hub", version: "3.7.19" }],
    });
    await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/skills`);
    await expect(page.getByText("示例技能", { exact: true })).toBeVisible();
    await expect(page.getByText("sample-skill", { exact: true })).toBeVisible();
    expect(remoteRequests).toEqual([]);
  });

  test("previews without mutation, promotes two plugins and rolls one back", async () => {
    await expect.poll(() => portal.listPlugins()).toMatchObject({ revision: 1 });

    const refreshed = await portal.preview("project-delivery-hub", "3.7.20", "研发助手插件");
    expect((await portal.snapshot("company-dev/project-delivery-hub")).plugin.version).toBe("3.7.19");
    await portal.promote(refreshed, 1);
    expect((await portal.snapshot("company-dev/project-delivery-hub")).plugin.version).toBe("3.7.20");
    await portal.rollback("company-dev/project-delivery-hub", 2);
    expect((await portal.snapshot("company-dev/project-delivery-hub")).plugin.version).toBe("3.7.19");

    const yusheng = await portal.preview("yusheng-inc", "1.1.4", "昱勝 Inc");
    await portal.promote(yusheng, 3);
    expect((await portal.listPlugins()).items.map((item) => item.id)).toEqual([
      "project-delivery-hub",
      "yusheng-inc",
    ]);
  });

  test("keeps Prompts and workflows isolated in the real browser", async ({ page }) => {
    await portal.seedUserContent();
    const consoleErrors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });

    await page.goto(`${portal.baseUrl}/#/plugins/yusheng-inc/prompts`);
    await expect(page.getByText("昱勝 Prompt")).toBeVisible();
    await expect(page.getByText("研发 Prompt")).toHaveCount(0);
    await expect(page.getByLabel("当前插件")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "管理插件" })).toHaveCount(0);
    await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/prompts`);
    await expect(page.getByText("研发 Prompt")).toBeVisible();
    await page.getByRole("button", { name: "新增 Prompt" }).click();
    await expect(page.getByRole("dialog", { name: "新增 Prompt" })).toBeVisible();
    await page.getByLabel("常用场景").fill("检查交付");
    await page.getByLabel("Prompt 内容").fill("核对公开资料和流程。");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("检查交付")).toBeVisible();
    await page.reload();
    await expect(page.getByText("研发 Prompt")).toBeVisible();
    await expect(page.getByRole("link", { name: "Prompts" })).toHaveAttribute(
      "href",
      "#/plugins/project-delivery-hub/prompts",
    );

    await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/overview`);
    await expect(page.getByRole("tab", { name: "插件安装" })).toBeVisible();
    await expect(page.getByText("取得插件包")).toBeVisible();
    await expect(page.getByRole("link", { name: "鸟瞰全景" })).toHaveCount(0);
    await page.getByRole("button", { name: "配置流程" }).click();
    await expect(page.getByRole("dialog", { name: "配置流程" })).toBeVisible();
    await expect(page.getByLabel("Tab 标题")).toHaveValue("插件安装");
    await expect(page.getByLabel("流程区域标题")).toHaveValue("首次安装");
    await expect(page.getByLabel("步骤标题")).toHaveValue("取得插件包");
    await page.getByRole("button", { name: "关闭" }).click();
    await page.goto(`${portal.baseUrl}/#/plugins/yusheng-inc/overview`);
    await expect(page.getByText("尚未配置鸟瞰全景流程")).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });

  test("refreshes and rolls back a plugin only from the Hub", async ({ page }) => {
    portal.preparePickerPlugin("3.7.21");
    await page.goto(`${portal.baseUrl}/#/hub`);
    await page.getByRole("button", { name: "管理 研发助手插件" }).click();
    await expect(page.getByRole("dialog", { name: "管理 研发助手插件" })).toBeVisible();
    await expect(page.getByLabel("插件目录")).toHaveAttribute("readonly", "");
    await expect(page.getByLabel("插件 ID")).toHaveCount(0);
    await page.getByRole("button", { name: "选择插件目录" }).click();
    await expect(page.getByText("版本 3.7.19 → 3.7.21")).toBeVisible();
    await page.getByRole("button", { name: "确认刷新" }).click();
    await expect(page.getByRole("dialog", { name: "管理 研发助手插件" })).toHaveCount(0);
    await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/releases`);
    await expect(page.getByText("v3.7.21")).toBeVisible();

    await page.goto(`${portal.baseUrl}/#/hub`);
    await page.getByRole("button", { name: "管理 研发助手插件" }).click();
    await page.getByRole("button", { name: "回滚上一版" }).click();
    await expect(page.getByRole("dialog", { name: "管理 研发助手插件" })).toHaveCount(0);
    await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/releases`);
    await expect(page.getByText("v3.7.20")).toBeVisible();
  });

  test("keeps every fixed page reachable without horizontal overflow", async ({ page }) => {
    for (const width of [768, 1120, 1600]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/overview`);
      await expect(page.getByRole("link", { name: "研发助手插件" })).toHaveAttribute("href", "#/plugins/project-delivery-hub/overview");
      for (const name of ["Skills", "Prompts", "MCP", "扩展工具", "工程规范", "版本沿革"]) {
        await expect(page.getByRole("link", { name })).toBeVisible();
      }
      await expect(page.getByRole("link", { name: "鸟瞰全景" })).toHaveCount(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(overflow).toBe(false);
    }
  });
});
