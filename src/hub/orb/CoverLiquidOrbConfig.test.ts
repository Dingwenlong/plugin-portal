import { describe, expect, it } from "vitest";
import {
  COVER_LIQUID_ORB_SOURCE,
  COVER_LIQUID_ORB_TARGET,
} from "./CoverLiquidOrbConfig";

describe("cover liquid orb configuration", () => {
  it("pins the requested upstream source and particle ribbon preset", () => {
    expect(COVER_LIQUID_ORB_SOURCE).toEqual({
      repository: "https://github.com/LerSent001/orb",
      commit: "047c58cc93587c21dac12183fc0fb1e4101c8e1a",
      license: "MIT",
    });
    expect(COVER_LIQUID_ORB_TARGET).toMatchObject({
      state: "thinking",
      activationDuration: 0.22,
      transitionDuration: 0.65,
      params: {
        style: "particleRibbon",
        glassEnabled: true,
        speed: 0.72,
        radius: 0.66,
        particleDensity: 1,
        ribbonCount: 4,
        ribbonWidth: 0.48,
        ribbonTwist: 1.15,
        ribbonFold: 0.6,
        ribbonBreath: 0.38,
        particleSize: 1.12,
        particleBloom: 1.22,
        canvasColor: "#010208",
      },
    });
  });
});
