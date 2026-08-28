import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  COVER_ACCRETION_FIELD_FRAGMENT_SHADER,
  COVER_ACCRETION_FIELD_PROVENANCE,
  COVER_ACCRETION_FIELD_VERTEX_SHADER,
} from "./CoverAccretionFieldShader";

describe("original Accretion source", () => {
  test("keeps the original attribution and shader uniforms", () => {
    expect(COVER_ACCRETION_FIELD_PROVENANCE).toEqual({
      author: "jcponcemath",
      license: "CC BY-NC-SA 3.0",
      sourceUrl: "https://openprocessing.org/@jcponcemath/2696126",
      adaptation: "Local p5.js instance lifecycle for Plugin Portal",
    });
    expect(COVER_ACCRETION_FIELD_VERTEX_SHADER).toContain("attribute vec3 aPosition");
    expect(COVER_ACCRETION_FIELD_FRAGMENT_SHADER).toContain('Original code "Accretion" by @XorDev');
    for (const source of ["iResolution", "iTime", "MAX_STEPS = 20", "NOISE_ITERATIONS = 7", "vec4(6.0, 1.0, 9.0, 0.0)"]) {
      expect(COVER_ACCRETION_FIELD_FRAGMENT_SHADER).toContain(source);
    }
  });

  test("binds both runtime shaders to the retained source files and checksums", () => {
    const manifest = JSON.parse(readFileSync("src/hub/accretion-original/source.json", "utf8")) as {
      sha256: Record<string, string>;
    };
    for (const [file, expected] of Object.entries(manifest.sha256)) {
      const text = readFileSync("src/hub/accretion-original/" + file, "utf8").replace(/\r\n/g, "\n");
      expect(createHash("sha256").update(text).digest("hex"), file).toBe(expected);
      if (file === "vertex.glsl") expect(COVER_ACCRETION_FIELD_VERTEX_SHADER.replace(/\r\n/g, "\n")).toBe(text);
      if (file === "fragment.glsl") expect(COVER_ACCRETION_FIELD_FRAGMENT_SHADER.replace(/\r\n/g, "\n")).toBe(text);
    }
  });

  test("pins p5, keeps the adapter separate, and removes rendering caps", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies.p5).toBe("1.11.8");
    const adapter = readFileSync("src/hub/CoverAccretionSketch.ts", "utf8");
    expect(adapter).toContain("instance.millis() / 1000.0");
    expect(adapter).toContain("p.pixelDensity(1)");
    expect(adapter).not.toMatch(/frameRate\(|1000\s*\/\s*24|960|540|loadShader\(|https?:/);
    const wrapper = readFileSync("src/hub/CoverAccretionBackground.tsx", "utf8");
    expect(wrapper).toContain('import("./CoverAccretionSketch")');
    expect(wrapper).not.toContain('from "p5"');
  });
});
