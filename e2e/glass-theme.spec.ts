import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { installMockWebGpu } from "./mockWebGpu";
import { startTestPortal, type TestPortal } from "./testServer";

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });
let portal: TestPortal;

test.beforeAll(async () => {
  portal = await startTestPortal();
  await portal.promote(await portal.preview("project-delivery-hub", "3.7.17", "研发助手插件"), 0);
  await portal.promote(await portal.preview("yusheng-inc", "1.1.4", "昱胜 Inc"), 1);
  await portal.seedUserContent();
});
test.afterAll(async () => { await portal?.stop(); });

async function openPlugin(page: Page, section = "skills") {
  await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/${section}`);
  await expect(page.getByRole("banner", { name: "插件导航" })).toBeVisible();
  await expect(page.locator(".portal-content")).toHaveAttribute("aria-busy", "false");
}

async function setTheme(page: Page, theme: "dark" | "light") {
  const current = await page.locator("html").getAttribute("data-portal-theme");
  if (current === theme) return;
  const settings = page.getByRole("button", { name: "外观设置" });
  if (await settings.isVisible()) await settings.click();
  await page.getByRole("button", { name: theme === "light" ? "切换为浅色" : "切换为深色" }).click();
  if (await settings.isVisible()) await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-portal-theme", theme);
}

const pages = [
  ["overview", "鸟瞰全景"], ["skills", "Skills"], ["prompts", "Prompts"],
  ["mcp", "MCP"], ["extensions", "扩展工具"], ["rules", "工程规范"], ["releases", "版本沿革"],
] as const;

async function navigate(page: Page, section: string, name: string) {
  if (section === "overview") await page.locator(".portal-brand").click();
  else {
    const more = page.getByRole("button", { name: "打开导航菜单" });
    if (await more.isVisible()) await more.click();
    await page.getByRole("navigation", { name: "插件内容" }).getByRole("link", { name, exact: true }).click();
  }
  await expect(page.getByRole("main", { name, exact: true })).toBeVisible();
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("uses a white page and dark text throughout the light theme", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openPlugin(page);
  await setTheme(page, "light");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.getByRole("main")).toHaveCSS("color", "rgb(23, 28, 36)");
});

test("themes the Hub, every plugin page and the inclusion dialog without changing plugin data", async ({ page }, testInfo) => {
  const errors: string[] = [];
  const remote: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith(portal.baseUrl)) remote.push(request.url()); });
  const original = await portal.snapshot("company-dev/project-delivery-hub");
  await page.route("**/api/plugins/*/snapshot", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    await route.fulfill({ response, json: { ...snapshot, extensionTools: [
      { id: "reference", name: "公开资料", purpose: "查看公开使用说明。", url: "https://example.org/guide" },
    ] } });
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await openPlugin(page);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    const color = theme === "light" ? "rgb(23, 28, 36)" : "rgb(243, 244, 247)";
    for (const [section, name] of pages) {
      await navigate(page, section, name);
      await expect(page.getByRole("main")).toHaveCSS("color", color);
      await expect(page.locator("body")).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)");
      for (const surface of await page.locator(".table-frame, th, .markdown-document").all()) {
        await expect(surface).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      }
      for (const step of await page.locator(".workflow-graph .workflow-step").all()) {
        await expect(step).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(step).toHaveCSS("border-top-width", "0px");
      }
      await expectNoOverflow(page);
    }
    await page.goto(`${portal.baseUrl}/#/hub`);
    const toolbar = page.locator(".company-dev-hub-toolbar");
    const themeToggle = toolbar.getByRole("button", { name: theme === "light" ? "切换为深色" : "切换为浅色" });
    await expect(themeToggle).toBeVisible();
    await expect(themeToggle).toHaveText("");
    await expect(themeToggle).not.toHaveAttribute("title");
    const heading = page.locator(".company-dev-hub-section-heading");
    const headingText = heading.getByRole("heading", { level: 2, name: "插件" });
    const includeButton = heading.getByRole("button", { name: "纳入插件" });
    await expect(heading).toHaveCSS("gap", "12px");
    await expect(includeButton).toHaveText("");
    await expect(includeButton.locator("svg")).toHaveCount(1);
    const [headingBox, includeBox] = await Promise.all([headingText.boundingBox(), includeButton.boundingBox()]);
    expect(Math.abs(includeBox!.x - headingBox!.x - headingBox!.width - 12)).toBeLessThan(1);
    await expect(page.locator(".company-dev-hub-entry-action")).toHaveCount(0);
    await expect(page.locator(".company-dev-hub")).toHaveCSS("color", color);
    await expect(page.locator(".portal-capsule-glass")).toHaveCount(0);
    await page.getByRole("button", { name: "纳入插件" }).click();
    const dialog = page.getByRole("dialog", { name: "纳入插件" });
    await expect(dialog).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(11, 15, 21)");
    await expect(dialog.getByLabel("插件目录")).toHaveCSS("color", color);
    await capture(page, testInfo, `${theme}-hub-dialog`);
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "昱胜 Inc", exact: true }).click();
    await expect(page.getByRole("main", { name: "鸟瞰全景" })).toHaveCSS("color", color);
    await expect(page.locator("html")).toHaveAttribute("data-portal-theme", theme);
    await openPlugin(page);
  }
  expect(await portal.snapshot("company-dev/project-delivery-hub")).toEqual(original);
  expect(errors).toEqual([]);
  expect(remote).toEqual([]);
});

