import { chromium, expect, test, type Page } from "@playwright/test";
import { startTestPortal, type TestPortal } from "./testServer";

let portal: TestPortal;
const key = "company-dev/project-delivery-hub";
const workflowPath = `/api/plugins/${encodeURIComponent(key)}/workflows`;
const uploadsPath = `${workflowPath}/images`;

test.beforeEach(async () => {
  portal = await startTestPortal();
  await portal.promote(await portal.preview("project-delivery-hub", "3.7.19", "研发助手插件"), 0);
  await portal.promote(await portal.preview("yusheng-inc", "1.1.4", "昱胜 Inc"), 1);
  await portal.seedUserContent();
});
test.afterEach(async () => { await portal?.stop(); });
test.use({ ignoreHTTPSErrors: true }); // Only the isolated HTTPS fixture uses a temporary CA.

async function open(page: Page) {
  await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/overview`);
  await expect(page.getByRole("heading", { name: "首次安装" })).toBeVisible();
}

async function fixture(page: Page, color: string, name: string) {
  const encoded = await page.evaluate(({ color, name }) => {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 400;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = color; ctx.fillRect(0, 0, 640, 400);
    ctx.fillStyle = "white"; ctx.font = "32px sans-serif"; ctx.fillText(name, 32, 56);
    ctx.strokeStyle = "white"; ctx.lineWidth = 4; ctx.strokeRect(12, 12, 616, 376);
    return canvas.toDataURL("image/png").split(",")[1];
  }, { color, name });
  return { name: `${name}.png`, mimeType: "image/png", buffer: Buffer.from(encoded, "base64") };
}

async function uploadTwo(page: Page) {
  await page.getByRole("button", { name: "编辑流程" }).click();
  const dialog = page.getByRole("region", { name: "流程编辑" });
  const files = [await fixture(page, "#215B6B", "FIRST"), await fixture(page, "#423F87", "SECOND")];
  await dialog.getByLabel("添加步骤图片").setInputFiles(files);
  await expect(dialog.locator(".workflow-image-edit")).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: "保存流程" })).toBeEnabled();
  await dialog.getByLabel("子步骤 1 说明").fill("第一张安装截图");
  await dialog.getByLabel("子步骤 2 说明").fill("第二张安装截图");
  return dialog;
}

test("stages privately, saves image order once, reloads and shows a focus-contained full-size viewer", async ({ page }) => {
  await open(page);
  const receipts: string[] = [];
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname === uploadsPath && response.status() === 201) receipts.push((await response.json()).assetId);
  });
  const dialog = await uploadTwo(page);
  await expect.poll(() => receipts.length).toBe(2);
  await expect(dialog.locator("button button")).toHaveCount(0);
  for (const id of receipts) expect((await page.request.get(`${portal.baseUrl}${uploadsPath}/${id}/full`)).status()).toBe(404);
  await dialog.getByRole("button", { name: "图片 2 前移" }).click();
  await dialog.getByRole("button", { name: "保存流程" }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  const thumbs = page.locator(".workflow-image-thumbnail");
  await expect(thumbs).toHaveCount(2);
  await expect(thumbs.first()).toHaveAttribute("aria-label", "查看图片：第二张安装截图");
  await expect.poll(() => thumbs.locator("img").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await thumbs.first().click();
  const viewer = page.getByRole("dialog", { name: "步骤图片" });
  await expect(viewer.getByRole("img", { name: "第二张安装截图" })).toHaveJSProperty("naturalWidth", 640);
  await page.keyboard.press("ArrowRight");
  await expect(viewer.getByRole("img", { name: "第一张安装截图" })).toBeVisible();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press(i % 2 ? "Shift+Tab" : "Tab");
    expect(await viewer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(thumbs.first()).toBeFocused();
  const reader = await portal.startReadOnly();
  await page.goto(`${reader}/#/plugins/project-delivery-hub/overview`);
  await expect(page.getByRole("button", { name: "编辑流程" })).toHaveCount(0);
  await expect(page.locator(".workflow-image-thumbnail img").first()).toHaveJSProperty("naturalWidth", 320);
});

