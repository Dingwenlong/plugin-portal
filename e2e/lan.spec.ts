import { expect, test } from "@playwright/test";
import { startTestPortal, type TestPortal } from "./testServer";

let local: TestPortal;
let baseUrl: string;

test.beforeEach(async () => {
  local = await startTestPortal();
  await local.promote(await local.preview("project-delivery-hub", "3.7.17", "研发助手插件"), 0);
  await local.promote(await local.preview("yusheng-inc", "1.1.5", "昱胜 Inc"), 1);
  await local.seedUserContent();
  baseUrl = await local.startReadOnly();
});
test.afterEach(async () => { await local?.stop(); });

test("LAN exposes approved content but no inclusion, workflow or Prompt writes", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl + "/#/hub");
  await expect(page.getByRole("link", { name: "研发助手插件" })).toBeVisible();
  await expect(page.getByRole("button", { name: "纳入插件" })).toHaveCount(0);
  await page.getByRole("link", { name: "研发助手插件" }).click();
  await expect(page.getByRole("heading", { name: "首次安装" })).toBeVisible();
  await expect(page.getByRole("button", { name: "配置流程" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "下载最新版 v3.7.17" }))
    .toHaveAttribute("href", "/api/plugins/company-dev%2Fproject-delivery-hub/download");
  await page.getByRole("link", { name: "Prompts", exact: true }).click();
  await expect(page.getByText("研发 Prompt", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /新增 Prompt|编辑|删除/ })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "操作" })).toHaveCount(0);
  for (const name of ["Skills", "MCP", "扩展工具", "工程规范", "版本沿革"]) {
    await page.getByRole("link", { name, exact: true }).click();
    await expect(page.getByRole("main", { name, exact: true })).toBeVisible();
  }
  const prefix = baseUrl + "/api/plugins/company-dev%2Fproject-delivery-hub";
  const before = await (await request.get(prefix + "/prompts")).body();
  for (const path of ["/api/session", "/api/plugins/import/preview", "/api/plugins/import/select-directory",
    "/api/plugins/company-dev%2Fproject-delivery-hub/prompts", "/api/plugins/company-dev%2Fproject-delivery-hub/workflows"]) {
    expect((await request.post(baseUrl + path, { data: {} })).status()).toBe(403);
  }
  expect(await (await request.get(prefix + "/prompts")).body()).toEqual(before);
  expect(errors).toEqual([]);
});

test("LAN keeps desktop and compact navigation with readable personal data", async ({ page }) => {
  for (const width of [1600, 1120, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(baseUrl + "/#/plugins/project-delivery-hub/prompts");
    await expect(page.getByText("研发 Prompt", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width < 900) {
      await page.getByRole("button", { name: "打开导航菜单" }).click();
      await expect(page.getByRole("link", { name: "工程规范", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "打开导航菜单" })).toBeFocused();
    }
  }
  await page.goto(baseUrl + "/#/plugins/yusheng-inc/prompts");
  await expect(page.getByText("昱勝 Prompt", { exact: true })).toBeVisible();
  await expect(page.getByText("研发 Prompt", { exact: true })).toHaveCount(0);
});