test("keeps Prompt and workflow drafts, focus, errors and scroll when another tab changes the theme", async ({ page, context }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openPlugin(page, "prompts");
  const themePage = await context.newPage();
  await themePage.goto(`${portal.baseUrl}/#/hub`);
  await expect(themePage.getByRole("button", { name: "切换为浅色" })).toBeVisible();
  await page.bringToFront();
  await page.getByRole("button", { name: "新增 Prompt", exact: true }).click();
  const prompt = page.getByRole("dialog", { name: "新增 Prompt" });
  const scenario = prompt.getByLabel("常用场景");
  await scenario.fill("保留未保存场景");
  await prompt.getByLabel("Prompt 内容").fill("未保存的内容");
  await page.route("**/api/plugins/*/prompts", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 409, json: { error: { code: "revision_conflict", message: "资料已更新，请重试" } } });
  });
  await prompt.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("alert")).toContainText("资料已更新，请重试");
  await scenario.focus();
  await scenario.evaluate((element) => element.setAttribute("data-original-node", "true"));
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await setTheme(themePage, "light");
  await expect(page.locator("html")).toHaveAttribute("data-portal-theme", "light");
  await expect(scenario).toHaveAttribute("data-original-node", "true");
  await expect(scenario).toHaveValue("保留未保存场景");
  await expect(scenario).toBeFocused();
  await expect(prompt.getByLabel("Prompt 内容")).toHaveValue("未保存的内容");
  await expect(prompt).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.getByRole("alert")).toContainText("资料已更新，请重试");
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "新增 Prompt", exact: true })).toBeFocused();

  await navigate(page, "overview", "鸟瞰全景");
  await page.getByRole("button", { name: "配置流程", exact: true }).click();
  const workflow = page.getByRole("dialog", { name: "配置流程" });
  const title = workflow.getByRole("textbox", { name: "步骤标题", exact: true });
  await title.fill("保留未保存步骤");
  await title.evaluate((element) => element.setAttribute("data-original-node", "true"));
  await setTheme(themePage, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-portal-theme", "dark");
  await expect(title).toHaveAttribute("data-original-node", "true");
  await expect(title).toHaveValue("保留未保存步骤");
  await expect(title).toBeFocused();
  const inspector = workflow.getByRole("complementary", { name: "属性栏" });
  const canvas = workflow.getByRole("region", { name: "流程画布" });
  await expect(inspector).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(await inspector.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe(await canvas.evaluate((element) => getComputedStyle(element).backgroundColor));
  await expect(workflow.getByRole("region", { name: "流程画布" })).toContainText("保留未保存步骤");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "配置流程", exact: true })).toBeFocused();
  await themePage.close();
});

