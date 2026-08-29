import type { BrowserContext, Page } from "@playwright/test";

type InitScriptTarget = Pick<Page, "addInitScript"> | Pick<BrowserContext, "addInitScript">;

export async function installMockWebGpu(target: InitScriptTarget, deviceDelayMs = 0) {
  await target.addInitScript((delayMs) => {
    const noop = () => undefined;
    const renderPass = {
      draw: noop,
      end: noop,
      setBindGroup: noop,
      setPipeline: noop,
    };
    const createDevice = () => {
      let submissions = 0;
      return {
        addEventListener: noop,
        createBindGroup: () => ({}),
        createBuffer: () => ({}),
        createCommandEncoder: () => ({
          beginRenderPass: () => renderPass,
          finish: () => ({}),
        }),
        createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
        createSampler: () => ({}),
        createShaderModule: () => ({
          getCompilationInfo: async () => ({ messages: [] }),
        }),
        createTexture: () => ({ createView: () => ({}), destroy: noop }),
        destroy: noop,
        lost: new Promise(() => undefined),
        queue: {
          submit: () => {
            submissions += 1;
            if (submissions > 1) throw new Error("Mock WebGPU completed its first frame.");
          },
          writeBuffer: noop,
        },
      };
    };
    const gpu = {
      getPreferredCanvasFormat: () => "bgra8unorm",
      requestAdapter: async () => ({
        requestDevice: async () => {
          if (delayMs > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, delayMs));
          }
          return createDevice();
        },
      }),
    };
    Object.defineProperty(navigator, "gpu", { configurable: true, value: gpu });
    Object.defineProperty(globalThis, "GPUBufferUsage", {
      configurable: true,
      value: { COPY_DST: 1, UNIFORM: 2 },
    });
    Object.defineProperty(globalThis, "GPUTextureUsage", {
      configurable: true,
      value: { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 },
    });

    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (contextId: string, ...args: unknown[]) {
      if (contextId === "webgpu") {
        return {
          configure: noop,
          getCurrentTexture: () => ({ createView: () => ({}) }),
        };
      }
      return Reflect.apply(getContext, this, [contextId, ...args]);
    } as typeof HTMLCanvasElement.prototype.getContext;
  }, deviceDelayMs);
}