test("viewer shows descriptions and navigates to an unillustrated next step", async ({ page }) => {
  await open(page);
  const editor = await uploadTwo(page);
  await editor.getByLabel("步骤说明").fill("第一步的详细说明");
  await editor.getByRole("button", { name: "新增步骤", exact: true }).click();
  await editor.getByLabel("步骤标题").fill("第二步骤");
  await editor.getByLabel("步骤说明").fill("第二步没有图片，但保留完整说明。");
  await editor.getByRole("button", { name: "保存流程" }).click();
  await expect(editor).toHaveCount(0);
  await page.locator(".workflow-image-thumbnail").first().click();
  const viewer = page.getByRole("dialog", { name: "步骤图片" });
  await expect(viewer.getByText("第一张安装截图", { exact: true })).toBeVisible();
  const nextImage = viewer.getByRole("button", { name: "下一子步骤", exact: true });
  await nextImage.focus();
  const focusedBackground = await nextImage.evaluate(node => getComputedStyle(node).backgroundColor);
  for (const name of ["下一步骤", "隐藏控件", "关闭"]) {
    const button = viewer.getByRole("button", { name, exact: true });
    await button.focus();
    await expect(button).toHaveCSS("background-color", focusedBackground);
  }
  await viewer.getByRole("button", { name: "下一步骤", exact: true }).click();
  await expect(viewer.getByRole("heading", { name: "第二步骤" })).toBeVisible();
  await expect(viewer.getByText("该步骤暂无图片")).toBeVisible();
  await expect(nextImage).toBeDisabled();
  await expect(nextImage).toHaveCSS("opacity", "0.5");
  await expect(nextImage).toHaveCSS("background-color", /\/ 0\.2\)$/);
  const disabledBackground = await nextImage.evaluate(node => getComputedStyle(node).backgroundColor);
  await nextImage.hover();
  await expect(nextImage).toHaveCSS("background-color", disabledBackground);
  await expect(viewer.getByRole("button", { name: "已是最后一步" })).toBeDisabled();
  await viewer.getByRole("button", { name: "上一步骤" }).click();
  await expect(viewer.getByRole("img", { name: "第一张安装截图" })).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const image = viewer.getByRole("img", { name: "第一张安装截图" });
    const before = await image.boundingBox();
    expect(before!.width).toBeGreaterThan(width - 48);
    expect(before!.height).toBeGreaterThan(810);
    expect(before!.x).toBeGreaterThanOrEqual(0);
    expect(before!.x + before!.width).toBeLessThanOrEqual(width);
    await expect(viewer.getByRole("button", { name: "关闭", exact: true })).toBeInViewport();
    const toggle = viewer.getByRole("button", { name: "隐藏控件" });
    await expect(toggle).toHaveText("");
    await expect(viewer.locator("header").getByRole("button", { name: "隐藏控件" })).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "下一子步骤" }).locator("svg")).toHaveClass(/lucide-chevron-right/);
    await expect(viewer.getByRole("button", { name: "下一步骤", exact: true }).locator("svg")).toHaveClass(/lucide-chevrons-right/);
    const toggleBox = await toggle.boundingBox();
    const navBox = await viewer.locator(".workflow-viewer-navigation").boundingBox();
    expect(Math.abs(toggleBox!.x + toggleBox!.width / 2 - navBox!.x - navBox!.width / 2)).toBeLessThan(2);
    await expect(viewer.getByRole("button", { name: "下一步骤", exact: true })).toBeInViewport();
    expect(await viewer.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`immersive-${width}.png`) });
    await viewer.getByRole("button", { name: "隐藏控件" }).click();
    const showBox = await viewer.getByRole("button", { name: "显示控件" }).boundingBox();
    expect(showBox).toEqual(toggleBox);
    await expect(viewer.getByRole("region", { name: "步骤说明" })).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "下一步骤", exact: true })).toHaveCount(0);
    const after = await image.boundingBox();
    expect(after).toEqual(before);
    await page.keyboard.press("ArrowRight");
    await expect(viewer.getByRole("img", { name: "第二张安装截图" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`immersive-hidden-${width}.png`) });
    await viewer.getByRole("button", { name: "显示控件" }).click();
    await viewer.getByRole("button", { name: "上一子步骤", exact: true }).click();
  }
  await viewer.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".workflow-image-thumbnail").first()).toBeFocused();
});