for (const width of [1600, 1120, 1024, 1023, 768, 390, 320]) {
  test(`keeps desktop appearance hidden and compact navigation unclipped at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await openPlugin(page, "prompts");
    const capsule = page.locator(".portal-capsule");
    const navigation = page.getByRole("navigation", { name: "插件内容" });
    const download = page.locator(".portal-download-action");
    const action = page.getByRole("button", { name: "新增 Prompt", exact: true });
    await expect(download).toHaveAttribute("aria-label", "下载最新版 v3.7.17");
    await expect(download).toHaveText("v3.7.17");
    const downloadBox = (await download.boundingBox())!;
    expect((await action.boundingBox())!.x + (await action.boundingBox())!.width).toBeLessThan(downloadBox.x);
    if (width >= 1024) {
      await expect(page.locator(".portal-theme-toggle")).toHaveCount(0);
      const initialNav = (await navigation.boundingBox())!;
      const initialCapsule = (await capsule.boundingBox())!;
      expect(Math.abs(initialNav.x + initialNav.width / 2 - initialCapsule.x - initialCapsule.width / 2)).toBeLessThan(1);
      const settings = page.getByRole("button", { name: "外观设置" });
      await expect(settings).toHaveCSS("border-top-width", "0px");
      await expect(settings).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      expect((await settings.boundingBox())!.x).toBeGreaterThan(downloadBox.x + downloadBox.width);
      await settings.click();
      const panel = page.getByRole("group", { name: "主题设置" });
      await expect(panel).toBeVisible();
      expect(await navigation.boundingBox()).toEqual(initialNav);
      expect(await capsule.boundingBox()).toEqual(initialCapsule);
      await page.getByRole("button", { name: "切换为浅色" }).click();
      expect(await navigation.boundingBox()).toEqual(initialNav);
      await page.keyboard.press("Escape");
      await expect(settings).toBeFocused();
      await expect(panel).toHaveCount(0);
      await settings.click();
      await page.getByRole("main").click({ position: { x: 10, y: 180 } });
      await expect(panel).toHaveCount(0);
    } else {
      await expect(page.getByRole("button", { name: "外观设置" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "切换为浅色" })).toBeVisible();
      await setTheme(page, "light");
      const more = page.getByRole("button", { name: "打开导航菜单" });
      await more.click();
      await expect(navigation.getByRole("link")).toHaveCount(6);
      const menuBox = (await navigation.boundingBox())!;
      const capsuleBox = (await capsule.boundingBox())!;
      expect(menuBox.y).toBeGreaterThan(capsuleBox.y + capsuleBox.height);
      for (const link of await navigation.getByRole("link").all()) {
        await expect(link).toBeVisible();
        expect(await link.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        })).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(more).toBeFocused();
      await more.click();
      await navigation.getByRole("link", { name: "Skills", exact: true }).click();
      await expect(navigation).toBeHidden();
      await expect(page.getByRole("main", { name: "Skills" })).toBeVisible();
      await expect(more).toBeFocused();
      await more.click();
      await expect(navigation.getByRole("link", { name: "Skills", exact: true })).toHaveAttribute("aria-current", "page");
      await page.mouse.click(width / 2, 850);
      await expect(navigation).toBeHidden();
    }
    await expectNoOverflow(page);
    await capture(page, testInfo, `light-${width}`);
    expect(errors).toEqual([]);
  });
}

test("supports read-only users, blocked storage and invalid stored values", async ({ page, browser }) => {
  const readOnlyUrl = await portal.startReadOnly();
  await page.goto(`${readOnlyUrl}/#/hub`);
  await expect(page.getByRole("button", { name: "纳入插件" })).toHaveCount(0);
  await setTheme(page, "light");
  await page.getByRole("link", { name: "研发助手插件", exact: true }).click();
  await expect(page.getByRole("button", { name: "配置流程", exact: true })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-portal-theme", "light");
  await navigate(page, "prompts", "Prompts");
  await expect(page.getByRole("button", { name: "新增 Prompt", exact: true })).toHaveCount(0);
  await setTheme(page, "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-portal-theme", "dark");
  const blocked = await browser.newContext();
  try {
    await blocked.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException("Blocked", "SecurityError"); };
      Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); };
    });
    const isolated = await blocked.newPage();
    await openPlugin(isolated);
    await setTheme(isolated, "light");
    await expect(isolated.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  } finally { await blocked.close(); }
  await page.evaluate(() => localStorage.setItem("plugin-portal.theme", "invalid"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-portal-theme", "dark");
});

