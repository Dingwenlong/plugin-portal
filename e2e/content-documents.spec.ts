import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { startTestPortal, type TestPortal } from "./testServer";

let portal: TestPortal;
const key = "company-dev/project-delivery-hub";
const path = `/api/plugins/${encodeURIComponent(key)}/content/`;
const file = (document: unknown) => ({ name: "content.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(document)) });
const mcp = { schemaVersion: "1.0.0", documentType: "mcp", pluginKey: key, pluginVersion: "3.7.18", services: [
  { id: "sample-service", name: "插件检查", tools: [{ id: "check_package", name: "检查插件包", purpose: "列出文件差异。<script>仅作为文字</script>", scenarios: ["更新前核对插件包", "排查安装差异"] }] },
] };
const releases = { schemaVersion: "1.0.0", documentType: "releases", pluginKey: key, releases: [
  { version: "3.7.9", releasedAt: null, summary: "较早的版本", changes: [{ type: "added", text: "新增检查" }] },
  { version: "3.7.19", releasedAt: "2026-09-10", summary: "完善插件检查", changes: [{ type: "fixed", text: "修复版本匹配" }] },
] };

test.beforeEach(async () => {
  portal = await startTestPortal();
  await portal.promote(await portal.preview("project-delivery-hub", "3.7.19", "研发助手插件"), 0);
  await portal.seedUserContent();
});
test.afterEach(async () => { await portal?.stop(); });
test.use({ ignoreHTTPSErrors: true });

for (const kind of ["mcp", "releases"] as const) {
  test(`${kind}: long preview scrolls while confirmation stays visible`, async ({ page }) => {
    const long = kind === "mcp" ? { ...mcp, services: [{ id: "service", name: "服务", tools: Array.from({ length: 36 }, (_, i) => ({
      id: `tool-${i}`, name: `功能 ${i}`, purpose: "完整功能说明。".repeat(20), scenarios: ["使用场景"] })) }] }
      : { ...releases, releases: Array.from({ length: 36 }, (_, i) => ({ version: `1.0.${i}`, releasedAt: null,
        summary: "版本说明。".repeat(20), changes: [{ type: "added", text: "新增功能" }] })) };
    await page.goto(`${portal.baseUrl}/#/plugins/${encodeURIComponent(key)}/${kind}`);
    await expect(page.getByRole("button", { name: "上传 JSON" })).toBeEnabled();
    await page.getByLabel("页面 JSON 文件").setInputFiles(file(long));
    const dialog = page.getByRole("dialog", { name: "内容变更预览" });
    const body = dialog.getByRole("region", { name: "内容预览正文" });
    const confirm = dialog.getByRole("button", { name: "确认替换" });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(confirm).toBeInViewport();
      await expect.poll(() => body.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await body.hover(); await page.mouse.wheel(0, 700);
      await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      await body.focus(); await page.keyboard.press("Control+End");
      await expect(confirm).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath(`${kind}-${width}.png`) });
    }
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await page.reload();
    expect((await (await page.request.get(`${portal.baseUrl}${path}${kind}`)).json()).document).toEqual(long);
  });
}

