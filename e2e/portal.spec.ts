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

  test("previews without mutation, promotes two plugins and rolls one back", async () => {
    await expect.poll(() => portal.listPlugins()).toMatchObject({ revision: 0, items: [] });

    const first = await portal.preview("project-delivery-hub", "3.7.17", "研发助手插件");
    expect(first.snapshot.plugin.version).toBe("3.7.17");
    expect((await portal.listPlugins()).items).toHaveLength(0);
    await portal.promote(first, 0);

    const refreshed = await portal.preview("project-delivery-hub", "3.7.18", "研发助手插件");
    await portal.promote(refreshed, 1);
    expect((await portal.snapshot("company-dev/project-delivery-hub")).plugin.version).toBe("3.7.18");
    await portal.rollback("company-dev/project-delivery-hub", 2);
    expect((await portal.snapshot("company-dev/project-delivery-hub")).plugin.version).toBe("3.7.17");

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
    await page.getByLabel("当前插件").selectOption("project-delivery-hub");
    await expect(page.getByText("研发 Prompt")).toBeVisible();
    await expect(page).toHaveURL(`${portal.baseUrl}/#/plugins/project-delivery-hub/prompts`);
    await page.reload();
    await expect(page.getByText("研发 Prompt")).toBeVisible();
    await expect(page.getByRole("link", { name: "Prompts" })).toHaveAttribute(
      "href",
      "#/plugins/project-delivery-hub/prompts",
    );

    await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/overview`);
    await expect(page.getByRole("tab", { name: "插件安装" })).toBeVisible();
    await expect(page.getByText("取得插件包")).toBeVisible();
    await page.getByLabel("当前插件").selectOption("yusheng-inc");
    await expect(page.getByText("尚未配置鸟瞰全景流程")).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });

  test("refreshes and rolls back a selected plugin from the management panel", async ({ page }) => {
    const pluginRoot = portal.preparePlugin("project-delivery-hub", "3.7.19", "研发助手插件");
    await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/releases`);
    await expect(page.getByText("v3.7.17")).toBeVisible();
    await page.getByRole("button", { name: "管理插件" }).click();
    await page.getByLabel("插件目录").fill(pluginRoot);
    await page.getByRole("button", { name: "预览插件" }).click();
    await expect(page.getByText("版本 3.7.17 → 3.7.19")).toBeVisible();
    await page.getByRole("button", { name: "确认刷新" }).click();
    await expect(page.getByRole("button", { name: "回滚上一版" })).toBeVisible();
    await page.getByRole("button", { name: "管理插件" }).click();
    await expect(page.getByText("v3.7.19")).toBeVisible();

    await page.getByRole("button", { name: "管理插件" }).click();
    await page.getByRole("button", { name: "回滚上一版" }).click();
    await page.getByRole("button", { name: "管理插件" }).click();
    await expect(page.getByText("v3.7.18")).toBeVisible();
  });

  test("keeps every fixed page reachable without horizontal overflow", async ({ page }) => {
    for (const width of [768, 1120, 1600]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/overview`);
      for (const name of ["鸟瞰全景", "Skills", "Prompts", "MCP", "扩展工具", "工程规范", "版本沿革"]) {
        await expect(page.getByRole("link", { name })).toBeVisible();
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(overflow).toBe(false);
    }
  });
});
