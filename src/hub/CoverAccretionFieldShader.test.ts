import { describe, expect, test } from "vitest";
import {
  COVER_ACCRETION_FIELD_FRAGMENT_SHADER,
  COVER_ACCRETION_FIELD_PROVENANCE,
  COVER_ACCRETION_FIELD_VERTEX_SHADER,
} from "./CoverAccretionFieldShader";

describe("network-sourced cover accretion field", () => {
  test("removes the legacy shader module from the runtime source", () => {
    expect(import.meta.glob("./CoverAccretionShader.ts")).toEqual({});
  });

  test("keeps the attributed XorDev black-hole shader contract local", () => {
    const source = `${COVER_ACCRETION_FIELD_VERTEX_SHADER}\n${COVER_ACCRETION_FIELD_FRAGMENT_SHADER}`;

    expect(COVER_ACCRETION_FIELD_PROVENANCE).toEqual({
      author: "XorDev",
      license: "CC BY-NC-SA 4.0",
      sourceUrl: "https://x.com/XorDev/status/1897669357934608590",
      adaptation: "WebGL 1 uniform and output integration for Plugin Portal",
    });
    expect(COVER_ACCRETION_FIELD_VERTEX_SHADER).toContain("aViewportCorner");
    expect(COVER_ACCRETION_FIELD_FRAGMENT_SHADER).toContain("uViewport");
    expect(COVER_ACCRETION_FIELD_FRAGMENT_SHADER).toContain("uClock");
    expect(COVER_ACCRETION_FIELD_FRAGMENT_SHADER).toContain("xorBlackHole");
    expect(COVER_ACCRETION_FIELD_FRAGMENT_SHADER).toContain("length(point) - 0.7");

    for (const forbidden of [
      "OpenProcessing",
      "http://",
      "https://",
      "iResolution",
      "iTime",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