test("reuses the displacement map while scrolling and changing theme, then resizes and releases it", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openPlugin(page);
  const glass = page.locator(".portal-capsule-glass");
  await expect(glass).toHaveAttribute("data-glass-mode", "refractive");
  const initial = await glass.locator("feImage").getAttribute("href");
  await page.locator(".portal-content").evaluate((element) => { element.style.minHeight = "1800px"; });
  await page.evaluate(() => window.scrollTo(0, 80));
  await expect(page.locator(".portal-capsule")).toHaveAttribute("data-visibility", "hidden");
  await page.evaluate(() => window.scrollTo(0, 56));
  await expect(page.locator(".portal-capsule")).toHaveAttribute("data-visibility", "visible");
  await setTheme(page, "light");
  expect(await glass.locator("feImage").getAttribute("href")).toBe(initial);
  await page.setViewportSize({ width: 1120, height: 900 });
  await expect.poll(() => glass.locator("feImage").getAttribute("href")).not.toBe(initial);
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(glass.locator("feImage")).toHaveAttribute("href", initial!);
  await page.evaluate(() => { window.location.hash = "#/hub"; });
  await expect(glass).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.locator(".portal-glass-definitions")).toHaveCount(0);
});

test("uses clear glass on reduced motion and allocation failure without disabling navigation", async ({ page, browser }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openPlugin(page);
  await expect(page.locator(".portal-capsule-glass")).toHaveAttribute("data-glass-mode", "clear");
  await expect(page.locator(".portal-glass-definitions")).toHaveCount(0);
  await expect(page.locator(".portal-capsule")).toHaveCSS("transition-duration", "0s");
  await navigate(page, "mcp", "MCP");
  await setTheme(page, "light");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator(".portal-capsule-glass")).toHaveAttribute("data-glass-mode", "refractive");
  const failed = await browser.newContext();
  try {
    await failed.addInitScript(() => { HTMLCanvasElement.prototype.toDataURL = () => { throw new Error("Encoding unavailable"); }; });
    const isolated = await failed.newPage();
    await openPlugin(isolated);
    await expect(isolated.locator(".portal-capsule-glass")).toHaveAttribute("data-glass-mode", "clear");
    await navigate(isolated, "mcp", "MCP");
    await setTheme(isolated, "light");
    await expect(isolated.getByRole("main")).toHaveCSS("color", "rgb(23, 28, 36)");
  } finally { await failed.close(); }
});

