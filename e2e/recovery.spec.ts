import { chromium, expect, test, type Route } from "@playwright/test";
import { startTestPortal, type TestPortal } from "./testServer";

// The proxy uses an ephemeral test CA; no certificate store is changed.
test.use({ ignoreHTTPSErrors: true });

let portal: TestPortal;
const key = "company-dev%2Fproject-delivery-hub";
const pluginPath = "/#/plugins/project-delivery-hub";

test.beforeEach(async () => {
  portal = await startTestPortal();
  await portal.promote(await portal.preview("project-delivery-hub", "3.7.17", "研发助手插件"), 0);
  await portal.promote(await portal.preview("yusheng-inc", "1.1.4", "昱勝 Inc"), 1);
  await portal.seedUserContent();
});
test.afterEach(async () => { await portal?.stop(); });

const failRead = (route: Route) => route.fulfill({
  status: 502, contentType: "application/json",
  body: JSON.stringify({ error: { code: "test_temporary_failure", message: "临时读取失败" } }),
});

test("a failed resource is independently retried without disabling navigation or mislabeling downloads", async ({ page }) => {
  let promptReads = 0;
  let downloadReads = 0;
  const counts = { catalog: 0, snapshot: 0, workflow: 0 };
  page.on("request", (request) => {
    if (request.url().endsWith("/api/plugins")) counts.catalog += 1;
    if (request.url().endsWith("/snapshot")) counts.snapshot += 1;
    if (request.url().endsWith("/workflows")) counts.workflow += 1;
  });
  await page.route(`**/api/plugins/${key}/prompts`, (route) => ++promptReads === 1 ? failRead(route) : route.continue());
  await page.route(`**/api/plugins/${key}/download-info`, (route) => ++downloadReads === 1 ? failRead(route) : route.continue());
  await page.goto(`${portal.baseUrl}${pluginPath}/prompts`);
  await expect(page.getByRole("alert")).toHaveText("临时读取失败");
  await expect(page.getByRole("button", { name: "重新检查下载" })).toBeEnabled();
  await expect(page.getByTitle("该插件未提供可下载版本")).toHaveCount(0);
  await page.getByRole("link", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "用途" })).toBeVisible();
  await page.getByRole("link", { name: "Prompts", exact: true }).click();
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await expect(page.getByText("研发 Prompt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重新检查下载" }).click();
  await expect(page.getByRole("link", { name: "下载最新版 v3.7.17" })).toBeVisible();
  expect(promptReads).toBe(2);
  expect(downloadReads).toBe(2);
  expect(counts).toEqual({ catalog: 1, snapshot: 1, workflow: 1 });
});

test("a timed-out read releases the page and a late old-plugin response cannot replace the current plugin", async ({ page }) => {
  await page.clock.install();
  let held: Route | undefined;
  await page.route(`**/api/plugins/${key}/prompts`, (route) => { held = route; });
  await page.goto(`${portal.baseUrl}${pluginPath}/prompts`);
  await expect(page.getByText("正在读取公开资料…")).toBeVisible();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.clock.fastForward(15_100);
  await expect(page.getByRole("alert")).toHaveText("读取超时，请重试");
  await page.evaluate(() => { location.hash = "#/plugins/yusheng-inc/prompts"; });
  await expect(page.getByText("昱勝 Prompt", { exact: true })).toBeVisible();
  await held!.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    revision: 99, pluginKey: "company-dev/project-delivery-hub", items: [
      { id: "late", scenario: "不应出现的旧资料", content: "迟到响应", createdAt: "2026-09-07T00:00:00Z" },
    ],
  }) }).catch(() => undefined);
  await expect(page.getByText("不应出现的旧资料")).toHaveCount(0);
  await expect(page.getByText("昱勝 Prompt", { exact: true })).toBeVisible();
});

for (const outcome of ["lost-receipt", "catalog-failure"] as const) {
  test(`ZIP inclusion ${outcome} keeps the single upload and never repeats promotion`, async ({ page }) => {
    test.skip(!process.env.PORTAL_CADDY_PATH, "isolated HTTPS needs Caddy");
    test.setTimeout(60_000);
    const base = await portal.startRemoteManagement();
    let promotions = 0;
    let uploads = 0;
    let refreshFailed = false;
    page.on("request", (request) => { if (request.url().endsWith("/api/uploads/plugin-import")) uploads += 1; });
    await page.route(`**/api/plugins/${key}/promote`, async (route) => {
      promotions += 1;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      if (outcome === "lost-receipt") await route.abort("failed");
      else await route.fulfill({ response });
    });
    await page.route("**/api/plugins", (route) => {
      if (outcome === "catalog-failure" && promotions > 0 && !refreshFailed) {
        refreshFailed = true;
        return failRead(route);
      }
      return route.continue();
    });
    await page.goto(`${base}/#/hub`);
    await page.getByRole("button", { name: "纳入插件", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "纳入插件" });
    await dialog.getByLabel("插件 ZIP").setInputFiles(portal.pluginArchivePath);
    await expect(dialog.getByText("将纳入 研发助手插件 v3.7.19", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "确认纳入", exact: true }).click();
    if (outcome === "catalog-failure") {
      await expect(dialog.getByRole("alert")).toContainText("已纳入，列表刷新失败");
      await expect(dialog.getByRole("button", { name: "确认纳入", exact: true })).toHaveCount(0);
      await dialog.getByRole("button", { name: "刷新列表", exact: true }).click();
    }
    await expect(dialog).toHaveCount(0);
    expect(uploads).toBe(1);
    expect(promotions).toBe(1);
    expect(portal.publishedDownloadSha256("project-delivery-hub-3.7.19-company-dev.zip")).toBe(portal.expectedPluginArchiveSha256);
    await page.getByRole("link", { name: "研发助手插件", exact: true }).click();
    await expect(page.getByRole("link", { name: "下载最新版 v3.7.19" })).toBeVisible();
  });
}

