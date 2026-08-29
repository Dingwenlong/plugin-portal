import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { installMockWebGpu } from "./mockWebGpu";
import { startTestPortal, type TestPortal } from "./testServer";

test.describe("original cover", () => {
  let portal: TestPortal;
  test.beforeAll(async () => { portal = await startTestPortal(); });
  test.afterAll(async () => { await portal?.stop(); });
  test.beforeEach(async ({ page }, testInfo) => {
    if (testInfo.title.includes("WebGPU is unavailable")) return;
    await installMockWebGpu(
      page,
      testInfo.title.includes("before the first WebGPU frame") ? 2_000 : 0,
    );
  });

  for (const viewport of [{ width: 1600, height: 900 }, { width: 390, height: 844 }]) {
  test(`keeps original pixels and the Canvas Liquid Orb at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    const inheritedWarnings: string[] = [];
    const remote: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // The unchanged document has no favicon. Full Chrome/Edge request it;
      // retain that baseline warning separately from cover runtime failures.
      if (message.location().url === `${portal.baseUrl}/favicon.ico` && message.text().includes("404")) {
        inheritedWarnings.push(message.text());
      } else errors.push(message.text());
    });
    page.on("request", (request) => { if (!request.url().startsWith(portal.baseUrl)) remote.push(request.url()); });
    await page.goto(`${portal.baseUrl}/#/`);
    const start = page.getByRole("button", { name: "Start" });
    await expect(page.locator(".hub-cover-attribution")).toHaveCSS("clip-path", "inset(50%)");
    await expect(start).toBeEnabled({ timeout: 12_000 });
    await expect.soft(start).toHaveCSS("border-top-width", "0px");
    await expect.soft(start).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect.soft(start).toHaveCSS("box-shadow", "none");
    await expect.soft(start).toHaveCSS("text-shadow", "none");
    const background = page.locator("[data-cover-accretion-canvas]");
    await expect(background).toHaveAttribute("data-render-state", "ready");
    await expect.soft(background).toHaveJSProperty("width", viewport.width);
    await expect.soft(background).toHaveJSProperty("height", viewport.height);
    await expect.soft(background).toHaveCSS("filter", "none");
    await expect.soft(background).toHaveCSS("opacity", "1");
    await expect(start).toHaveCSS("width", "112px");
    await expect(start).toHaveCSS("height", "112px");
    await start.hover();
    await expect(start).toHaveCSS("border-top-width", "0px");
    const buttonCanvas = page.locator("[data-cover-liquid-glass-canvas]");
    await expect.poll(async () => Number(await buttonCanvas.getAttribute("data-rendered-frame")), { timeout: 12_000 }).toBeGreaterThan(0);
    await expect(buttonCanvas).toHaveAttribute("data-orb-style", "particleRibbon");
    await expect(start).toHaveAttribute("data-renderer", "lersent-orb-particle-ribbon");
    await page.screenshot({ path: testInfo.outputPath("cover.png") });
    await start.focus();
    await expect(start).toHaveCSS("outline-width", "2px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => {
      const root = document.querySelector("[data-hub-entry-phase]")!;
      const measurement = { clickedAt: 0, completedAt: 0 };
      Object.assign(window, { coverKeyboardMeasurement: measurement });
      document.querySelector("[data-cover-liquid-glass-button]")!.addEventListener("click", () => {
        measurement.clickedAt = performance.now();
      }, { once: true });
      new MutationObserver(() => {
        if (root.getAttribute("data-hub-entry-phase") === "hub") {
          measurement.completedAt = performance.now();
        }
      }).observe(root, { attributes: true, attributeFilter: ["data-hub-entry-phase"] });
    });
    await start.press("Enter");
    await expect(page.locator("[data-hub-entry-phase]")).toHaveAttribute("data-hub-entry-phase", "hub", { timeout: 3_000 });
    const measurement = await page.evaluate(() => (window as unknown as {
      coverKeyboardMeasurement: { clickedAt: number; completedAt: number };
    }).coverKeyboardMeasurement);
    expect(measurement.clickedAt).toBeGreaterThan(0);
    expect(measurement.completedAt - measurement.clickedAt).toBeGreaterThan(0);
    expect(measurement.completedAt - measurement.clickedAt).toBeLessThan(3_000);
    await expect(background).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(remote).toEqual([]);
    await testInfo.attach("inherited-browser-warnings", { body: JSON.stringify(inheritedWarnings), contentType: "application/json" });
  });
  }

  test("matches the retained original p5 sketch at the same static time", async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width: 768, height: 540 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${portal.baseUrl}/#/`);
    const canvas = page.locator("[data-cover-accretion-canvas]");
    await expect(canvas).toHaveAttribute("data-render-state", "ready", { timeout: 12_000 });
    await expect(canvas).toHaveAttribute("data-rendered-clock", "0.000000");
    const frame = await canvas.getAttribute("data-rendered-frame");
    await page.waitForTimeout(250);
    expect(await canvas.getAttribute("data-rendered-frame")).toBe(frame);
    const actual = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    const reference = await context.newPage();
    await reference.setViewportSize({ width: 768, height: 540 });
    const original = (name: string) => readFileSync(`src/hub/accretion-original/${name}`, "utf8");
    await reference.route("**/__reference/**", async (route) => {
      const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
      if (name === "index.html") {
        await route.fulfill({ contentType: "text/html", body: '<html><head><style>html,body{margin:0;padding:0;overflow:hidden}</style><script src="p5.js"></script><script src="mySketch.js"></script></head><body></body></html>' });
      } else if (name === "p5.js") {
        await route.fulfill({ contentType: "text/javascript", body: readFileSync("node_modules/p5/lib/p5.min.js", "utf8") });
      } else if (name === "mySketch.js") {
        await route.fulfill({ contentType: "text/javascript", body: original(name) + '\nconst originalDraw = draw; draw = function () { millis = () => 0; originalDraw(); noLoop(); document.body.dataset.ready = "true"; };' });
      } else {
        await route.fulfill({ contentType: "text/plain", body: original(name) });
      }
    });
    await reference.goto(`${portal.baseUrl}/__reference/index.html`);
    await expect(reference.locator("body")).toHaveAttribute("data-ready", "true");
    const expected = await reference.locator("canvas").first().evaluate((element: HTMLCanvasElement) => element.toDataURL());
    await reference.screenshot({ path: testInfo.outputPath("original-reference.png") });
    await page.screenshot({ path: testInfo.outputPath("local-adaptation.png") });
    expect(actual).toBe(expected);
    await reference.close();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(canvas).toHaveJSProperty("width", 390);
    await expect(canvas).toHaveJSProperty("height", 844);
    await expect(canvas).toHaveAttribute("data-rendered-clock", "0.000000");
  });

  test("direct Hub visits do not request the original sketch chunk", async ({ page }) => {
    const resources: string[] = [];
    page.on("request", (request) => resources.push(request.url()));
    await page.goto(`${portal.baseUrl}/#/hub`);
    await expect(page.getByRole("button", { name: "纳入插件" })).toBeVisible();
    expect(resources.filter((url) => url.includes("CoverAccretionSketch"))).toEqual([]);
    await expect(page.locator("[data-cover-accretion-background]")).toHaveCount(0);
  });

  test("recreates and removes the cover on repeated visits in the same page", async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 768, height: 540 });
    await page.goto(`${portal.baseUrl}/#/hub`);
    for (let visit = 0; visit < 3; visit += 1) {
      await page.evaluate(() => { window.location.hash = "#/"; });
      const start = page.getByRole("button", { name: "Start" });
      await expect(start).toBeEnabled({ timeout: 12_000 });
      await expect(page.locator("[data-cover-accretion-canvas]")).toHaveAttribute("data-render-state", "ready");
      await expect(page.locator("[data-cover-accretion-canvas]")).toHaveCount(1);
      await expect.poll(async () => Number(await page.locator("[data-cover-liquid-glass-canvas]").getAttribute("data-rendered-frame")), { timeout: 12_000 }).toBeGreaterThan(0);
      const bounds = await start.boundingBox();
      expect(bounds).not.toBeNull();
      const started = Date.now();
      await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
      await expect(page.locator("[data-hub-entry-phase]")).toHaveAttribute("data-hub-entry-phase", "hub", { timeout: 3_000 });
      expect(Date.now() - started).toBeLessThan(3_000);
      await expect(page.locator("canvas")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "纳入插件" })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test("times out a delayed module, stays black after its late arrival, and still enters Hub", async ({ page }) => {
    let release: () => void = () => undefined;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/assets/CoverAccretionSketch*.js", async (route) => {
      await delayed;
      await route.continue();
    });
    await page.goto(`${portal.baseUrl}/#/`, { waitUntil: "domcontentloaded" });
    const start = page.getByRole("button", { name: "Start" });
    await expect(start).toBeVisible();
    await expect(start).toBeEnabled();
    await expect(page.locator("[data-cover-liquid-glass-canvas]")).toBeAttached();
    await expect(page.locator("[data-cover-loading-status]")).toHaveCSS("clip-path", "inset(50%)");
    const startBounds = await start.boundingBox();
    expect(startBounds).not.toBeNull();
    expect(await page.evaluate(({ x, y }) => Boolean(
      document.elementFromPoint(x, y)?.closest("[data-cover-liquid-glass-button]"),
    ), {
      x: startBounds!.x + startBounds!.width / 2,
      y: startBounds!.y + startBounds!.height / 2,
    })).toBe(true);
    await expect(page.locator("[data-cover-accretion-background]")).toHaveAttribute("data-render-state", "fallback", { timeout: 12_000 });
    release();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-cover-accretion-background]")).toHaveAttribute("data-render-state", "fallback");
    await expect(page.locator("[data-cover-accretion-background]")).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await start.click();
    await expect(page.locator("[data-hub-entry-phase]")).toHaveAttribute("data-hub-entry-phase", "hub", { timeout: 3_000 });
  });

  test("keeps Start hidden and inactive before the first WebGPU frame, then fades it in", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 540 });
    await page.goto(`${portal.baseUrl}/#/`, { waitUntil: "domcontentloaded" });

    const button = page.locator("[data-cover-liquid-glass-button]");
    await expect(button).toBeAttached();
    await expect(button).toHaveAttribute("data-render-state", "loading");
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("aria-hidden", "true");
    await expect(button).toHaveText("");
    await expect(button).toHaveCSS("visibility", "hidden");
    await expect(button).toHaveCSS("opacity", "0");
    await expect(page.getByRole("button", { name: "Start" })).toHaveCount(0);
    await expect(page.locator("[data-cover-liquid-glass-canvas]")).not.toHaveAttribute("data-fallback-renderer", /.+/);

    await expect(button).toHaveAttribute("data-render-state", "ready", { timeout: 5_000 });
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute("aria-hidden", "true");
    await expect(button).toHaveText("Start");
    await expect(button).toHaveCSS("visibility", "visible");
    await expect(button).toHaveCSS("transition-property", /opacity/);
    await expect.poll(async () => Number.parseFloat(await button.evaluate((element) => getComputedStyle(element).opacity)))
      .toBeGreaterThan(0);
    await expect(button).toHaveCSS("opacity", "1");
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  });

  test("keeps the black center empty when WebGPU is unavailable", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "gpu", { configurable: true, value: undefined });
    });
    await page.setViewportSize({ width: 768, height: 540 });
    await page.goto(`${portal.baseUrl}/#/`);
    const start = page.locator("[data-cover-liquid-glass-button]");
    await expect(start).toHaveAttribute("data-render-state", "failed");
    await expect(start).toBeDisabled();
    await expect(start).toHaveAttribute("aria-hidden", "true");
    await expect(start).toHaveText("");
    await expect(start).toHaveCSS("visibility", "hidden");
    await expect(start).toHaveCSS("opacity", "0");
    await expect(page.getByRole("button", { name: "Start" })).toHaveCount(0);
    const canvas = page.locator("[data-cover-liquid-glass-canvas]");
    await expect(canvas).not.toHaveAttribute("data-fallback-renderer", /.+/);
    await expect(canvas).toHaveAttribute("data-rendered-frame", "0");
    await expect(page.locator("[data-cover-accretion-background]")).toHaveCSS("background-color", "rgb(0, 0, 0)");
  });

  for (let iteration = 1; iteration <= 10; iteration += 1) {
    test(`sequential cover close then Start ${iteration}/10`, async ({ browser }, testInfo) => {
      const warm = await browser.newContext({ viewport: { width: 768, height: 540 } });
      try {
        const previous = await warm.newPage();
        await installMockWebGpu(previous);
        await previous.goto(`${portal.baseUrl}/#/`);
        await expect(previous.locator("[data-cover-accretion-canvas]")).toBeAttached({ timeout: 12_000 });
      } finally { await warm.close(); }
      const current = await browser.newContext({ viewport: { width: 768, height: 540 } });
      try {
        const page = await current.newPage();
        await installMockWebGpu(page);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${portal.baseUrl}/#/`);
        const start = page.getByRole("button", { name: "Start" });
        await expect(start).toBeEnabled({ timeout: 12_000 });
        await expect(page.locator("[data-cover-accretion-canvas]")).toHaveAttribute("data-render-state", "ready");
        await expect.poll(async () => Number(await page.locator("[data-cover-liquid-glass-canvas]").getAttribute("data-rendered-frame")), { timeout: 12_000 }).toBeGreaterThan(0);
        await page.evaluate(() => {
          const root = document.querySelector("[data-hub-entry-phase]")!;
          const phases = ["idle"];
          const input = { trusted: false, clickedAt: 0, completedAt: 0 };
          Object.assign(window, { coverPhases: phases, coverInput: input });
          document.querySelector("[data-cover-liquid-glass-button]")!.addEventListener("click", (event) => {
            input.trusted = event.isTrusted;
            input.clickedAt = performance.now();
          }, { once: true });
          new MutationObserver(() => {
            const next = root.getAttribute("data-hub-entry-phase")!;
            if (phases.at(-1) !== next) phases.push(next);
            if (next === "hub") input.completedAt = performance.now();
          }).observe(root, { attributes: true, attributeFilter: ["data-hub-entry-phase"] });
        });
        const bounds = await start.boundingBox();
        expect(bounds).not.toBeNull();
        const point = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
        expect(await page.evaluate(({ x, y }) => Boolean(
          document.elementFromPoint(x, y)?.closest("[data-cover-liquid-glass-button]"),
        ), point)).toBe(true);
        // Measure actual mouse input, not locator.click's two-animation-frame
        // actionability wait during an outstanding GPU pipeline compilation.
        // The existing locator-based click-to-Hub gate remains in portal.spec.
        const started = Date.now();
        await page.mouse.click(point.x, point.y);
        await expect(page.locator("[data-hub-entry-phase]")).toHaveAttribute("data-hub-entry-phase", "hub", { timeout: 3_000 });
        const elapsed = Date.now() - started;
        expect(elapsed).toBeLessThan(3_000);
        const phases = await page.evaluate(() => (window as unknown as { coverPhases: string[] }).coverPhases);
        const input = await page.evaluate(() => (window as unknown as {
          coverInput: { trusted: boolean; clickedAt: number; completedAt: number };
        }).coverInput);
        expect(input.trusted).toBe(true);
        expect(input.completedAt - input.clickedAt).toBeGreaterThan(0);
        expect(input.completedAt - input.clickedAt).toBeLessThan(3_000);
        expect(phases).toEqual(["idle", "engulfing", "revealing", "hub"]);
        expect(errors).toEqual([]);
        await testInfo.attach("transition", { body: JSON.stringify({ iteration, elapsed, input, phases }), contentType: "application/json" });
        await expect(page.locator("[data-cover-accretion-canvas]")).toHaveCount(0);
      } finally { await current.close(); }
    });
  }
});
