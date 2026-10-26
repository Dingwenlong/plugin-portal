import { expect, test, type Page } from "@playwright/test";
import { startTestPortal, type TestPortal } from "./testServer";

let portal: TestPortal;
const rowIds = (page: Page) => page.locator("[data-family-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-family-id")));
test.beforeEach(async () => {
  portal = await startTestPortal();
  for (const [index, id] of ["alpha", "beta", "gamma"].entries()) {
    await portal.promote(await portal.preview(id, "1.0.0", id), index);
  }
  await portal.promote(await portal.preview("beta", "2.0.0", "beta", "company-internal"), 3);
});
test.afterEach(async () => { await portal?.stop(); });

test("drag reorder persists entire plugin families across refresh and read-only clients", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${portal.baseUrl}/#/club`);
  await expect(page.getByRole("heading", { name: "Plugin Family" })).toBeVisible();
  const handle = page.getByRole("button", { name: "调整 gamma 顺序" });
  const firstRow = page.locator('[data-family-id="alpha"]');
  await handle.dragTo(firstRow, { targetPosition: { x: 100, y: 8 } });
  await expect.poll(() => rowIds(page)).toEqual(["gamma", "alpha", "beta"]);
  await page.reload();
  await expect.poll(() => rowIds(page)).toEqual(["gamma", "alpha", "beta"]);
  await page.getByRole("link", { name: "beta", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "上移" }).click();
  await expect.poll(() => rowIds(page)).toEqual(["gamma", "beta", "alpha"]);
  await expect(page.getByRole("link", { name: "beta", exact: true })).toHaveAttribute("href", "#/plugins/company-internal%2Fbeta/overview");
  await page.getByText("其他来源与版本").click();
  await expect(page.getByRole("link", { name: "beta v1.0.0 · company-dev" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("plugin-family-desktop.png") });
  const readOnly = await portal.startReadOnly();
  const context = await browser.newContext();
  const reader = await context.newPage();
  try {
    await reader.goto(`${readOnly}/#/club`);
    await expect.poll(() => rowIds(reader)).toEqual(["gamma", "beta", "alpha"]);
    await expect(reader.getByRole("button", { name: /调整 .* 顺序/ })).toHaveCount(0);
    await reader.getByRole("link", { name: "beta", exact: true }).click({ button: "right" });
    await expect(reader.getByRole("menu")).toHaveCount(0);
  } finally { await context.close(); }
  await portal.promote(await portal.preview("aardvark", "1.0.0", "aardvark"), (await portal.listPlugins()).revision);
  await page.reload();
  await expect.poll(() => rowIds(page)).toEqual(["gamma", "beta", "alpha", "aardvark"]);
});

test("mobile menu moves entries and keeps Plugin Family heading and actions within viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${portal.baseUrl}/#/club`);
  await page.getByRole("button", { name: "调整 alpha 顺序" }).click();
  await expect(page.getByRole("menuitem", { name: "上移" })).toBeDisabled();
  await page.getByRole("menuitem", { name: "下移" }).click();
  await expect.poll(() => rowIds(page)).toEqual(["beta", "alpha", "gamma"]);
  await page.getByRole("button", { name: "调整 alpha 顺序" }).click();
  await page.screenshot({ path: test.info().outputPath("plugin-family-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "调整 alpha 顺序" })).toBeFocused();
});

test("a concurrent import requires refresh and cannot be lost to stale ordering", async ({ page }) => {
  await page.goto(`${portal.baseUrl}/#/club`);
  await page.getByRole("link", { name: "beta", exact: true }).click({ button: "right" });
  await portal.promote(await portal.preview("delta", "1.0.0", "delta"), 4);
  await page.getByRole("menuitem", { name: "上移" }).click();
  await expect(page.getByText("列表已变化，请刷新后重新调整顺序。")).toBeVisible();
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await expect(page.getByRole("link", { name: "delta", exact: true })).toBeVisible();
  expect((await portal.listPlugins()).revision).toBe(5);
});

test("lost successful response is reconciled without replaying ordering", async ({ page }) => {
  let writes = 0;
  await page.route("**/api/plugins/order", async (route) => {
    writes += 1;
    expect((await route.fetch()).status()).toBe(200);
    await route.abort("connectionreset");
  });
  await page.goto(`${portal.baseUrl}/#/club`);
  await page.getByRole("button", { name: "调整 beta 顺序" }).click();
  await page.getByRole("menuitem", { name: "上移" }).click();
  await expect.poll(() => rowIds(page)).toEqual(["beta", "alpha", "gamma"]);
  await expect(page.getByRole("button", { name: "调整 beta 顺序" })).toBeEnabled();
  expect(writes).toBe(1);
});