test("a lost save response is read back and double submission stays locked", async ({ page }) => {
  let posts = 0;
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/plugins/${key}/prompts`, async (route) => {
    if (route.request().method() === "GET") return route.continue();
    posts += 1;
    const saved = await route.fetch();
    expect(saved.status()).toBe(200);
    await barrier;
    await route.abort("failed");
  });
  await page.goto(`${portal.baseUrl}${pluginPath}/prompts`);
  await page.getByRole("button", { name: "新增 Prompt", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("常用场景").fill("回执丢失验收");
  await dialog.getByLabel("Prompt 内容").fill("冻结内容不得再次发送");
  await dialog.locator("form").evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
  await expect.poll(() => posts).toBe(1);
  await expect(dialog.getByLabel("Prompt 内容")).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("回执丢失验收", { exact: true })).toBeVisible();
  expect(posts).toBe(1);
});

test("a real revision conflict preserves the draft and shows the latest saved content", async ({ page, request }) => {
  await page.goto(`${portal.baseUrl}${pluginPath}/prompts`);
  await page.getByRole("button", { name: "编辑 研发 Prompt", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Prompt 内容").fill("我的未保存草稿");
  const session = await (await request.post(`${portal.baseUrl}/api/session`, { data: {} })).json();
  const latest = await (await request.get(`${portal.baseUrl}/api/plugins/${key}/prompts`)).json();
  const otherWrite = await request.post(`${portal.baseUrl}/api/plugins/${key}/prompts`, {
    headers: { "X-Portal-Session": session.token },
    data: { expectedRevision: latest.revision, items: latest.items.map((item: object) => ({ ...item, content: "另一位用户的已保存内容" })) },
  });
  expect(otherWrite.status()).toBe(200);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "复制草稿", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Prompt 内容")).toHaveValue("我的未保存草稿");
  await dialog.getByRole("button", { name: "查看最新内容", exact: true }).click();
  await expect(dialog.locator("pre")).toContainText("另一位用户的已保存内容");
  await expect(dialog.getByLabel("Prompt 内容")).toHaveValue("我的未保存草稿");
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "继续编辑" }).click();
  await expect(dialog.getByLabel("Prompt 内容")).toHaveValue("我的未保存草稿");
});

for (const channel of ["chromium", "msedge"] as const) {
  test(`${channel} recovers and contains modal focus in both themes at all target widths`, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const browser = await chromium.launch(channel === "msedge" ? { channel } : {});
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      for (const theme of ["dark", "light"] as const) {
        await page.goto(`${portal.baseUrl}/#/hub`);
        await page.evaluate((value) => localStorage.setItem("plugin-portal.theme", value), theme);
        await page.reload();
        for (const width of [1600, 1023, 768, 390, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`${portal.baseUrl}/#/hub`);
          await expect(page.getByRole("button", { name: "纳入插件", exact: true })).toBeVisible();
          let first = true;
          const path = `**/api/plugins/${key}/prompts`;
          await page.route(path, (route) => { if (first) { first = false; return failRead(route); } return route.continue(); });
          await page.goto(`${portal.baseUrl}${pluginPath}/prompts`);
          await expect(page.locator("html")).toHaveAttribute("data-portal-theme", theme);
          await expect(page.getByRole("alert")).toHaveText("临时读取失败");
          await page.getByRole("button", { name: "重试读取", exact: true }).click();
          await page.getByRole("button", { name: "新增 Prompt", exact: true }).click();
          const dialog = page.getByRole("dialog");
          await dialog.getByLabel("常用场景").fill(`${theme} ${width}`);
          await dialog.getByLabel("Prompt 内容").fill("异常后草稿保持可编辑，键盘焦点不进入背后页面。");
          for (let index = 0; index < 9; index += 1) {
            await page.keyboard.press(index % 2 ? "Shift+Tab" : "Tab");
            await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.keyboard.press("Escape");
          await expect(dialog.getByRole("button", { name: "放弃并关闭" })).toBeVisible();
          if (width === 320 || width === 1600) await page.screenshot({ path: testInfo.outputPath(`${channel}-${theme}-${width}.png`) });
          await dialog.getByRole("button", { name: "放弃并关闭" }).click();
          await expect(dialog).toHaveCount(0);
          await expect(page.getByRole("button", { name: "新增 Prompt", exact: true })).toBeFocused();
          await page.unroute(path);
        }
      }
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });
}
