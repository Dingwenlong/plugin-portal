import { expect, test } from "@playwright/test";
import { startTestPortal, type TestPortal } from "./testServer";

test.use({ ignoreHTTPSErrors: true }); // Temporary CA in the isolated HTTPS fixture.
test.skip(!process.env.PORTAL_CADDY_PATH, "需要 PORTAL_CADDY_PATH 才能运行隔离 HTTPS 验收");
let portal: TestPortal;
test.beforeEach(async () => { portal = await startTestPortal({ realAudit: true }); });
test.afterEach(async () => { await portal?.stop(); });

test("older marketplace bundle is detected, rules are selected and previewed, and the exact upload is published", async ({ page }) => {
  const key = "company-internal/project-delivery-hub";
  await portal.promote(await portal.preview("project-delivery-hub", "4.3.6", "研发助手插件", "company-internal"), 0);
  const archive = portal.prepareMarketplaceArchive("company-internal", "4.3.1");
  const remote = await portal.startRemoteManagement();
  await page.goto(`${remote}/#/club`);
  await page.getByRole("button", { name: "纳入插件" }).click();
  const dialog = page.getByRole("dialog", { name: "纳入插件" });
  await dialog.getByLabel("插件 ZIP", { exact: true }).setInputFiles(archive);
  await expect(dialog.getByText("该来源当前为 v4.3.6，确认后切换为 v4.3.1。")).toBeVisible();
  await dialog.getByText("高级公开内容（可选）").click();
  await expect(dialog.getByLabel("来源市场", { exact: true })).toHaveValue("company-internal");
  await expect(dialog.getByLabel("来源市场", { exact: true })).toHaveAttribute("readonly", "");
  await expect(dialog.getByLabel("公开规范相对路径")).toHaveCount(0);
  await dialog.getByLabel("搜索规范文件").fill("public.md");
  await dialog.getByRole("button", { name: "预览 rules/public.md", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "规范正文预览" }).locator("pre")).not.toBeEmpty();
  await page.screenshot({ path: test.info().outputPath("import-rule-picker-desktop.png") });
  await dialog.getByRole("button", { name: "关闭正文预览" }).click();
  await expect(dialog.getByRole("button", { name: "预览 rules/public.md", exact: true })).toBeFocused();
  await dialog.getByLabel("公开 rules/public.md", { exact: true }).check();
  await expect(dialog.getByRole("button", { name: "确认纳入" })).toBeDisabled();
  await dialog.getByRole("button", { name: "更新规范预览" }).click();
  await expect(dialog.getByText("只读公开内容：Skills、MCP 服务 ID 与 1 份规范正文。")).toBeVisible();
  await dialog.getByRole("button", { name: "确认纳入" }).click();
  await expect(dialog).toHaveCount(0);
  const catalog = await portal.listPlugins();
  expect(catalog.items.map(({ pluginKey, version }) => ({ pluginKey, version }))).toEqual([{ pluginKey: key, version: "4.3.1" }]);
  expect(portal.hasPublishedDownload("project-delivery-hub-4.3.1-company-internal.zip")).toBe(true);
  expect(portal.hasPublishedDownload("project-delivery-hub-4.3.1-company-dev.zip")).toBe(false);
  await page.reload();
  await expect(page.getByText("v4.3.1", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "研发助手插件" }).click();
  await page.getByRole("link", { name: "工程规范", exact: true }).click();
  await expect(page.getByRole("button", { name: "rules/public.md", exact: true })).toBeVisible();
});

test("mobile rule selection can be cancelled without changing the catalog", async ({ page }) => {
  const archive = portal.prepareMarketplaceArchive("company-internal", "4.3.1");
  const remote = await portal.startRemoteManagement();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${remote}/#/club`);
  await page.getByRole("button", { name: "纳入插件" }).click();
  const dialog = page.getByRole("dialog", { name: "纳入插件" });
  await dialog.getByLabel("插件 ZIP", { exact: true }).setInputFiles(archive);
  await expect(dialog.getByText("将纳入 研发助手插件 v4.3.1")).toBeVisible();
  await dialog.getByText("高级公开内容（可选）").click();
  await dialog.getByLabel("搜索规范文件").fill("public.md");
  await dialog.getByLabel("公开 rules/public.md", { exact: true }).check();
  await page.screenshot({ path: test.info().outputPath("import-rule-picker-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await dialog.getByRole("button", { name: "放弃并关闭" }).click();
  expect(await portal.listPlugins()).toEqual({ revision: 0, items: [] });
});
