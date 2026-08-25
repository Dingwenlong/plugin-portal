import { describe, expect, test } from "vitest";
import {
  COVER_ACCRETION_FIELD_FRAGMENT_SHADER,
  COVER_ACCRETION_FIELD_PROVENANCE,
  COVER_ACCRETION_FIELD_VERTEX_SHADER,
} from "./CoverAccretionFieldShader";

describe("clean-room cover accretion field", () => {
  test("removes the legacy shader module from the runtime source", () => {
    expect(import.meta.glob("./CoverAccretionShader.ts")).toEqual({});
  });

  test("uses an independent local shader contract", () => {
    const source = `${COVER_ACCRETION_FIELD_VERTEX_SHADER}\n${COVER_ACCRETION_FIELD_FRAGMENT_SHADER}`;

    expect(COVER_ACCRETION_FIELD_PROVENANCE).toEqual({
      designId: "pdh-cover-accretion-field-v1",
      origin: "clean-room",
    });
    expect(COVER_ACCRETION_FIELD_VERTEX_SHADER).toContain("aViewportCorner");
    expect(COVER_ACCRETION_FIELD_FRAGMENT_SHADER).toContain("uViewport");
    expect(COVER_ACCRETION_FIELD_FRAGMENT_SHADER).toContain("uClock");
    expect(COVER_ACCRETION_FIELD_FRAGMENT_SHADER).toContain("pdhFieldCell");
    expect(COVER_ACCRETION_FIELD_FRAGMENT_SHADER).toContain("pdhFlowRibbon");
    expect(COVER_ACCRETION_FIELD_FRAGMENT_SHADER).toContain("pdhFieldPalette");

    for (const forbidden of [
      "XorDev",
      "OpenProcessing",
      "CC BY-NC-SA",
      "http://",
      "https://",
      "iResolution",
      "iTime",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
