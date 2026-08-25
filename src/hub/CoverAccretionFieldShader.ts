export const COVER_ACCRETION_FIELD_PROVENANCE = Object.freeze({
  designId: "pdh-cover-accretion-field-v1",
  origin: "clean-room",
} as const);

export const COVER_ACCRETION_FIELD_VERTEX_SHADER = `
attribute vec2 aViewportCorner;

void main() {
  gl_Position = vec4(aViewportCorner, 0.0, 1.0);
}
`;
export const COVER_ACCRETION_FIELD_FRAGMENT_SHADER = `
precision mediump float;

uniform vec2 uViewport;
uniform float uClock;

const float PDH_TAU = 6.28318530718;

float pdhFieldHash(vec2 cell) {
  vec2 wrapped = mod(cell, vec2(127.0, 131.0));
  float folded = mod(
    wrapped.x * wrapped.x * 17.0
      + wrapped.y * wrapped.y * 59.0
      + wrapped.x * wrapped.y * 23.0,
    113.0
  );
  return fract(folded / 17.0);
}

float pdhFieldCell(vec2 point) {
  vec2 anchor = floor(point);
  vec2 local = fract(point);
  vec2 blend = local * local * (3.0 - 2.0 * local);
  float lower = mix(
    pdhFieldHash(anchor),
    pdhFieldHash(anchor + vec2(1.0, 0.0)),
    blend.x
  );
  float upper = mix(
    pdhFieldHash(anchor + vec2(0.0, 1.0)),
    pdhFieldHash(anchor + vec2(1.0, 1.0)),
    blend.x
  );
  return mix(lower, upper, blend.y);
}

float pdhFlowRibbon(float signedDistance, float phase, float focus) {
  float profile = exp(-abs(signedDistance) * focus);
  float pulse = 0.62 + 0.38 * cos(phase);
  return profile * pulse;
}

vec3 pdhFieldPalette(float position) {
  vec3 cyan = vec3(0.08, 0.72, 0.82);
  vec3 blue = vec3(0.16, 0.31, 0.94);
  vec3 violet = vec3(0.62, 0.20, 0.88);
  vec3 amber = vec3(0.96, 0.58, 0.16);
  float band = fract(position) * 4.0;

  if (band < 1.0) return mix(cyan, blue, band);
  if (band < 2.0) return mix(blue, violet, band - 1.0);
  if (band < 3.0) return mix(violet, amber, band - 2.0);
  return mix(amber, cyan, band - 3.0);
}

void main() {
  vec2 viewport = max(uViewport, vec2(1.0));
  vec2 point = (2.0 * gl_FragCoord.xy - viewport) / viewport.y;
  float clock = uClock * 0.18;
  float radius = length(point);
  float angle = atan(point.y, point.x);

  float broadField = pdhFieldCell(point * 2.8 + vec2(clock * 0.13, -clock * 0.09));
  float orbitField = pdhFieldCell(
    vec2(angle * 1.2, radius * 7.0) + vec2(-clock * 0.07, clock * 0.11)
  );
  float warp = (broadField - 0.5) * 0.16 + (orbitField - 0.5) * 0.09;
  float orbit = 0.52 + 0.04 * sin(angle * 3.0 - clock * 0.42) + warp;
  float spiral = angle * 4.0 - radius * 13.0 + clock * 0.65 + (orbitField - 0.5) * 1.8;

  float innerRibbon = pdhFlowRibbon(
    radius - orbit + sin(spiral) * 0.025,
    spiral * 1.7,
    12.0
  );
  float outerRibbon = pdhFlowRibbon(
    radius - orbit - 0.18 + cos(spiral * 0.83) * 0.04,
    spiral - 1.3,
    8.0
  );
  float innerThread = pdhFlowRibbon(
    radius - orbit + 0.14 + sin(spiral * 1.24) * 0.018,
    spiral + 2.1,
    16.0
  );

  float wingCurve = point.y - 0.08 * sin(
    point.x * 4.5 - clock * 0.33 + broadField * 1.1
  );
  float wingGate = smoothstep(0.28, 0.50, abs(point.x))
    * (1.0 - smoothstep(1.02, 1.84, abs(point.x)));
  float broadWing = exp(-abs(wingCurve) * 4.2) * wingGate;
  float wingThread = exp(-abs(wingCurve + sin(spiral) * 0.055) * 13.0)
    * wingGate;

  float energy = innerRibbon * 0.92
    + outerRibbon * 0.52
    + innerThread * 0.38
    + broadWing * 0.72
    + wingThread * 0.46;
  float cadence = 0.66 + 0.34 * cos(spiral * 0.67 + broadField * 2.0);
  energy *= cadence;

  float palettePosition = angle / PDH_TAU
    + radius * 0.23
    + orbitField * 0.34
    + clock * 0.025;
  vec3 radiance = pdhFieldPalette(palettePosition) * energy * 0.82;

  float lensRim = exp(-abs(radius - 0.39) * 22.0);
  radiance += mix(
    vec3(0.12, 0.54, 0.78),
    vec3(0.82, 0.38, 0.72),
    0.5 + 0.5 * sin(angle * 2.0 + clock * 0.21)
  ) * lensRim * 0.38;

  float darkCore = 1.0 - smoothstep(0.24, 0.39, radius);
  float frameFade = 1.0 - smoothstep(
    1.24,
    2.02,
    length(vec2(point.x * 0.58, point.y))
  );
  vec3 base = vec3(0.004, 0.008, 0.016);
  vec3 color = base + radiance * frameFade;
  color = mix(color, base * 0.34, darkCore * 0.98);
  color *= 0.96 - 0.10 * smoothstep(-1.70, -0.28, -point.x);

  gl_FragColor = vec4(color, 1.0);
}
`;