test("image overlays stay readable and collapsible in the light theme", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("plugin-portal.theme", "light"));
  await page.setViewportSize({ width: 1912, height: 948 });
  await open(page);
  const editor = await uploadTwo(page);
  await editor.getByLabel("步骤说明").fill("这是一段很长的步骤说明，需要在浮层中滚动阅读。\n".repeat(35));
  await editor.getByLabel("子步骤 1 说明").fill("");
  await editor.getByRole("button", { name: "保存流程" }).click();
  await expect(editor).toHaveCount(0);
  await page.locator(".workflow-image-thumbnail").first().click();
  const viewer = page.getByRole("dialog", { name: "步骤图片" });
  const description = viewer.getByRole("region", { name: "步骤说明" });
  expect(await description.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await expect(viewer.getByRole("button", { name: "隐藏控件" })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("immersive-light.png") });
  await viewer.getByRole("button", { name: "隐藏控件" }).click();
  await expect(description).toHaveCount(0);
  await expect(viewer.getByRole("img")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("immersive-light-hidden.png") });
  await viewer.getByRole("button", { name: "显示控件" }).click();
  await expect(description).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
});

test("each picture persists its own substep title, description and reordered position", async ({ page }) => {
  await open(page);
  const editor = await uploadTwo(page);
  await editor.getByLabel("子步骤 1 标题").fill("打开面板");
  await editor.getByLabel("子步骤 2 标题").fill("选择任务");
  await editor.getByLabel("子步骤 1 说明").fill("发送打开面板指令");
  await editor.getByLabel("子步骤 2 说明").fill("选择待处理的任务");
  await editor.getByRole("button", { name: "图片 2 前移" }).click();
  await expect(editor.getByLabel("子步骤 1 标题")).toHaveValue("选择任务");
  await expect(editor.getByLabel("子步骤 1 说明")).toHaveValue("选择待处理的任务");
  await page.screenshot({ path: test.info().outputPath("substep-editor.png"), fullPage: true });
  await editor.getByRole("button", { name: "保存流程" }).click();
  await expect(editor).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".workflow-substep-caption").first()).toHaveText("1. 选择任务");
  await page.locator(".workflow-image-thumbnail").first().click();
  const viewer = page.getByRole("dialog", { name: "步骤图片" });
  await expect(viewer.getByRole("heading", { name: "选择任务" })).toBeVisible();
  await expect(viewer.getByText("选择待处理的任务", { exact: true })).toBeVisible();
  await viewer.getByRole("button", { name: "下一子步骤" }).click();
  await expect(viewer.getByRole("heading", { name: "打开面板" })).toBeVisible();
  await expect(viewer.getByText("发送打开面板指令", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("substep-viewer.png") });
  await viewer.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "编辑流程" }).click();
  await expect(editor.getByLabel("子步骤 2 标题")).toHaveValue("打开面板");
  await expect(editor.getByLabel("子步骤 2 说明")).toHaveValue("发送打开面板指令");
});

test("cancel leaves saved images intact, removing a step cancels upload and late receipts cannot resurrect it", async ({ page }) => {
  await open(page);
  let dialog = await uploadTwo(page);
  await dialog.getByRole("button", { name: "保存流程" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "编辑流程" }).click();
  dialog = page.getByRole("region", { name: "流程编辑" });
  await dialog.getByRole("button", { name: "删除图片 1" }).click();
  await dialog.getByRole("button", { name: "退出编辑" }).click();
  await expect(page.getByRole("dialog", { name: "退出流程编辑" })).toContainText("尚未保存");
  await page.getByRole("button", { name: "放弃并退出" }).click();
  await expect(page.locator(".workflow-image-thumbnail")).toHaveCount(2);

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let received = false;
  await page.route(`**${uploadsPath}`, async (route) => {
    const response = await route.fetch(); received = true;
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole("button", { name: "编辑流程" }).click();
  await dialog.getByLabel("添加步骤图片").setInputFiles(await fixture(page, "#2F6648", "LATE"));
  await expect.poll(() => received).toBe(true);
  await dialog.getByRole("button", { name: "删除步骤", exact: true }).click();
  release();
  await expect(dialog.locator(".workflow-image-edit")).toHaveCount(0);
  await dialog.getByRole("button", { name: "保存流程" }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".workflow-image-thumbnail")).toHaveCount(0);
});

test("upload failure retains draft, manual retry renews invalid sessions, lost save receipt is verified without replay", async ({ page }) => {
  await open(page);
  let uploads = 0;
  await page.route(`**${uploadsPath}`, async (route) => {
    uploads++;
    if (uploads === 1) await route.fulfill({ status: 401, json: { error: { code: "invalid_session", message: "会话失效，请重试图片" } } });
    else await route.continue();
  });
  await page.getByRole("button", { name: "编辑流程" }).click();
  const dialog = page.getByRole("region", { name: "流程编辑" });
  await dialog.getByLabel("步骤说明").fill("上传失败也保留的说明");
  await dialog.getByLabel("添加步骤图片").setInputFiles(await fixture(page, "#215B6B", "RETRY"));
  await expect(dialog.getByRole("alert")).toContainText("会话失效");
  expect(uploads).toBe(1);
  await expect(dialog.getByRole("button", { name: "保存流程" })).toBeDisabled();
  await dialog.getByRole("button", { name: "重试图片 1" }).click();
  await expect(dialog.getByRole("button", { name: "保存流程" })).toBeEnabled();
  await expect(dialog.getByLabel("步骤说明")).toHaveValue("上传失败也保留的说明");
  await dialog.getByLabel("子步骤 1 说明").fill("重试后的截图");
  let saves = 0;
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route(`**${workflowPath}`, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    saves++;
    await saveGate;
    await route.fetch(); // Commit to the isolated backend, then lose only the receipt.
    await route.abort("failed");
  });
  await dialog.getByRole("button", { name: "保存流程" }).click();
  await expect(dialog.getByText("正在保存…", { exact: true })).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "保存流程" })).toBeDisabled();
  releaseSave();
  await expect(dialog).toHaveCount(0);
  expect(saves).toBe(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "查看图片：重试后的截图" })).toBeVisible();
});

