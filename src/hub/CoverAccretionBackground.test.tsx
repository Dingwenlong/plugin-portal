import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COVER_ACCRETION_FRAME_INTERVAL_MS,
  CoverAccretionBackground,
  coverAccretionBackingSize,
} from "./CoverAccretionBackground";

afterEach(() => vi.restoreAllMocks());

function coverWebGlContext() {
  return {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLES: 8,
    createShader: () => ({}),
    shaderSource: () => undefined,
    compileShader: () => undefined,
    getShaderParameter: () => true,
    deleteShader: () => undefined,
    createProgram: () => ({}),
    attachShader: () => undefined,
    linkProgram: () => undefined,
    getProgramParameter: () => true,
    deleteProgram: () => undefined,
    createBuffer: () => ({}),
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    bindBuffer: () => undefined,
    bufferData: () => undefined,
    useProgram: () => undefined,
    enableVertexAttribArray: () => undefined,
    vertexAttribPointer: () => undefined,
    viewport: () => undefined,
    uniform2f: () => undefined,
    uniform1f: () => undefined,
    drawArrays: () => undefined,
    deleteBuffer: () => undefined,
  } as unknown as WebGLRenderingContext;
}

describe("cover accretion render budget", () => {
  it("caps a full-HD cover to a low-cost backing surface", () => {
    expect(coverAccretionBackingSize(1912, 948)).toEqual({ width: 960, height: 476 });
    expect(coverAccretionBackingSize(768, 1024)).toEqual({ width: 405, height: 540 });
  });

  it("limits the ambient shader to 24 frames per second", () => {
    expect(COVER_ACCRETION_FRAME_INTERVAL_MS).toBeCloseTo(1000 / 24);
  });

  it("reports readiness only after the WebGL background draws its first frame", () => {
    const gl = coverWebGlContext();
    let scheduledFrame: FrameRequestCallback | undefined;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(gl);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      scheduledFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const onReady = vi.fn();

    const { container } = render(<CoverAccretionBackground onReady={onReady} />);

    expect(onReady).not.toHaveBeenCalled();
    expect(container.querySelector("canvas")).toHaveAttribute("data-render-state", "loading");

    act(() => scheduledFrame?.(16));

    expect(container.querySelector("canvas")).toHaveAttribute("data-render-state", "ready");
    expect(container.querySelector("canvas")).toHaveAttribute("data-rendered-frame", "1");
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("releases the cover when WebGL falls back to the static background", () => {
    const onReady = vi.fn();

    const { container } = render(<CoverAccretionBackground onReady={onReady} />);

    expect(container.querySelector("canvas")).toHaveAttribute("data-render-state", "fallback");
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
