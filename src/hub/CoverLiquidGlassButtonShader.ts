import effectSource from "./CoverLiquidGlassButtonEffect.wgsl?raw";

const capsuleVertexAndFragment = /* wgsl */ `
struct CoverGlassVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn coverGlassVertex(@builtin(vertex_index) index: u32) -> CoverGlassVertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var output: CoverGlassVertexOutput;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  let uv01 = (positions[index] + vec2<f32>(1.0)) * 0.5;
  output.uv = vec2<f32>(uv01.x, 1.0 - uv01.y);
  return output;
}

fn coverGlassCapsuleRayBoundary(direction: vec2<f32>, halfBody: f32) -> f32 {
  let absoluteDirection = abs(direction);
  let lineDistance = 1.0 / max(absoluteDirection.y, 0.0001);
  if (lineDistance * absoluteDirection.x <= halfBody) {
    return lineDistance;
  }
  return halfBody * absoluteDirection.x
    + sqrt(max(1.0 - halfBody * halfBody * absoluteDirection.y * absoluteDirection.y, 0.0));
}

fn coverGlassCapsuleToDisc(position: vec2<f32>, halfBody: f32) -> vec2<f32> {
  let distance = length(position);
  if (distance <= 0.0001) {
    return vec2<f32>(0.0);
  }
  let direction = position / distance;
  let boundary = coverGlassCapsuleRayBoundary(direction, halfBody);
  return direction * (distance / max(boundary, 0.0001));
}

fn coverGlassMapCapsulePointToOrbUv(
  position: vec2<f32>,
  aspect: f32,
  capsuleRadius: f32,
  halfBody: f32,
  orbRadius: f32,
) -> vec2<f32> {
  let discPosition = coverGlassCapsuleToDisc(
    position / capsuleRadius,
    halfBody / capsuleRadius,
  );
  return vec2<f32>(
    0.5 + discPosition.x * orbRadius / (2.0 * aspect),
    0.5 - discPosition.y * orbRadius * 0.5,
  );
}

@fragment
fn coverGlassFragment(input: CoverGlassVertexOutput) -> @location(0) vec4<f32> {
  let height = max(u.size.y, 1.0);
  let aspect = max(u.size.x / height, 1.0);
  let position = vec2<f32>(
    (input.uv.x * 2.0 - 1.0) * aspect,
    1.0 - input.uv.y * 2.0,
  );

  // Keep a two-pixel optical margin while preserving circular end caps.
  let capsuleRadius = 0.92;
  let halfBody = max(aspect - 0.08 - capsuleRadius, 0.0);
  let discPosition = coverGlassCapsuleToDisc(
    position / capsuleRadius,
    halfBody / capsuleRadius,
  );

  // Feed the capsule-mapped point into the original orb domain. The reference
  // fluid, refraction, dispersion, shell and highlight equations stay intact.
  let orbRadius = max(u.radius, 0.05);
  let mappedOrbUv = coverGlassMapCapsulePointToOrbUv(
    position,
    aspect,
    capsuleRadius,
    halfBody,
    orbRadius,
  );
  var color = orbGlassLiquidAnim(mappedOrbUv);

  // The original radial mapping occasionally exposes a one-pixel fold at the
  // capsule axis. Reconstruct that narrow strip from its two stable boundaries
  // so there is no fixed average-color band; everything outside stays original.
  let centerSeamPixelSize = 2.0 / height;
  let centerSeamHalfWidth = centerSeamPixelSize * 5.0;
  if (abs(position.x) < centerSeamHalfWidth) {
    let centerSeamLeftBoundaryUv = coverGlassMapCapsulePointToOrbUv(
      vec2<f32>(-centerSeamHalfWidth, position.y),
      aspect,
      capsuleRadius,
      halfBody,
      orbRadius,
    );
    let centerSeamRightBoundaryUv = coverGlassMapCapsulePointToOrbUv(
      vec2<f32>(centerSeamHalfWidth, position.y),
      aspect,
      capsuleRadius,
      halfBody,
      orbRadius,
    );
    let centerSeamLeftBoundaryColor = orbGlassLiquidAnim(centerSeamLeftBoundaryUv);
    let centerSeamRightBoundaryColor = orbGlassLiquidAnim(centerSeamRightBoundaryUv);
    let centerSeamCrossfade = smoothstep(-centerSeamHalfWidth, centerSeamHalfWidth, position.x);
    color = mix(centerSeamLeftBoundaryColor, centerSeamRightBoundaryColor, centerSeamCrossfade);
  }

  let edgeFeather = 2.0 / max(height * capsuleRadius, 1.0);
  let capsuleAlpha = 1.0 - smoothstep(
    1.0 - edgeFeather,
    1.0 + edgeFeather,
    length(discPosition),
  );
  return vec4<f32>(color.rgb * capsuleAlpha, capsuleAlpha);
}
`;

export const COVER_LIQUID_GLASS_BUTTON_SHADER = `${effectSource}\n${capsuleVertexAndFragment}`;
