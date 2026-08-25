import { describe, expect, it } from "vitest";
import { createCurrentCoverLiquidGlassPipeline } from "./CoverLiquidGlassButton";
import * as shaderModule from "./CoverLiquidGlassButtonShader";

describe("cover liquid glass button shader", () => {
  it("keeps the accepted original orb mapping inside the capsule", () => {
    const shader = shaderModule.COVER_LIQUID_GLASS_BUTTON_SHADER;

    expect(shader).toContain("coverGlassCapsuleToDisc");
    expect(shader).toContain("fn coverGlassFragment");
    expect(shader).not.toContain("coverGlassAxialMaterial");
    expect(shader).not.toContain("coverGlassPerimeterMaterial");
    expect(shader).not.toContain("coverGlassMultiCenterMaterial");
  });

  it("reconstructs the narrow center seam as a continuous cross-axis field", () => {
    const shader = shaderModule.COVER_LIQUID_GLASS_BUTTON_SHADER;

    expect(shader).toContain("coverGlassMapCapsulePointToOrbUv");
    expect(shader).toContain("centerSeamHalfWidth");
    expect(shader).toContain("centerSeamLeftBoundaryColor");
    expect(shader).toContain("centerSeamRightBoundaryColor");
    expect(shader).toContain("centerSeamCrossfade");
    expect(shader).toContain(
      "smoothstep(-centerSeamHalfWidth, centerSeamHalfWidth, position.x)",
    );
    expect(shader).toContain(
      "mix(centerSeamLeftBoundaryColor, centerSeamRightBoundaryColor, centerSeamCrossfade)",
    );
    expect(shader).not.toContain("mix(leftSeamColor, rightSeamColor, 0.5)");
  });
});
describe("cover liquid glass button pipeline initialization", () => {
  it("uses only the asynchronous WebGPU pipeline API", async () => {
    const pipeline = { getBindGroupLayout: () => ({}) };
    let asyncCalls = 0;
    const device = {
      createRenderPipelineAsync: async () => {
        asyncCalls += 1;
        return pipeline;
      },
    };

    await expect(createCurrentCoverLiquidGlassPipeline(device, {}, () => true)).resolves.toBe(pipeline);
    expect(asyncCalls).toBe(1);
  });

  it("fails closed when asynchronous pipeline creation is unavailable", async () => {
    await expect(createCurrentCoverLiquidGlassPipeline({}, {}, () => true))
      .rejects.toThrow("Asynchronous WebGPU pipeline creation is unavailable.");
  });

  it("passes an asynchronous pipeline rejection to the existing fallback path", async () => {
    const failure = new Error("pipeline rejected");
    const device = { createRenderPipelineAsync: async () => { throw failure; } };

    await expect(createCurrentCoverLiquidGlassPipeline(device, {}, () => true)).rejects.toBe(failure);
  });

  it("fails into the existing fallback path when a late pipeline resolves for an inactive renderer", async () => {
    const pipeline = { getBindGroupLayout: () => ({}) };
    let resolvePipeline: ((value: typeof pipeline) => void) | undefined;
    const pending = new Promise<typeof pipeline>((resolve) => { resolvePipeline = resolve; });
    const device = { createRenderPipelineAsync: () => pending };
    let current = true;
    const result = createCurrentCoverLiquidGlassPipeline(device, {}, () => current);

    current = false;
    resolvePipeline?.(pipeline);

    await expect(result).rejects.toThrow("The WebGPU renderer is no longer current.");
  });
});
