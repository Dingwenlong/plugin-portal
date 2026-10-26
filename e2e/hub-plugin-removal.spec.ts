import { expect, test, type Page } from "@playwright/test";
import { startTestPortal, type TestPortal } from "./testServer";

let portal: TestPortal;
const key = "company-dev/project-delivery-hub";
const primaryKey = "company-internal/project-delivery-hub";
const entry = (page: Page) => page.getByRole("link", { name: "研发助手插件", exact: true });
test.beforeEach(async () => {
  portal = await startTestPortal();
  await portal.promote(await portal.preview("project-delivery-hub", "3.7.19", "研发助手插件"), 0);
});
test.afterEach(async () => { await portal?.stop(); });

test("right-click and keyboard removal preserve other sources, refresh the list, and allow reimport", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await portal.promote(await portal.preview("project-delivery-hub", "4.0.0", "研发助手插件", "company-internal"), 1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${portal.baseUrl}/#/club`);
  await entry(page).click({ button: "right" });
  await expect(page).toHaveURL(`${portal.baseUrl}/#/club`);
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "删除" })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("hub-context-menu.png") });
  await page.keyboard.press("Escape");
  await expect(entry(page)).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await menu.getByRole("menuitem", { name: "删除" }).click();
  let dialog = page.getByRole("dialog", { name: "删除插件" });
  await expect(dialog.getByText(primaryKey)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("hub-delete-confirm.png") });
  await dialog.getByRole("button", { name: "取消" }).click();
  expect((await portal.listPlugins()).revision).toBe(2);
  await expect(entry(page)).toBeFocused();
  await page.getByText("其他来源与版本").click();
  await page.getByRole("link", { name: "研发助手插件 v3.7.19 · company-dev" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除" }).click();
  await expect(dialog.getByText(key)).toBeVisible();
  await dialog.getByRole("button", { name: "确认删除" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(entry(page)).toHaveAttribute("href", `#/plugins/${encodeURIComponent(primaryKey)}/overview`);
  await expect(entry(page)).toBeFocused();
  expect((await portal.listPlugins()).items.map((item) => item.pluginKey)).toEqual([primaryKey]);
  await page.reload();
  await expect(page.getByText("其他来源与版本")).toHaveCount(0);
  await entry(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除" }).click();
  await dialog.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByText("尚未纳入插件", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "纳入插件" })).toBeFocused();
  await page.getByRole("button", { name: "纳入插件" }).click();
  dialog = page.getByRole("dialog", { name: "纳入插件" });
  await dialog.getByRole("button", { name: "选择插件目录" }).click();
  await dialog.getByRole("button", { name: "确认纳入" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(entry(page)).toHaveAttribute("href", `#/plugins/${encodeURIComponent(key)}/overview`);
  expect((await portal.listPlugins()).revision).toBe(5);
  expect(errors).toEqual([]);
});

test("stale confirmation requires refreshed selection; mobile layout and read-only context menu remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${portal.baseUrl}/#/club`);
  await entry(page).click({ button: "right" });
  const box = await page.getByRole("menu").boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.getByRole("menuitem", { name: "删除" }).click();
  await page.screenshot({ path: test.info().outputPath("hub-delete-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await portal.promote(await portal.preview("project-delivery-hub", "3.7.20", "研发助手插件"), 1);
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByRole("alert")).toContainText("插件列表已更新");
  await expect(page.getByRole("button", { name: "确认删除" })).toHaveCount(0);
  await page.getByRole("button", { name: "刷新列表并关闭" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await portal.listPlugins()).items[0].version).toBe("3.7.20");
  await page.goto(`${await portal.startReadOnly()}/#/club`);
  await entry(page).click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await entry(page).focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test.describe("isolated HTTPS fixture", () => {
// The fixture generates a temporary CA without installing it in the user's trust store.
test.use({ ignoreHTTPSErrors: true });
test.skip(!process.env.PORTAL_CADDY_PATH, "需要 PORTAL_CADDY_PATH 才能运行隔离 HTTPS 验收");
test("HTTPS removal reconciles a lost response without replaying the delete request", async ({ page }) => {
  const remote = await portal.startRemoteManagement();
  let deletes = 0;
  await page.route("**/api/plugins/*/remove", async (route) => {
    deletes += 1;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort("connectionreset");
  });
  await page.goto(`${remote}/#/club`);
  await entry(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除" }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("尚未纳入插件", { exact: true })).toBeVisible();
  await page.reload();
  expect(await portal.listPlugins()).toEqual({ revision: 2, items: [] });
  expect(deletes).toBe(1);
});
});
