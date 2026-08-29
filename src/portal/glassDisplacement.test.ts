import { describe, expect, it, vi } from "vitest";

import { createDisplacementPixels, createGlassMapCache } from "./glassDisplacement";

describe("capsule displacement map", () => {
  it("leaves the reading area neutral and bends opposite edges in opposite directions", () => {
    const { pixels, width, height } = createDisplacementPixels(300, 64);
    const at = (x: number, y: number) => Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
    expect([width, height]).toEqual([300, 64]);
    expect(at(150, 32)).toEqual([128, 128, 128, 255]);
    expect(at(150, 2)[1]).toBeLessThan(128);
    expect(at(150, 61)[1]).toBeGreaterThan(128);
    expect(at(2, 32)[0]).toBeLessThan(128);
    expect(at(297, 32)[0]).toBeGreaterThan(128);
  });

  it("rejects invalid or excessive canvas allocation", () => {
    for (const size of [[0, 64], [300, 0], [NaN, 64], [5000, 64], [300, 1024]]) {
      expect(() => createDisplacementPixels(...size as [number, number])).toThrow();
    }
  });

  it("reuses maps for the same size and bounds the cache across resizing", () => {
    const encode = vi.fn((width: number, height: number) => `${width}x${height}`);
    const cache = createGlassMapCache(encode, 2);
    expect(cache.get(300, 64)).toBe("300x64");
    expect(cache.get(300, 64)).toBe("300x64");
    expect(encode).toHaveBeenCalledTimes(1);
    cache.get(400, 64);
    cache.get(500, 64);
    cache.get(300, 64);
    expect(encode).toHaveBeenCalledTimes(4);
  });
});