for (const kind of ["mcp", "releases"] as const) {
  test(`${kind}: template, cancel, replace, export, reimport and readonly`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    const document = kind === "mcp" ? mcp : releases;
    const remote = await portal.startRemoteManagement();
    await page.goto(`${remote}/#/plugins/${encodeURIComponent(key)}/${kind}`);
    const toolbar = page.locator("main .portal-page-toolbar");
    await expect(toolbar.getByRole("button", { name: "上传 JSON" })).toBeEnabled();
    await expect(page.locator("header .portal-page-action")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "扩展工具", exact: true })).toHaveCount(0);
    const templateDownload = page.waitForEvent("download");
    await toolbar.getByRole("link", { name: "下载模板" }).click();
    const template = JSON.parse(readFileSync((await (await templateDownload).path())!, "utf8"));
    expect(template.pluginKey).toBe(key); expect(template.documentType).toBe(kind); expect(template._instructions.length).toBeGreaterThan(0);
    const upload = () => page.getByLabel("页面 JSON 文件").setInputFiles(file(document));
    await upload();
    let dialog = page.getByRole("dialog", { name: "内容变更预览" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await (await page.request.get(`${remote}${path}${kind}`)).json()).document).toBeNull();
    await expect(toolbar.getByRole("button", { name: "上传 JSON" })).toBeFocused();
    await upload();
    await dialog.getByRole("button", { name: "确认替换" }).click();
    await expect(page.getByText("页面内容已更新")).toBeVisible();
    await page.reload();
    if (kind === "mcp") {
      await expect(page.getByRole("heading", { name: "检查插件包" })).toBeVisible();
      await expect(page.getByText("说明对应 v3.7.18，当前插件 v3.7.19")).toBeVisible();
      await expect(page.getByText("更新前核对插件包")).toBeVisible();
      expect(await page.locator(".document-tool script").count()).toBe(0);
    } else {
      await expect(page.locator(".document-release h2").first()).toHaveText("v3.7.19");
      await expect(page.getByText("发布日期未知")).toBeVisible();
    }
    const exportDownload = page.waitForEvent("download");
    await toolbar.getByRole("link", { name: "导出当前 JSON" }).click();
    const exported = JSON.parse(readFileSync((await (await exportDownload).path())!, "utf8"));
    expect(exported).toEqual(document);
    await page.getByLabel("页面 JSON 文件").setInputFiles(file(exported));
    await expect(dialog.getByText("确认后整页替换。新增 0 项，修改 0 项，移除 0 项。")).toBeVisible();
    await dialog.getByRole("button", { name: "确认替换" }).click();
    await expect(dialog).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(toolbar.getByRole("button", { name: "上传 JSON" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`${kind}-mobile.png`), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.screenshot({ path: test.info().outputPath(`${kind}-desktop.png`), fullPage: true });
    const reader = await portal.startReadOnly();
    await page.goto(`${reader}/#/plugins/${encodeURIComponent(key)}/${kind}`);
    await expect(page.getByRole("link", { name: "导出当前 JSON" })).toBeVisible();
    await expect(page.getByRole("button", { name: "上传 JSON" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("legacy extensions route opens MCP; page actions stay local and clear requires preview", async ({ page }) => {
  await page.goto(`${portal.baseUrl}/#/plugins/${encodeURIComponent(key)}/extensions`);
  await expect(page).toHaveURL(`${portal.baseUrl}/#/plugins/${encodeURIComponent(key)}/mcp`);
  await expect(page.getByRole("button", { name: "上传 JSON" })).toBeEnabled();
  await page.getByLabel("页面 JSON 文件").setInputFiles(file({ ...mcp, pluginKey: "company-internal/project-delivery-hub" }));
  await expect(page.getByRole("alert")).toContainText("pluginKey");
  await page.getByLabel("页面 JSON 文件").setInputFiles(file(mcp));
  await page.getByRole("button", { name: "确认替换" }).click();
  await expect(page.getByText("页面内容已更新")).toBeVisible();
  await page.getByLabel("页面 JSON 文件").setInputFiles(file({ ...mcp, services: [] }));
  const dialog = page.getByRole("dialog", { name: "内容变更预览" });
  await expect(dialog.getByRole("alert")).toContainText("清空本页已上传内容，移除 2 项");
  await dialog.getByRole("button", { name: "确认替换" }).click();
  await expect(page.getByText("尚无 MCP 功能说明。")).toBeVisible();
  await page.goto(`${portal.baseUrl}/#/plugins/${encodeURIComponent(key)}/prompts`);
  await expect(page.locator("main .portal-page-toolbar").getByRole("button", { name: "新增 Prompt" })).toBeVisible();
  await expect(page.locator("header .portal-page-action")).toHaveCount(0);
  await page.goto(`${portal.baseUrl}/#/plugins/${encodeURIComponent(key)}/overview`);
  await page.locator("main .portal-page-toolbar").getByRole("button", { name: "编辑流程" }).click();
  await expect(page.getByRole("region", { name: "流程编辑" })).toBeVisible();
  await expect(page.locator("header .portal-page-action")).toHaveCount(0);
  await page.getByRole("button", { name: "退出编辑" }).click();
  await expect(page.getByRole("button", { name: "编辑流程" })).toBeFocused();
});
