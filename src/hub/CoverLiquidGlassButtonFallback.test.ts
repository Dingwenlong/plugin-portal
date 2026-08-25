import { describe, expect, it } from "vitest";
import {
  coverLiquidGlassBackingSize,
  coverLiquidGlassFallbackFrame,
} from "./CoverLiquidGlassButtonFallback";

describe("cover liquid glass button Canvas 2D fallback", () => {
  it("normalizes invalid time and returns finite deterministic frame values", () => {
    const initial = coverLiquidGlassFallbackFrame(0);

    expect(coverLiquidGlassFallbackFrame(Number.NaN)).toEqual(initial);
    expect(coverLiquidGlassFallbackFrame(Number.POSITIVE_INFINITY)).toEqual(initial);
    expect(coverLiquidGlassFallbackFrame(-1)).toEqual(initial);
    expect(coverLiquidGlassFallbackFrame(0)).toEqual(initial);
    expect(Object.values(coverLiquidGlassFallbackFrame(1)).every(Number.isFinite)).toBe(true);
  });

  it("moves the local highlights as time advances", () => {
    expect(coverLiquidGlassFallbackFrame(0.5)).not.toEqual(
      coverLiquidGlassFallbackFrame(0),
    );
  });

  it("keeps backing resolution bound to the 112px layout box during CSS engulf scaling", () => {
    expect(coverLiquidGlassBackingSize({
      clientWidth: 112,
      clientHeight: 112,
      transformedWidth: 1900,
      transformedHeight: 1000,
      devicePixelRatio: 2,
    })).toEqual({ width: 224, height: 224 });
  });
});
