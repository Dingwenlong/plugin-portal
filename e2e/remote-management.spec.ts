import { chromium, expect, test } from "@playwright/test";

import { startTestPortal, type TestPortal } from "./testServer";

test.use({ ignoreHTTPSErrors: true });
test.skip(!process.env.PORTAL_CADDY_PATH, "需要 PORTAL_CADDY_PATH 才能运行隔离 HTTPS 验收");

let portal: TestPortal;
let baseUrl: string;

test.beforeEach(async () => {
  portal = await startTestPortal();
  baseUrl = await portal.startRemoteManagement();
});

test.afterEach(async () => {
  await portal?.stop();
});

test("remote HTTPS management uploads, edits and publishes without server paths", async ({ page, request }) => {
  test.setTimeout(90_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  const access = await request.get(`${baseUrl}/api/access`);
  expect(access.status()).toBe(200);
  expect(await access.json()).toEqual({ readOnly: false, fileSelectionMode: "browser-upload" });
  const crossOrigin = await request.get(`${baseUrl}/api/access`, {
    headers: { Origin: "https://untrusted.example" },
  });
  expect(crossOrigin.status()).toBe(403);
  await expect(crossOrigin.json()).resolves.toMatchObject({ error: { code: "cross_origin" } });

  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${baseUrl}/#/hub`);
  await expect(page.getByRole("button", { name: "纳入插件" })).toBeVisible();
  await page.getByRole("button", { name: "纳入插件" }).click();
  const includeDialog = page.getByRole("dialog", { name: "纳入插件" });
  await expect(includeDialog.getByLabel("插件目录")).toHaveCount(0);
  await includeDialog.getByLabel("插件 ZIP").setInputFiles(portal.pluginArchivePath);
  await expect(includeDialog.getByText("将纳入 研发助手插件 v3.7.19", { exact: true })).toBeVisible();
  await includeDialog.getByRole("button", { name: "确认纳入" }).click();
  await expect(includeDialog).toHaveCount(0);

  const pluginLink = page.getByRole("link", { name: "研发助手插件" });
  await expect(pluginLink).toBeVisible();
  const icon = pluginLink.locator("img");
  await expect(icon).toHaveAttribute(
    "src",
    "/api/plugins/company-dev%2Fproject-delivery-hub/icon?revision=1",
  );
  await expect.poll(() => icon.evaluate((element) => {
    const image = element as HTMLImageElement;
    return image.complete && image.naturalWidth > 0;
  })).toBe(true);

  await pluginLink.click();
  await page.getByRole("link", { name: "Prompts", exact: true }).click();
  await page.getByRole("button", { name: "新增 Prompt", exact: true }).click();
  const promptDialog = page.getByRole("dialog", { name: "新增 Prompt" });
  await promptDialog.getByLabel("常用场景").fill("远程管理验收");
  await promptDialog.getByLabel("Prompt 内容").fill("跨网段浏览器管理资料。 ");
  await promptDialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("远程管理验收", { exact: true })).toBeVisible();

  await page.goto(`${baseUrl}/#/plugins/project-delivery-hub/overview`);
  await page.getByRole("button", { name: "配置流程", exact: true }).click();
  const workflowDialog = page.getByRole("dialog", { name: "配置流程" });
  await workflowDialog.getByRole("button", { name: "新增 Tab" }).click();
  await workflowDialog.getByLabel("Tab 标题").fill("远程流程");
  await workflowDialog.getByRole("button", { name: "保存流程" }).click();
  await expect(workflowDialog).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "远程流程" })).toBeVisible();

  await page.goto(`${baseUrl}/#/hub`);
  await page.getByRole("button", { name: "发布 研发助手插件 下载" }).click();
  const publication = page.getByRole("dialog", { name: "发布 研发助手插件 下载" });
  await expect(publication.getByRole("button", { name: "选择候选 ZIP" })).toHaveCount(0);
  await publication.getByLabel("下载候选 ZIP").setInputFiles(portal.downloadArchivePath);
  await expect(publication.getByText("project-delivery-hub-3.7.19-company-dev.zip", { exact: true })).toBeVisible();
  await publication.getByRole("button", { name: "确认发布" }).click();
  await expect(publication.getByRole("status")).toContainText("发布成功");
  expect(portal.hasPublishedDownload("project-delivery-hub-3.7.19-company-dev.zip")).toBe(true);
  expect(portal.publishedDownloadSha256("project-delivery-hub-3.7.19-company-dev.zip"))
    .toBe(portal.expectedCandidateSha256);

  await page.goto(`${baseUrl}/#/plugins/project-delivery-hub/skills`);
  await expect(page.getByRole("link", { name: "下载最新版 v3.7.19" })).toHaveAttribute(
    "href",
    "/api/plugins/company-dev%2Fproject-delivery-hub/download",
  );

  for (const width of [1600, 1120, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${baseUrl}/#/plugins/project-delivery-hub/prompts`);
    await expect(page.getByRole("button", { name: "新增 Prompt", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "下载最新版 v3.7.19" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width < 1024) {
      await page.getByRole("button", { name: "打开导航菜单" }).click();
      await expect(page.getByRole("link", { name: "工程规范", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await page.goto(`${baseUrl}/#/hub`);
    await expect(page.getByRole("button", { name: "纳入插件" })).toBeVisible();
    await expect(page.getByRole("button", { name: "发布 研发助手插件 下载" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }

  if (process.env.PORTAL_EDGE_CHECK === "1") {
    const edge = await chromium.launch({ channel: "msedge", headless: true });
    try {
      const context = await edge.newContext({ ignoreHTTPSErrors: true });
      const edgePage = await context.newPage();
      await edgePage.goto(`${baseUrl}/#/hub`);
      await expect(edgePage.getByRole("link", { name: "研发助手插件" })).toBeVisible();
      await expect(edgePage.getByRole("button", { name: "纳入插件" })).toBeVisible();
    } finally {
      await edge.close();
    }
  }

  expect(browserErrors).toEqual([]);
});
