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
    await page.setViewportSize({ width: 1912, height: 948 });
    const remoteRequests: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(portal.baseUrl)) remoteRequests.push(request.url());
    });
    await page.goto(`${portal.baseUrl}/#/`);
    await expect(page.locator(".hub-cover")).toBeVisible();
    const startButton = page.getByRole("button", { name: "Start" });
    const loadingOverlay = page.locator("[data-cover-loading-overlay]");
    await expect(startButton).toBeVisible();
    await expect(page.locator("[data-cover-accretion-canvas]")).toHaveAttribute("data-render-state", "ready");
    await expect.poll(async () => page.locator("[data-cover-accretion-canvas]").getAttribute("data-rendered-frame")).not.toBe("0");
    await expect(loadingOverlay).toHaveAttribute("data-ready", "true");
    await expect(loadingOverlay).toHaveCSS("visibility", "hidden");
    await expect(startButton).toBeEnabled();
    await expect.poll(async () => page.locator("[data-cover-liquid-glass-canvas]").getAttribute("data-rendered-frame")).not.toBe("0");
    const buttonFrameBefore = Number(await page.locator("[data-cover-liquid-glass-canvas]").getAttribute("data-rendered-frame"));
    await page.waitForTimeout(1_500);
    const buttonFrameAfter = Number(await page.locator("[data-cover-liquid-glass-canvas]").getAttribute("data-rendered-frame"));
    expect(buttonFrameAfter).toBeGreaterThan(buttonFrameBefore);
    await expect(page.locator("[data-cover-accretion-canvas]")).toHaveJSProperty("width", 960);
    await expect(page.locator("[data-cover-accretion-canvas]")).toHaveJSProperty("height", 476);
    await expect(page.getByRole("button", { name: "纳入插件" })).toHaveCount(0);

    const transitionStartedAt = Date.now();
    await startButton.click();
    await expect(page).toHaveURL(`${portal.baseUrl}/#/hub`);
    await expect(page.getByRole("button", { name: "纳入插件" })).toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole("button", { name: /^管理 / })).toHaveCount(0);
    expect(Date.now() - transitionStartedAt).toBeLessThan(3_000);
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
    const skillIcon = page.getByRole("row", { name: /sample-skill/ }).locator(".skill-name-icon");
    await expect(skillIcon.locator("svg")).toHaveClass(/lucide-code/);
    await expect(skillIcon).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(skillIcon).toHaveCSS("border-top-width", "0px");
    await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/mcp`);
    await expect(page.getByRole("heading", { name: "示例服务" })).toBeVisible();
    await expect(page.getByText("查询经过筛选的公开资料。")).toBeVisible();
    await expect(page.getByText("查询公开资料")).toBeVisible();
    await expect(page.getByText("只读")).toBeVisible();
    expect(remoteRequests).toEqual([]);
  });

  test("releases the cover loading mask when WebGL uses the static fallback", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (contextId: string, ...args: unknown[]) {
        if (contextId === "webgl") return null;
        return Reflect.apply(getContext, this, [contextId, ...args]);
      } as typeof HTMLCanvasElement.prototype.getContext;
    });

    await page.goto(`${portal.baseUrl}/#/`);

    await expect(page.locator("[data-cover-accretion-canvas]")).toHaveAttribute("data-render-state", "fallback");
    await expect(page.locator("[data-cover-loading-overlay]")).toHaveAttribute("data-ready", "true");
    await expect(page.locator("[data-cover-loading-overlay]")).toHaveCSS("visibility", "hidden");
    await expect(page.getByRole("button", { name: "Start" })).toBeEnabled();
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
    const promptAction = page.getByRole("button", { name: "新增 Prompt" });
    const promptActionBox = await promptAction.boundingBox();
    const promptActionsBox = await page.locator(".portal-capsule-actions").boundingBox();
    expect(promptActionBox).not.toBeNull();
    expect(promptActionsBox).not.toBeNull();
    expect(promptActionBox!.x).toBeGreaterThanOrEqual(promptActionsBox!.x);
    expect(promptActionBox!.x + promptActionBox!.width).toBeLessThanOrEqual(promptActionsBox!.x + promptActionsBox!.width);
    expect(promptActionBox!.y).toBeLessThan(100);
    await promptAction.click();
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
    await expect(page.locator("nav[aria-label='插件内容'] svg")).toHaveCount(6);
    await expect(page.getByRole("link", { name: "研发助手插件" }).locator("img, svg")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
    await expect(page.getByRole("main", { name: "鸟瞰全景" })).toBeVisible();
    const brandLink = page.getByRole("link", { name: "研发助手插件" });
    await page.keyboard.press("Tab");
    await expect(brandLink).toBeFocused();
    await expect(brandLink).toHaveCSS("outline-style", "none");
    await expect(brandLink).toHaveCSS("border-top-width", "0px");

    const selectedMenu = page.getByRole("link", { name: "Skills" });
    await page.keyboard.press("Tab");
    await expect(selectedMenu).toBeFocused();
    await expect(selectedMenu).toHaveCSS("outline-style", "none");
    await expect(selectedMenu.locator("svg")).toHaveCSS("outline-style", "none");
    await expect(selectedMenu.locator("span")).toHaveCSS("text-decoration-line", "underline");
    await selectedMenu.click();
    await expect(page.getByRole("main", { name: "Skills" })).toBeVisible();
    await expect(selectedMenu).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(selectedMenu).toHaveCSS("border-top-width", "0px");

    const downloadAction = page.getByRole("link", { name: "下载最新版 v3.7.19" });
    await expect(downloadAction).toHaveAttribute(
      "href",
      "http://127.0.0.1:9134/downloads/project-delivery-hub-3.7.19-company-dev.zip",
    );
    await expect(downloadAction.locator("xpath=ancestor::div[contains(@class,'portal-capsule-actions')]")).toHaveCount(1);
    const downloadBox = await downloadAction.boundingBox();
    expect(downloadBox).not.toBeNull();
    expect(downloadBox!.y).toBeLessThan(100);

    await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/overview`);
    await expect(page.getByRole("tab", { name: "插件安装" })).toBeVisible();
    await expect(page.getByText("取得插件包")).toBeVisible();
    await expect(page.getByRole("link", { name: "鸟瞰全景" })).toHaveCount(0);
    const workflowAction = page.getByRole("button", { name: "配置流程" });
    const workflowActionBox = await workflowAction.boundingBox();
    const workflowActionsBox = await page.locator(".portal-capsule-actions").boundingBox();
    expect(workflowActionBox).not.toBeNull();
    expect(workflowActionsBox).not.toBeNull();
    expect(workflowActionBox!.x).toBeGreaterThanOrEqual(workflowActionsBox!.x);
    expect(workflowActionBox!.x + workflowActionBox!.width).toBeLessThanOrEqual(workflowActionsBox!.x + workflowActionsBox!.width);
    expect(workflowActionBox!.y).toBeLessThan(100);

    const workflowTabs = page.getByRole("tablist", { name: "流程" });
    await expect(workflowTabs).toHaveCSS("border-top-style", "solid");
    const selectedWorkflowTab = workflowTabs.getByRole("tab", { name: "插件安装" });
    await expect(selectedWorkflowTab).toHaveCSS("border-top-width", "0px");
    await expect(selectedWorkflowTab).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    await workflowAction.click();
    const workflowDialog = page.getByRole("dialog", { name: "配置流程" });
    const workflowCanvas = workflowDialog.getByRole("region", { name: "流程画布" });
    await expect(workflowDialog).toBeVisible();
    await expect(workflowCanvas.getByRole("tab", { name: "插件安装" })).toHaveAttribute("aria-selected", "true");
    await expect(workflowDialog.getByRole("complementary", { name: "属性栏" })).toBeVisible();
    await expect(workflowDialog.getByRole("heading", { name: "编辑具体步骤" })).toBeVisible();
    await expect(workflowDialog.getByLabel("步骤标题")).toHaveValue("取得插件包");
    await expect(workflowDialog.getByRole("button", { name: "预览流程" })).toHaveCount(0);

    await workflowDialog.getByLabel("步骤标题").fill("取得正式插件包");
    await expect(workflowCanvas.getByRole("button", { name: "取得正式插件包" })).toBeVisible();
    await workflowCanvas.getByRole("button", { name: "首次安装" }).click();
    await expect(workflowDialog.getByRole("heading", { name: "编辑流程区域" })).toBeVisible();
    await workflowDialog.getByLabel("流程区域标题").fill("首次安装并配置");
    await expect(workflowCanvas.getByRole("button", { name: "首次安装并配置" })).toBeVisible();
    await workflowCanvas.getByRole("tab", { name: "插件安装" }).click();
    await expect(workflowDialog.getByRole("heading", { name: "编辑 Tab" })).toBeVisible();
    await workflowDialog.getByRole("button", { name: "保存流程" }).click();
    await expect(workflowDialog).toHaveCount(0);
    await expect(page.getByText("取得正式插件包", { exact: true })).toBeVisible();
    await expect(page.getByText("首次安装并配置", { exact: true })).toBeVisible();

    await workflowAction.click();
    await page.getByRole("dialog", { name: "配置流程" }).press("Escape");
    await expect(page.getByRole("dialog", { name: "配置流程" })).toHaveCount(0);
    await expect(workflowAction).toBeFocused();
    await page.goto(`${portal.baseUrl}/#/plugins/yusheng-inc/overview`);
    await expect(page.getByText("尚未配置鸟瞰全景流程")).toBeVisible();
    await expect(page.getByRole("button", { name: "下载最新版 v1.1.4" })).toBeDisabled();
    await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/releases`);
    await expect(page.getByRole("main", { name: "版本沿革" })).toBeVisible();
    await expect(page.getByRole("link", { name: "下载最新版 v3.7.19" })).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });

  test("keeps the workflow inspector fixed while the canvas scrolls", async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 600 });
    await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/overview`);
    await page.getByRole("button", { name: "配置流程" }).click();

    const dialog = page.getByRole("dialog", { name: "配置流程" });
    const canvas = dialog.getByRole("region", { name: "流程画布" });
    const inspector = dialog.getByRole("complementary", { name: "属性栏" });
    for (let index = 0; index < 10; index += 1) {
      await canvas.getByRole("button", { name: "新增步骤" }).click();
    }

    const inspectorBefore = await inspector.boundingBox();
    const canvasScroll = await canvas.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      };
    });
    const inspectorAfter = await inspector.boundingBox();

    expect(canvasScroll.scrollHeight).toBeGreaterThan(canvasScroll.clientHeight);
    expect(canvasScroll.scrollTop).toBeGreaterThan(0);
    expect(inspectorBefore).not.toBeNull();
    expect(inspectorAfter).not.toBeNull();
    expect(inspectorAfter!.x).toBe(inspectorBefore!.x);
    expect(inspectorAfter!.y).toBe(inspectorBefore!.y);
    expect(inspectorAfter!.height).toBe(inspectorBefore!.height);
    await expect(dialog.getByRole("heading", { name: "编辑具体步骤" })).toBeVisible();

    await dialog.getByRole("button", { name: "关闭" }).click();
  });

  test("keeps Prompt and extension table columns readable", async ({ page }) => {
    const catalog = await portal.listPlugins();
    if (!catalog.items.some((item) => item.id === "project-delivery-hub")) {
      const candidate = await portal.preview("project-delivery-hub", "3.7.19", "研发助手插件");
      await portal.promote(candidate, catalog.revision);
    }
    await page.route("**/api/plugins/*/snapshot", async (route) => {
      const response = await route.fetch();
      const payload = await response.json() as {
        plugin?: { id?: string };
        extensionTools?: Array<{ id: string; name: string; purpose: string; url: string }>;
      };
      if (payload.plugin?.id === "project-delivery-hub") {
        payload.extensionTools = [
          { id: "allure-report", name: "Allure Report 3", purpose: "查看测试报告。", url: "https://example.com/allure" },
        ];
      }
      await route.fulfill({ response, json: payload });
    });

    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/prompts`);
    if (await page.getByRole("columnheader", { name: "常用场景" }).count() === 0) {
      await page.getByRole("button", { name: "新增 Prompt" }).click();
      await page.getByLabel("常用场景").fill("检查交付");
      await page.getByLabel("Prompt 内容").fill("核对公开资料和流程。");
      await page.getByRole("button", { name: "保存" }).click();
    }

    for (const width of [1600, 1120, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/prompts`);
      const scenarioHeading = page.getByRole("columnheader", { name: "常用场景" });
      await expect(scenarioHeading).toHaveCSS("min-width", "200px");
      expect((await scenarioHeading.boundingBox())!.width).toBeGreaterThanOrEqual(200);

      await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/extensions`);
      const nameHeading = page.getByRole("columnheader", { name: "名称" });
      const resourceHeading = page.getByRole("columnheader", { name: "了解更多" });
      await expect(nameHeading).toHaveCSS("min-width", "180px");
      await expect(resourceHeading).toHaveCSS("width", "96px");
      await expect(resourceHeading).toHaveCSS("white-space", "nowrap");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    }
  });

  test("keeps every fixed page reachable without horizontal overflow", async ({ page }) => {
    for (const width of [390, 768, 1120, 1600]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/overview`);
      await expect(page.getByRole("link", { name: "研发助手插件" })).toHaveAttribute("href", "#/plugins/project-delivery-hub/overview");
      const moreButton = page.getByRole("button", { name: "打开导航菜单" });
      if (width < 900) {
        await expect(moreButton).toBeVisible();
        await moreButton.click();
      } else {
        await expect(moreButton).toBeHidden();
      }
      for (const name of ["Skills", "Prompts", "MCP", "扩展工具", "工程规范", "版本沿革"]) {
        await expect(page.getByRole("link", { name })).toBeVisible();
      }
      if (width < 900) {
        await page.getByRole("link", { name: "Skills" }).click();
        await expect(page).toHaveURL(`${portal.baseUrl}/#/plugins/project-delivery-hub/skills`);
        await expect(page.getByRole("button", { name: "打开导航菜单" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Skills" })).toBeHidden();
        await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/overview`);
      }
      await expect(page.getByRole("link", { name: "鸟瞰全景" })).toHaveCount(0);
      await page.getByRole("button", { name: "配置流程" }).click();
      const dialog = page.getByRole("dialog", { name: "配置流程" });
      const canvas = dialog.getByRole("region", { name: "流程画布" });
      const inspector = dialog.getByRole("complementary", { name: "属性栏" });
      await expect(dialog).toBeVisible();
      const [canvasBox, inspectorBox] = await Promise.all([canvas.boundingBox(), inspector.boundingBox()]);
      expect(canvasBox).not.toBeNull();
      expect(inspectorBox).not.toBeNull();
      if (width < 900) {
        expect(inspectorBox!.y).toBeGreaterThanOrEqual(canvasBox!.y + canvasBox!.height - 1);
      } else {
        expect(inspectorBox!.x).toBeGreaterThanOrEqual(canvasBox!.x + canvasBox!.width - 1);
        expect(inspectorBox!.width).toBeGreaterThanOrEqual(350);
        expect(inspectorBox!.width).toBeLessThanOrEqual(370);
      }
      const dialogOverflows = await dialog.evaluate((element) => element.scrollWidth > element.clientWidth);
      expect(dialogOverflows).toBe(false);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(overflow).toBe(false);
      await dialog.getByRole("button", { name: "关闭" }).click();
    }
  });

  test("hides and restores the floating capsule at real scroll thresholds", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 640 });
    await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/skills`);
    await page.locator(".portal-content").evaluate((element) => { element.style.minHeight = "1800px"; });
    const capsule = page.getByRole("banner", { name: "插件导航" });
    await expect(capsule).toHaveAttribute("data-visibility", "visible");
    const visibleBox = await capsule.boundingBox();
    expect(visibleBox).not.toBeNull();
    expect(visibleBox!.y).toBeGreaterThanOrEqual(0);

    await page.evaluate(() => window.scrollTo(0, 80));
    await expect(capsule).toHaveAttribute("data-visibility", "hidden");
    await expect.poll(async () => (await capsule.boundingBox())!.y).toBeLessThan(0);

    await page.evaluate(() => window.scrollTo(0, 50));
    await expect(capsule).toHaveAttribute("data-visibility", "visible");
    await expect.poll(async () => (await capsule.boundingBox())!.y).toBeGreaterThanOrEqual(0);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(capsule).toHaveAttribute("data-visibility", "visible");
  });
});
