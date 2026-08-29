import { describe, expect, it } from "vitest";

import { MAX_PRESENTATION_TEXTURE_SIZE, resolveOrbPresentationSize } from "./orb-renderer";

describe("orb presentation sizing", () => {
  it("raises the backing resolution for the CSS presentation scale", () => {
    expect(resolveOrbPresentationSize({
      clientWidth: 112,
      clientHeight: 112,
      devicePixelRatio: 2,
      presentationScale: 8,
      deviceMaximum: 8192,
    })).toEqual({ width: 1792, height: 1792 });
  });

  it("caps the backing resolution by both the renderer and device limits", () => {
    expect(MAX_PRESENTATION_TEXTURE_SIZE).toBe(4096);
    expect(resolveOrbPresentationSize({
      clientWidth: 112,
      clientHeight: 112,
      devicePixelRatio: 3,
      presentationScale: 40,
      deviceMaximum: 8192,
    })).toEqual({ width: 4096, height: 4096 });
    expect(resolveOrbPresentationSize({
      clientWidth: 112,
      clientHeight: 112,
      devicePixelRatio: 2,
      presentationScale: 40,
      deviceMaximum: 2048,
    })).toEqual({ width: 2048, height: 2048 });
  });

  it("normalizes invalid values without shrinking below the idle Canvas", () => {
    expect(resolveOrbPresentationSize({
      clientWidth: 112,
      clientHeight: 112,
      devicePixelRatio: Number.NaN,
      presentationScale: -4,
      deviceMaximum: 4096,
    })).toEqual({ width: 112, height: 112 });
  });
});