test("keeps loading and error surfaces readable under a saved light theme", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("plugin-portal.theme", "light"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/plugins/*/snapshot", async (route) => { await gate; await route.continue(); });
  await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/skills`);
  await expect(page.getByText("正在读取公开资料…", { exact: true })).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  release();
  await expect(page.locator(".portal-content")).toHaveAttribute("aria-busy", "false");
  await page.unroute("**/api/plugins/*/snapshot");
  await page.route("**/api/plugins/*/snapshot", (route) => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "公开资料暂时不可用" } } }));
  await page.reload();
  await expect(page.getByRole("alert")).toHaveText("公开资料暂时不可用");
  await expect(page.getByRole("main")).toHaveCSS("color", "rgb(23, 28, 36)");
});

test("keeps the original cover dark under a saved light theme", async ({ page }) => {
  await installMockWebGpu(page);
  await page.addInitScript(() => localStorage.setItem("plugin-portal.theme", "light"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${portal.baseUrl}/#/`);
  await expect(page.locator(".hub-cover")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator(".portal-cover-accretion")).toHaveCSS("background-color", "rgb(0, 0, 0)");
  await expect(page.locator("[data-cover-accretion-canvas]")).toHaveAttribute("data-render-state", "ready", { timeout: 12_000 });
  await expect(page.locator("[data-cover-loading-status]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start" })).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(page.locator(".portal-theme-toggle")).toBeHidden();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page).toHaveURL(`${portal.baseUrl}/#/hub`);
  await expect(page.getByRole("button", { name: "切换为深色" })).toBeVisible();
});

for (const theme of ["dark", "light"] as const) {
test(`renders measurable static glass depth without moving foreground content in ${theme} theme`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openPlugin(page);
  await setTheme(page, theme);
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.id = "glass-depth-fixture";
    fixture.style.cssText = "position:fixed;z-index:1;inset:0;background:#74808c;pointer-events:none";
    document.body.append(fixture);
  });
  const capsule = page.locator(".portal-capsule");
  const glass = page.locator(".portal-capsule-glass");
  const fog = page.locator(".portal-capsule-glass-fog");
  const optics = page.locator(".portal-capsule-glass-optics");
  const capsuleBox = (await capsule.boundingBox())!;
  const padding = 24;
  const clip = {
    x: capsuleBox.x - padding,
    y: capsuleBox.y - padding,
    width: capsuleBox.width + padding * 2,
    height: capsuleBox.height + padding * 2,
  };
  const foregroundBefore = await page.locator(".portal-capsule nav a").evaluateAll((links) => links.map((link) => {
    const bounds = link.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }));
  const depthPath = testInfo.outputPath(`${theme}-depth.png`);
  const depth = await page.screenshot({ path: depthPath, clip });
  await page.addStyleTag({ content: `
    :root {
      --glass-rim-top: transparent !important;
      --glass-rim-left: transparent !important;
      --glass-rim-bottom: transparent !important;
      --glass-rim-right: transparent !important;
      --glass-specular-primary: transparent !important;
      --glass-specular-secondary: transparent !important;
      --glass-contact-shadow: 0 0 0 rgba(0, 0, 0, 0) !important;
      --glass-float-shadow: 0 0 0 rgba(0, 0, 0, 0) !important;
    }
  ` });
  const flatPath = testInfo.outputPath(`${theme}-flat-control.png`);
  const flat = await page.screenshot({ path: flatPath, clip });
  const foregroundAfter = await page.locator(".portal-capsule nav a").evaluateAll((links) => links.map((link) => {
    const bounds = link.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }));
  const difference = await page.evaluate(async ({ before, after, inset, capsuleHeight }) => {
    const decode = async (bytes: string) => {
      const image = new Image(); image.src = `data:image/png;base64,${bytes}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      return { pixels: context.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height };
    };
    const decorated = await decode(before); const control = await decode(after);
    const averageDelta = (fromY: number, toY: number) => {
      let delta = 0; let samples = 0;
      for (let y = fromY; y < toY; y++) for (let x = inset + 48; x < decorated.width - inset - 48; x++) {
        const offset = (y * decorated.width + x) * 4;
        delta += Math.abs(decorated.pixels[offset] - control.pixels[offset]);
        delta += Math.abs(decorated.pixels[offset + 1] - control.pixels[offset + 1]);
        delta += Math.abs(decorated.pixels[offset + 2] - control.pixels[offset + 2]);
        samples++;
      }
      return delta / samples / 3;
    };
    return {
      topRim: averageDelta(inset, inset + 7),
      center: averageDelta(inset + Math.floor(capsuleHeight / 2) - 3, inset + Math.floor(capsuleHeight / 2) + 4),
      bottomRim: averageDelta(inset + capsuleHeight - 7, inset + capsuleHeight),
      outsideShadow: averageDelta(inset + capsuleHeight + 2, decorated.height - 3),
    };
  }, {
    before: depth.toString("base64"), after: flat.toString("base64"), inset: padding, capsuleHeight: capsuleBox.height,
  });
  const depthStyles = await optics.evaluate((node) => ({
    opticsShadow: getComputedStyle(node).boxShadow,
    opticsBackground: getComputedStyle(node).backgroundImage,
    capsuleShadow: getComputedStyle(node.closest(".portal-capsule")!).boxShadow,
  }));
  const fogStyles = await fog.evaluate((node) => ({
    backdropFilter: getComputedStyle(node).backdropFilter,
    backgroundColor: getComputedStyle(node).backgroundColor,
  }));
  await testInfo.attach(`${theme}-depth`, { path: depthPath, contentType: "image/png" });
  await testInfo.attach(`${theme}-flat-control`, { path: flatPath, contentType: "image/png" });
  await testInfo.attach(`${theme}-depth-difference`, { body: JSON.stringify(difference), contentType: "application/json" });
  expect(difference.topRim).toBeGreaterThan(1.5);
  expect(difference.bottomRim).toBeGreaterThan(1.5);
  expect(difference.outsideShadow).toBeGreaterThan(.8);
  expect(difference.center).toBeLessThan(Math.max(difference.topRim, difference.bottomRim));
  expect(depthStyles.opticsShadow).not.toBe("none");
  expect(depthStyles.opticsBackground).not.toBe("none");
  expect(depthStyles.capsuleShadow.split(",").length).toBeGreaterThanOrEqual(2);
  expect(fogStyles.backdropFilter).toContain("blur(22px)");
  expect(fogStyles.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  await expect(page.locator(".portal-capsule-glass-dispersion")).toHaveCount(0);
  expect(foregroundAfter).toEqual(foregroundBefore);
});

test(`refracts actual high contrast content without warping the foreground in ${theme} theme`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openPlugin(page);
  await setTheme(page, theme);
  const glass = page.locator(".portal-capsule-glass");
  await expect(glass).toHaveAttribute("data-glass-mode", "refractive");
  const refraction = page.locator(".portal-capsule-glass-refraction");
  await expect(refraction).toHaveCSS("opacity", theme === "light" ? "0.68" : "0.58");
  // The fixture is page content, not a texture inside the glass filter.
  await page.evaluate(() => {
    const pattern = document.createElement("div");
    pattern.id = "refraction-fixture";
    pattern.style.cssText = "position:absolute;top:160px;left:0;width:100%;height:140px;background:conic-gradient(#fff 25%,#000 0 50%,#fff 0 75%,#000 0) 0 0/16px 16px;color:#e000ff;font:bold 40px monospace;";
    pattern.textContent = "REFRACTION 0123456789 — REAL PAGE CONTENT";
    document.querySelector(".portal-main")!.append(pattern);
    document.body.style.minHeight = "2000px";
    window.scrollTo(0, 150);
  });
  // Keyboard focus deliberately holds the capsule visible over the scrolled fixture.
  await page.keyboard.press("Tab");
  await page.locator(".portal-capsule nav a").first().focus();
  const capsule = page.locator(".portal-capsule");
  await expect(capsule).toHaveAttribute("data-visibility", "visible");
  await expect(capsule).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  // A unique foreground color lets us compare glyph pixels, not the changing backdrop between them.
  await page.locator(".portal-capsule nav a").evaluateAll((links) => {
    links.forEach((link) => { (link as HTMLElement).style.color = "#00ff00"; });
  });
  const linkGeometryBefore = await page.locator(".portal-capsule nav a").evaluateAll((links) => links.map((link) => {
    const bounds = link.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }));
  const navigation = page.locator(".portal-capsule nav");
  const refractedPath = testInfo.outputPath("refracted.png");
  const refracted = await capsule.screenshot({ path: refractedPath });
  await navigation.evaluate((node) => { (node as HTMLElement).style.background = "#ff00ff"; });
  const foreground = await navigation.screenshot();
  await navigation.evaluate((node) => { (node as HTMLElement).style.removeProperty("background"); });
  await refraction.evaluate((node) => {
    (node as HTMLElement).style.backdropFilter = "none";
    (node as HTMLElement).style.webkitBackdropFilter = "none";
  });
  const plainPath = testInfo.outputPath("unfiltered-control.png");
  const plain = await capsule.screenshot({ path: plainPath });
  await navigation.evaluate((node) => { (node as HTMLElement).style.background = "#ff00ff"; });
  const foregroundPlain = await navigation.screenshot();
  await navigation.evaluate((node) => { (node as HTMLElement).style.removeProperty("background"); });
  const linkGeometryAfter = await page.locator(".portal-capsule nav a").evaluateAll((links) => links.map((link) => {
    const bounds = link.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }));
  const difference = await page.evaluate(async ({ before, after, textBefore, textAfter }) => {
    const decode = async (bytes: string) => {
      const image = new Image(); image.src = `data:image/png;base64,${bytes}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      return { pixels: context.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height };
    };
    const a = await decode(before); const b = await decode(after);
    let edge = 0; let edgeSamples = 0; let center = 0; let centerSamples = 0;
    for (let y = 4; y < a.height - 4; y++) for (let x = 100; x < a.width - 100; x++) {
      const offset = (y * a.width + x) * 4;
      const delta = Math.abs(a.pixels[offset] - b.pixels[offset]) + Math.abs(a.pixels[offset + 1] - b.pixels[offset + 1]) + Math.abs(a.pixels[offset + 2] - b.pixels[offset + 2]);
      if (y < 14 || y >= a.height - 14) { edge += delta; edgeSamples++; }
      if (Math.abs(y - a.height / 2) < 5) { center += delta; centerSamples++; }
    }
    const foregroundA = await decode(textBefore); const foregroundB = await decode(textAfter);
    let glyphPixels = 0; let changedGlyphPixels = 0; let sharedGlyphPixels = 0;
    let glyphPixelsBefore = 0; let glyphPixelsAfter = 0;
    const boundsBefore = { left: Infinity, top: Infinity, right: -1, bottom: -1 };
    const boundsAfter = { left: Infinity, top: Infinity, right: -1, bottom: -1 };
    const isGlyph = (pixels: Uint8ClampedArray, offset: number) => pixels[offset + 1] - Math.max(pixels[offset], pixels[offset + 2]) > 240;
    for (let offset = 0; offset < foregroundA.pixels.length; offset += 4) {
      const isA = isGlyph(foregroundA.pixels, offset); const isB = isGlyph(foregroundB.pixels, offset);
      const pixel = offset / 4; const x = pixel % foregroundA.width; const y = Math.floor(pixel / foregroundA.width);
      if (isA) {
        glyphPixelsBefore++;
        boundsBefore.left = Math.min(boundsBefore.left, x); boundsBefore.top = Math.min(boundsBefore.top, y);
        boundsBefore.right = Math.max(boundsBefore.right, x); boundsBefore.bottom = Math.max(boundsBefore.bottom, y);
      }
      if (isB) {
        glyphPixelsAfter++;
        boundsAfter.left = Math.min(boundsAfter.left, x); boundsAfter.top = Math.min(boundsAfter.top, y);
        boundsAfter.right = Math.max(boundsAfter.right, x); boundsAfter.bottom = Math.max(boundsAfter.bottom, y);
      }
      if (isA || isB) { glyphPixels++; if (isA && isB) sharedGlyphPixels++; if (isA !== isB) changedGlyphPixels++; }
    }
    return {
      edge: edge / edgeSamples / 3,
      center: center / centerSamples / 3,
      glyphPixels,
      changedGlyphPixels,
      sharedGlyphPixels,
      glyphPixelsBefore,
      glyphPixelsAfter,
      boundsBefore,
      boundsAfter,
    };
  }, {
    before: refracted.toString("base64"), after: plain.toString("base64"),
    textBefore: foreground.toString("base64"), textAfter: foregroundPlain.toString("base64"),
  });
  await testInfo.attach("refracted", { path: refractedPath, contentType: "image/png" });
  await testInfo.attach("unfiltered-control", { path: plainPath, contentType: "image/png" });
  await testInfo.attach("pixel-difference", { body: JSON.stringify(difference), contentType: "application/json" });
  expect(difference.edge).toBeGreaterThan(8);
  expect(difference.center).toBeLessThan(3);
  expect(difference.glyphPixels).toBeGreaterThan(200);
  expect(linkGeometryAfter).toEqual(linkGeometryBefore);
  expect(difference.boundsAfter).toEqual(difference.boundsBefore);
  expect(Math.abs(difference.glyphPixelsAfter - difference.glyphPixelsBefore) / difference.glyphPixels).toBeLessThan(.01);
  expect(difference.sharedGlyphPixels / difference.glyphPixels).toBeGreaterThan(.85);
});

test(`visibly fogs high contrast page content behind the capsule in ${theme} theme`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openPlugin(page);
  await setTheme(page, theme);
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.id = "fog-contrast-fixture";
    fixture.textContent = "HIGH CONTRAST PAGE CONTENT 0123456789";
    fixture.style.cssText = "position:fixed;z-index:1;top:0;left:0;width:100%;height:112px;background:repeating-linear-gradient(90deg,#fff 0 8px,#000 8px 16px);color:#ff004c;font:bold 34px monospace;line-height:88px;text-align:center;";
    document.body.append(fixture);
    document.querySelectorAll(".portal-capsule > .portal-brand,.portal-capsule nav,.portal-capsule-actions").forEach((node) => {
      (node as HTMLElement).style.visibility = "hidden";
    });
  });
  const capsule = page.locator(".portal-capsule");
  const foggedPath = testInfo.outputPath(`${theme}-fogged.png`);
  const fogged = await capsule.screenshot({ path: foggedPath });
  await page.locator(".portal-capsule-glass-fog").evaluate((node) => {
    const element = node as HTMLElement;
    element.style.backdropFilter = "none";
    element.style.webkitBackdropFilter = "none";
    element.style.background = "transparent";
  });
  await page.locator(".portal-capsule-glass-refraction").evaluate((node) => {
    (node as HTMLElement).style.display = "none";
  });
  const clearPath = testInfo.outputPath(`${theme}-clear-control.png`);
  const clear = await capsule.screenshot({ path: clearPath });
  const contrast = await page.evaluate(async ({ foggedBytes, clearBytes }) => {
    const decode = async (bytes: string) => {
      const image = new Image(); image.src = `data:image/png;base64,${bytes}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      return { pixels: context.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height };
    };
    const deviation = ({ pixels, width, height }: Awaited<ReturnType<typeof decode>>) => {
      let sum = 0; let squareSum = 0; let count = 0;
      for (let y = 16; y < height - 16; y++) for (let x = 120; x < width - 120; x++) {
        const offset = (y * width + x) * 4;
        const luminance = pixels[offset] * .2126 + pixels[offset + 1] * .7152 + pixels[offset + 2] * .0722;
        sum += luminance; squareSum += luminance * luminance; count++;
      }
      const mean = sum / count;
      return Math.sqrt(Math.max(0, squareSum / count - mean * mean));
    };
    return { fogged: deviation(await decode(foggedBytes)), clear: deviation(await decode(clearBytes)) };
  }, { foggedBytes: fogged.toString("base64"), clearBytes: clear.toString("base64") });
  await testInfo.attach(`${theme}-fogged`, { path: foggedPath, contentType: "image/png" });
  await testInfo.attach(`${theme}-clear-control`, { path: clearPath, contentType: "image/png" });
  await testInfo.attach(`${theme}-fog-contrast`, { body: JSON.stringify(contrast), contentType: "application/json" });
  expect(contrast.clear).toBeGreaterThan(30);
  expect(contrast.fogged).toBeLessThan(contrast.clear * .65);
});
}
