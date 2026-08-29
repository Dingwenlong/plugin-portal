import {
  createOrbStateConfiguration,
  resolveOrbStateParams,
  type OrbRenderTarget,
} from "./upstream/orb-states";
import { stylePresets, type OrbParams } from "./upstream/presets";

export const COVER_LIQUID_ORB_SOURCE = {
  repository: "https://github.com/LerSent001/orb",
  commit: "047c58cc93587c21dac12183fc0fb1e4101c8e1a",
  license: "MIT",
} as const;

const thinkingParams: OrbParams = {
  style: "particleRibbon",
  ...stylePresets.particleRibbon,
};
const stateConfiguration = createOrbStateConfiguration(thinkingParams, 0.65, 0.22);

export const COVER_LIQUID_ORB_TARGET: OrbRenderTarget = {
  state: "thinking",
  params: resolveOrbStateParams(stateConfiguration, "thinking"),
  activationDuration: stateConfiguration.activationDuration,
  transitionDuration: stateConfiguration.transitionDuration,
};

export const COVER_LIQUID_ORB_STATIC_TARGET: OrbRenderTarget = {
  ...COVER_LIQUID_ORB_TARGET,
  params: { ...COVER_LIQUID_ORB_TARGET.params, speed: 0 },
};
