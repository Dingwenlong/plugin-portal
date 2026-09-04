import { expect, test, type Page } from "@playwright/test";

import { startTestPortal, type TestPortal } from "./testServer";

let portal: TestPortal;

const pluginPages = ["overview", "skills", "prompts", "mcp", "extensions", "rules", "releases"];

test.beforeAll(async () => {
  portal = await startTestPortal();
  await portal.promote(await portal.preview("project-delivery-hub", "3.7.19", "研发助手插件"), 0);
  await portal.promote(await portal.preview("yusheng-inc", "1.1.4", "昱胜 Inc"), 1);
  await portal.seedUserContent();
});

test.afterAll(async () => { await portal?.stop(); });

async function expectNoConventionalBorders(page: Page, context: string) {
  const violations = await page.locator("body").evaluate((body) => {
    const visible = (element: Element, style: CSSStyleDeclaration) => {
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0";
    };
    return Array.from(body.querySelectorAll("*"), (element) => {
      const style = getComputedStyle(element);
      const widths = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
      if (!visible(element, style) || element.matches(".portal-capsule") || widths.every((width) => width === "0px")) return null;
      const name = element.getAttribute("aria-label") || element.getAttribute("class") || element.tagName.toLowerCase();
      return { name, widths };
    }).filter((entry): entry is { name: string; widths: string[] } => entry !== null);
  });
  expect(violations, `${context} still contains conventional borders`).toEqual([]);
}

async function openPlugin(page: Page, section: string) {
  await page.goto(`${portal.baseUrl}/#/plugins/project-delivery-hub/${section}`);
  await expect(page.locator(".portal-content")).toHaveAttribute("aria-busy", "false");
}

test("removes conventional borders from Hub, plugin pages, overlays and compact navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  for (const theme of ["dark", "light"] as const) {
    await page.goto(`${portal.baseUrl}/#/hub`);
    await page.evaluate((value) => localStorage.setItem("plugin-portal.theme", value), theme);
    await page.reload();
    await expect(page.getByRole("link", { name: "研发助手插件" })).toBeVisible();
    await expectNoConventionalBorders(page, `${theme} Hub`);

    await page.getByRole("button", { name: "纳入插件" }).click();
    await expect(page.getByRole("dialog", { name: "纳入插件" })).toBeVisible();
    await expectNoConventionalBorders(page, `${theme} inclusion dialog`);
    await page.getByRole("dialog", { name: "纳入插件" }).getByRole("button", { name: "关闭" }).click();

    await page.getByRole("button", { name: "发布 研发助手插件 下载" }).click();
    const publication = page.getByRole("dialog", { name: "发布 研发助手插件 下载" });
    await expect(publication).toBeVisible();
    await expectNoConventionalBorders(page, `${theme} download dialog`);
    await publication.getByRole("button", { name: "选择候选 ZIP" }).click();
    await expect(publication.getByRole("button", { name: "确认发布" })).toBeVisible();
    await expectNoConventionalBorders(page, `${theme} download preview`);
    await publication.getByRole("button", { name: "关闭" }).click();

    for (const section of pluginPages) {
      await openPlugin(page, section);
      await expectNoConventionalBorders(page, `${theme} ${section}`);
    }

    await openPlugin(page, "prompts");
    await page.getByRole("button", { name: "新增 Prompt" }).click();
    await expect(page.getByRole("dialog", { name: "新增 Prompt" })).toBeVisible();
    await expectNoConventionalBorders(page, `${theme} Prompt dialog`);
    await page.keyboard.press("Escape");

    await openPlugin(page, "overview");
    await page.getByRole("button", { name: "配置流程" }).click();
    await expect(page.getByRole("dialog", { name: "配置流程" })).toBeVisible();
    await expectNoConventionalBorders(page, `${theme} workflow dialog`);
    await page.keyboard.press("Escape");

    await openPlugin(page, "skills");
    await page.getByRole("button", { name: "外观设置" }).click();
    await expect(page.getByRole("group", { name: "主题设置" })).toBeVisible();
    await expectNoConventionalBorders(page, `${theme} appearance panel`);
    await page.keyboard.press("Escape");

    for (const width of [1120, 1023, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await openPlugin(page, "skills");
      await expectNoConventionalBorders(page, `${theme} skills at ${width}px`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${theme} overflow at ${width}px`).toBe(false);
    }
    await page.setViewportSize({ width: 1600, height: 900 });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await openPlugin(page, "skills");
  await page.getByRole("button", { name: "打开导航菜单" }).click();
  await expect(page.getByRole("navigation", { name: "插件内容" })).toBeVisible();
  await expectNoConventionalBorders(page, "compact navigation");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test("retains the glass rim, selected indicator and borderless focus feedback", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openPlugin(page, "prompts");

  const capsule = page.locator(".portal-capsule");
  await expect(capsule).toHaveCSS("border-top-width", "1px");
  const selected = page.getByRole("link", { name: "Prompts", exact: true });
  expect(await selected.evaluate((element) => getComputedStyle(element, "::after").opacity)).not.toBe("0");

  const action = page.getByRole("button", { name: "新增 Prompt" });
  await action.focus();
  await expect(action).toHaveCSS("border-top-width", "0px");
  await expect(action).toHaveCSS("outline-style", "none");
  expect(await action.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");

  await action.click();
  const input = page.getByLabel("常用场景");
  await input.focus();
  await expect(input).toHaveCSS("border-top-width", "0px");
  await expect(input).toHaveCSS("outline-style", "none");
  expect(await input.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
});
