import { describe, expect, it } from "vitest";

import {
  COVER_ACCRETION_FRAME_INTERVAL_MS,
  coverAccretionBackingSize,
} from "./CoverAccretionBackground";

describe("cover accretion render budget", () => {
  it("caps a full-HD cover to a low-cost backing surface", () => {
    expect(coverAccretionBackingSize(1912, 948)).toEqual({ width: 960, height: 476 });
    expect(coverAccretionBackingSize(768, 1024)).toEqual({ width: 405, height: 540 });
  });

  it("limits the ambient shader to 24 frames per second", () => {
    expect(COVER_ACCRETION_FRAME_INTERVAL_MS).toBeCloseTo(1000 / 24);
  });
});