test("remote HTTPS management uses the same private upload and saved-image read boundary", async ({ page }) => {
  test.skip(!process.env.PORTAL_CADDY_PATH, "isolated HTTPS needs Caddy");
  const remote = await portal.startRemoteManagement();
  await page.goto(`${remote}/#/plugins/project-delivery-hub/overview`);
  const dialog = await uploadTwo(page);
  await dialog.getByRole("button", { name: "保存流程" }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".workflow-image-thumbnail img").first()).toHaveJSProperty("naturalWidth", 320);
  await page.locator(".workflow-image-thumbnail").first().click();
  await expect(page.getByRole("dialog", { name: "步骤图片" }).getByRole("img")).toHaveJSProperty("naturalWidth", 640);
});

test("substep title supports keyboard editing without losing the draft", async ({ page }) => {
  await open(page);
  const dialog = await uploadTwo(page);
  const title = dialog.getByLabel("子步骤 1 标题");
  await title.focus();
  await page.keyboard.type("Substep title");
  await expect(title).toHaveValue("Substep title");
  await expect(title).toHaveCSS("outline-style", "none");
  expect(await title.evaluate((input) => getComputedStyle(input).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  await dialog.getByRole("button", { name: "退出编辑" }).click();
  await page.getByRole("button", { name: "放弃并退出" }).click();
});

test("dark/light image layouts and borderless keyboard focus at all requested widths", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await open(page);
  const dialog = await uploadTwo(page);
  await dialog.getByRole("button", { name: "保存流程" }).click();
  await expect(dialog).toHaveCount(0);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => localStorage.setItem("plugin-portal.theme", value), theme);
    await page.reload();
    for (const width of [1600, 1023, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const action = page.getByRole("button", { name: "编辑流程" });
      await page.keyboard.press("Tab"); await action.focus();
      await expect(action).toHaveCSS("outline-style", "none");
      await expect(action).toHaveCSS("box-shadow", "none");
      await expect(action).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.locator(".portal-capsule")).toHaveCSS("border-top-width", "1px");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-overview.png`) });
      await action.click();
      const editor = page.getByRole("region", { name: "流程编辑" });
      if (width < 900) await editor.locator(".workflow-editor-step").first().click();
      await editor.getByLabel("子步骤 1 说明").focus();
      await expect(editor.getByLabel("子步骤 1 说明")).toHaveCSS("outline-style", "none");
      await expect(editor.getByLabel("子步骤 1 说明")).toHaveCSS("box-shadow", "none");
      expect(await editor.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-editor.png`) });
      await editor.getByRole("button", { name: "退出编辑" }).click();
      await page.getByRole("button", { name: "查看图片：第一张安装截图" }).click();
      const viewer = page.getByRole("dialog", { name: "步骤图片" });
      expect(await viewer.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
      await expect(viewer.getByRole("img", { name: "第一张安装截图" })).toHaveCSS("object-fit", "contain");
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-viewer.png`) });
      await page.keyboard.press("Escape");
    }
  }
});

for (const channel of ["chromium", "msedge"] as const) {
  test(`${channel} inline editing preserves tab, viewport, drafts and mobile return in both themes`, async ({}, testInfo) => {
    test.setTimeout(240_000);
    const browser = await chromium.launch(channel === "msedge" ? { channel } : {});
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const session = await (await page.request.post(`${portal.baseUrl}/api/session`, { data: {} })).json();
      const current = await (await page.request.get(`${portal.baseUrl}${workflowPath}`)).json();
      const seeded = await page.request.post(`${portal.baseUrl}${workflowPath}`, {
        headers: { "X-Portal-Session": session.token }, data: { expectedRevision: current.revision, workflow: {
          pluginKey: key, tabs: [...current.tabs, { id: "design", title: "设计交付", sections: [{
            id: "design-section", title: "设计与验证", steps: Array.from({ length: 24 }, (_, index) => ({
              id: `design-${index}`, label: `步骤 ${index + 1}`, title: `设计步骤 ${index + 1}`,
              description: "确认输入与预期结果，记录设计说明和验证方式。修改在保存后公开，切换步骤不清空本地草稿。", next: index < 23 ? [`design-${index + 1}`] : [],
            })),
          }] }],
        } },
      });
      expect(seeded.ok(), await seeded.text()).toBe(true);
      for (const theme of ["dark", "light"]) {
        await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/overview`);
        await page.evaluate((value) => localStorage.setItem("plugin-portal.theme", value), theme);
        for (const width of [1600, 1023, 768, 390, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await page.reload();
          await expect(page.getByRole("heading", { name: "首次安装" })).toBeVisible();
          await page.getByRole("tab", { name: "设计交付" }).click();
          await page.locator('[data-workflow-step="design-12"]').evaluate((element) => {
            window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 180);
          });
          const action = page.getByRole("button", { name: "编辑流程", exact: true });
          await expect(page.locator(".portal-capsule")).toHaveAttribute("data-visibility", "hidden");
          await page.evaluate(() => window.scrollBy(0, -40));
          await expect(page.locator(".portal-capsule")).toHaveAttribute("data-visibility", "visible");
          const anchor = await page.locator("[data-workflow-step]").evaluateAll((elements) => {
            const first = elements.find((element) => element.getBoundingClientRect().bottom > 110 && element.getBoundingClientRect().top < innerHeight)! as HTMLElement;
            return { id: first.dataset.workflowStep!, top: first.getBoundingClientRect().top };
          });
          await action.click();
          const editor = page.getByRole("region", { name: "流程编辑" });
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await expect(editor.getByRole("tab", { name: "设计交付" })).toHaveAttribute("aria-selected", "true");
          const card = editor.locator(`[data-workflow-step="${anchor.id}"]`);
          expect(Math.abs((await card.boundingBox())!.y - anchor.top), `${theme} ${width} viewport anchor`).toBeLessThan(3);
          await card.click();
          await editor.getByLabel("步骤说明").fill(`${theme} ${width} 保留上下文的草稿`);
          await expect(editor.getByRole("button", { name: "保存流程" })).toBeInViewport();
          if (width < 900) {
            await expect(editor.getByRole("region", { name: "流程画布" })).toBeHidden();
            await editor.getByRole("button", { name: "返回流程" }).click();
            await expect(card).toBeFocused();
            await expect(card).toContainText(`${theme} ${width} 保留上下文的草稿`);
            await card.click();
            await expect(editor.getByLabel("步骤说明")).toHaveValue(`${theme} ${width} 保留上下文的草稿`);
          } else {
            // A non-modal inspector must not trap focus away from the rest of the page.
            if (width < 1024) await page.getByRole("button", { name: "打开导航菜单" }).click();
            const skills = page.getByRole("link", { name: "Skills", exact: true });
            await skills.focus(); await expect(skills).toBeFocused();
            await skills.click();
            await expect(page.getByRole("dialog", { name: "退出流程编辑" })).toBeVisible();
            await page.getByRole("button", { name: "继续编辑" }).click();
            await expect(page).toHaveURL(/\/overview$/);
            await editor.getByLabel("步骤说明").focus();
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
          await page.screenshot({ path: testInfo.outputPath(`${channel}-${theme}-${width}-inline.png`) });
          await editor.getByRole("button", { name: "保存流程" }).click();
          await expect(editor).toHaveCount(0);
          await expect(page.getByRole("tab", { name: "设计交付" })).toHaveAttribute("aria-selected", "true");
          await expect(page.locator(`[data-workflow-step="${anchor.id}"]`)).toContainText(`${theme} ${width} 保留上下文的草稿`);
          await expect(action).toBeFocused();
        }
      }
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });
}
