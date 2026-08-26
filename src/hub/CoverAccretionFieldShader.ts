export const COVER_ACCRETION_FIELD_PROVENANCE = Object.freeze({
  author: "XorDev",
  license: "CC BY-NC-SA 4.0",
  sourceUrl: "https://x.com/XorDev/status/1897669357934608590",
  adaptation: "WebGL 1 uniform and output integration for Plugin Portal",
} as const);

export const COVER_ACCRETION_FIELD_VERTEX_SHADER = `
attribute vec2 aViewportCorner;

void main() {
  gl_Position = vec4(aViewportCorner, 0.0, 1.0);
}
`;

// Adapted from XorDev's 350-character Blackhole shader. The mathematical
// expression is kept recognizable; only host uniforms, initialization and
// WebGL 1 output wiring are expanded for this component.
export const COVER_ACCRETION_FIELD_FRAGMENT_SHADER = `
precision highp float;

uniform vec2 uViewport;
uniform float uClock;

vec4 xorBlackHole(vec2 fragmentCoordinate, vec2 viewport, float clock) {
  vec2 point = (fragmentCoordinate * 2.0 - viewport) / viewport.y / 0.7;
  vec2 diagonal = vec2(-1.0, 1.0);
  vec2 shifted = 5.0 * point - diagonal;
  vec2 bend = diagonal / (0.1 + 5.0 / dot(shifted, shifted));
  vec2 warped = point * mat2(1.0, 1.0, bend.x, bend.y);
  vec2 flow = warped;
  float safeRadius = max(length(flow), 0.0001);
  flow = flow * mat2(cos(log(safeRadius) + clock * 0.2 + vec4(0.0, 33.0, 11.0, 0.0))) * 5.0;

  vec4 radiance = vec4(0.0);
  for (float index = 1.0; index <= 9.0; index += 1.0) {
    flow += 0.7 * sin(flow.yx * index + clock) / index + 0.5;
    radiance += sin(flow.xyyx) + 1.0;
  }

  vec4 spectrum = exp(warped.x * vec4(0.6, -0.4, -1.0, 0.0));
  float filament = 0.1 + 0.1 * pow(
    length(sin(flow / 0.3) * 0.2 + warped * vec2(1.0, 2.0)) - 1.0,
    2.0
  );
  float horizon = 0.03 + abs(length(point) - 0.7);
  float shadow = 1.0 + 7.0 * exp(0.3 * warped.y - dot(warped, warped));
  return 1.0 - exp(-spectrum / radiance / filament / shadow / horizon * 0.2);
}

void main() {
  vec2 viewport = max(uViewport, vec2(1.0));
  vec4 color = xorBlackHole(gl_FragCoord.xy, viewport, uClock);
  gl_FragColor = vec4(color.rgb, 1.0);
}
`;
