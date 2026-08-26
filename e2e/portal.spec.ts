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
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
    await expect(page.locator("[data-cover-accretion-canvas]")).toHaveAttribute("data-render-state", "ready");
    await expect.poll(async () => page.locator("[data-cover-liquid-glass-canvas]").getAttribute("data-rendered-frame")).not.toBe("0");
    const buttonFrameBefore = Number(await page.locator("[data-cover-liquid-glass-canvas]").getAttribute("data-rendered-frame"));
    await page.waitForTimeout(1_500);
    const buttonFrameAfter = Number(await page.locator("[data-cover-liquid-glass-canvas]").getAttribute("data-rendered-frame"));
    expect(buttonFrameAfter).toBeGreaterThan(buttonFrameBefore);
    await expect(page.locator("[data-cover-accretion-canvas]")).toHaveJSProperty("width", 960);
    await expect(page.locator("[data-cover-accretion-canvas]")).toHaveJSProperty("height", 476);
    await expect(page.getByRole("button", { name: "纳入插件" })).toHaveCount(0);

    const transitionStartedAt = Date.now();
    await page.getByRole("button", { name: "Start" }).click();
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
    const promptAction = page.getByRole("button", { name: "新增 Prompt" });
    const promptActionBox = await promptAction.boundingBox();
    const promptViewportWidth = await page.evaluate(() => window.innerWidth);
    expect(promptActionBox).not.toBeNull();
    expect(promptActionBox!.x + promptActionBox!.width).toBeGreaterThan(promptViewportWidth - 40);
    expect(promptActionBox!.y).toBeLessThan(72);
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
    await expect(page.getByRole("link", { name: "下载最新版 v3.7.19" })).toHaveAttribute(
      "href",
      "http://127.0.0.1:9134/downloads/project-delivery-hub-3.7.19-company-dev.zip",
    );
    await expect(page.getByRole("tab", { name: "插件安装" })).toBeVisible();
    await expect(page.getByText("取得插件包")).toBeVisible();
    await expect(page.getByRole("link", { name: "鸟瞰全景" })).toHaveCount(0);
    const workflowAction = page.getByRole("button", { name: "配置流程" });
    const workflowActionBox = await workflowAction.boundingBox();
    const workflowViewportWidth = await page.evaluate(() => window.innerWidth);
    expect(workflowActionBox).not.toBeNull();
    expect(workflowActionBox!.x + workflowActionBox!.width).toBeGreaterThan(workflowViewportWidth - 40);
    expect(workflowActionBox!.y).toBeLessThan(72);

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
    await expect(page.getByRole("link", { name: "下载最新版 v3.7.19" })).toBeVisible();
    expect(consoleErrors).toEqual([]);
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
});
