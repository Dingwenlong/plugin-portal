import { describe, expect, it } from "vitest";

import { parsePortalRoute, portalHref } from "./routes";

const pluginIds = ["project-delivery-hub", "yusheng-inc"];

describe("parsePortalRoute", () => {
  it("parses a known plugin and page", () => {
    expect(parsePortalRoute("#/plugins/yusheng-inc/prompts", pluginIds)).toEqual({
      pluginId: "yusheng-inc",
      page: "prompts",
    });
  });

  it("normalizes an unknown page to the plugin overview", () => {
    expect(parsePortalRoute("#/plugins/project-delivery-hub/unknown", pluginIds)).toEqual({
      pluginId: "project-delivery-hub",
      page: "overview",
    });
  });

  it("uses the first included plugin for an unknown plugin", () => {
    expect(parsePortalRoute("#/plugins/not-included/skills", pluginIds)).toEqual({
      pluginId: "project-delivery-hub",
      page: "overview",
    });
  });

  it("builds a stable plugin-scoped URL", () => {
    expect(portalHref("yusheng-inc", "rules")).toBe("#/plugins/yusheng-inc/rules");
  });
});
