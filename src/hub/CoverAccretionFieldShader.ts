import vertex from "./accretion-original/vertex.glsl?raw";
import fragment from "./accretion-original/fragment.glsl?raw";

export const COVER_ACCRETION_FIELD_PROVENANCE = Object.freeze({
  author: "jcponcemath",
  license: "CC BY-NC-SA 3.0",
  sourceUrl: "https://openprocessing.org/@jcponcemath/2696126",
  adaptation: "Local p5.js instance lifecycle for Plugin Portal",
} as const);

export const COVER_ACCRETION_FIELD_VERTEX_SHADER = vertex;
export const COVER_ACCRETION_FIELD_FRAGMENT_SHADER = fragment;
