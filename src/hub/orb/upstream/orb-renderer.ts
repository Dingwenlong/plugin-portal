import { particleRibbonInstanceCount } from "./particle-ribbon";
import { styleFlowIndexes, type OrbParams } from "./presets";
import {
  createOrbTransitionController,
  type OrbRenderTarget,
} from "./orb-states";
import { orbUniformFloatCount, writeOrbUniforms } from "./orb-uniforms";
import { orbShaderSource } from "./shader-source";

export type OrbRendererOptions = {
  canvas: HTMLCanvasElement;
  getTarget: () => OrbRenderTarget;
  onError: (error: Error) => void;
  onReady: () => void;
};

export const MAX_PRESENTATION_TEXTURE_SIZE = 4096;

export function resolveOrbPresentationSize({
  clientWidth,
  clientHeight,
  devicePixelRatio,
  presentationScale,
  deviceMaximum,
}: {
  clientWidth: number;
  clientHeight: number;
  devicePixelRatio: number;
  presentationScale: number;
  deviceMaximum: number;
}): { width: number; height: number } {
  const cssWidth = Number.isFinite(clientWidth) ? Math.max(1, clientWidth) : 1;
  const cssHeight = Number.isFinite(clientHeight) ? Math.max(1, clientHeight) : 1;
  const dpr = Number.isFinite(devicePixelRatio)
    ? Math.min(2, Math.max(1, devicePixelRatio))
    : 1;
  const scale = Number.isFinite(presentationScale)
    ? Math.max(1, presentationScale)
    : 1;
  const reportedMaximum = Number.isFinite(deviceMaximum) && deviceMaximum > 0
    ? deviceMaximum
    : MAX_PRESENTATION_TEXTURE_SIZE;
  const maximum = Math.max(1, Math.floor(Math.min(MAX_PRESENTATION_TEXTURE_SIZE, reportedMaximum)));
  const rawWidth = Math.max(1, cssWidth * dpr * scale);
  const rawHeight = Math.max(1, cssHeight * dpr * scale);
  const fit = Math.min(1, maximum / Math.max(rawWidth, rawHeight));

  return {
    width: Math.max(1, Math.floor(rawWidth * fit)),
    height: Math.max(1, Math.floor(rawHeight * fit)),
  };
}

export type OrbRendererController = {
  prepareScale: (scale: number) => Promise<boolean>;
  stop: () => void;
};

export function createOrbRenderer({
  canvas,
  getTarget,
  onError,
  onReady,
}: OrbRendererOptions): OrbRendererController {
  let disposed = false;
  let animationFrame = 0;
  let device: GPUDevice | null = null;
  let ribbonTarget: GPUTexture | null = null;
  let readyNotified = false;
  let failed = false;
  let lastFrameAt: number | null = null;
  let motionPhase = 0;
  let requestedPresentationScale = 1;
  let renderedPresentationScale = 0;
  let preparationSequence = 0;
  let pendingPreparation: {
    id: number;
    scale: number;
    submitted: boolean;
    resolve: (ready: boolean) => void;
  } | null = null;

  function settlePreparation(ready: boolean): void {
    const preparation = pendingPreparation;
    pendingPreparation = null;
    preparation?.resolve(ready);
  }

  function fail(error: Error): void {
    if (disposed || failed) return;
    failed = true;
    cancelAnimationFrame(animationFrame);
    settlePreparation(false);
    ribbonTarget?.destroy();
    device?.destroy();
    onError(error);
  }

  async function start(): Promise<void> {
    if (!navigator.gpu) {
      throw new Error("当前浏览器不支持 WebGPU");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("未找到可用的 WebGPU 适配器");
    }

    device = await adapter.requestDevice();
    if (disposed) {
      device.destroy();
      return;
    }

    const context = canvas.getContext("webgpu");
    if (!context) {
      throw new Error("无法创建 WebGPU 画布上下文");
    }
    const gpuContext: GPUCanvasContext = context;

    const format = navigator.gpu.getPreferredCanvasFormat();
    gpuContext.configure({ device, format, alphaMode: "premultiplied" });

    const shader = device.createShaderModule({
      label: "orb-glass-liquid",
      code: orbShaderSource,
    });
    const compilation = await shader.getCompilationInfo();
    const compilationErrors = compilation.messages.filter(
      (message) => message.type === "error",
    );
    if (compilationErrors.length > 0) {
      throw new Error(
        compilationErrors
          .map((message) => `${message.lineNum}:${message.linePos} ${message.message}`)
          .join("\n"),
      );
    }

    const pipeline = device.createRenderPipeline({
      label: "orb-glass-liquid-pipeline",
      layout: "auto",
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{
          format,
          blend: {
            color: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });
    const ribbonPipeline = device.createRenderPipeline({
      label: "particle-ribbon-pipeline",
      layout: "auto",
      vertex: { module: shader, entryPoint: "ribbon_vs_main" },
      fragment: {
        module: shader,
        entryPoint: "ribbon_fs_main",
        targets: [{
          format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });
    const ribbonCompositePipeline = device.createRenderPipeline({
      label: "particle-ribbon-glass-composite-pipeline",
      layout: "auto",
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "ribbon_composite_fs_main",
        targets: [{
          format,
          blend: {
            color: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });
    const values = new Float32Array(orbUniformFloatCount);
    const uniformBuffer = device.createBuffer({
      size: values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });
    const ribbonBindGroup = device.createBindGroup({
      layout: ribbonPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });
    const ribbonSampler = device.createSampler({
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      magFilter: "linear",
      minFilter: "linear",
    });
    let ribbonCompositeBindGroup: GPUBindGroup | null = null;
    const transition = createOrbTransitionController(getTarget());

    device.lost.then((info) => {
      fail(new Error(`WebGPU 设备已断开：${info.message || info.reason}`));
    });
    device.addEventListener("uncapturederror", (event) => {
      event.preventDefault();
      fail(new Error(`WebGPU 渲染错误：${event.error.message}`));
    });

    function resize(): void {
      const size = resolveOrbPresentationSize({
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        presentationScale: requestedPresentationScale,
        deviceMaximum: device?.limits?.maxTextureDimension2D ?? MAX_PRESENTATION_TEXTURE_SIZE,
      });

      if (canvas.width !== size.width || canvas.height !== size.height) {
        canvas.width = size.width;
        canvas.height = size.height;
        ribbonTarget?.destroy();
        ribbonTarget = null;
        ribbonCompositeBindGroup = null;
      }
    }

    function ensureRibbonTarget(): void {
      if (ribbonTarget && ribbonCompositeBindGroup) return;

      ribbonTarget = device!.createTexture({
        label: "particle-ribbon-offscreen-texture",
        size: { width: canvas.width, height: canvas.height },
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      ribbonCompositeBindGroup = device!.createBindGroup({
        layout: ribbonCompositePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: ribbonTarget.createView() },
          { binding: 2, resource: ribbonSampler },
        ],
      });
    }

    function frame(now: number): void {
      if (disposed || failed || !device) {
        return;
      }

      try {
        resize();
        const params: OrbParams = transition.sample(getTarget(), now);
        const frameDelta = lastFrameAt === null
          ? 0
          : Math.min(0.1, Math.max(0, (now - lastFrameAt) / 1000));
        lastFrameAt = now;
        motionPhase += frameDelta * Math.max(params.speed, 0);
        const shaderTime = motionPhase / Math.max(params.speed, 0.001);
        writeOrbUniforms(
          values,
          canvas.width,
          canvas.height,
          shaderTime,
          params,
        );
        device.queue.writeBuffer(uniformBuffer, 0, values);

        const isParticleRibbon =
          styleFlowIndexes[params.style] === styleFlowIndexes.particleRibbon;
        const encoder = device.createCommandEncoder();
        if (isParticleRibbon) {
          ensureRibbonTarget();
          const particlePass = encoder.beginRenderPass({
            colorAttachments: [{
              view: ribbonTarget!.createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            }],
          });
          particlePass.setPipeline(ribbonPipeline);
          particlePass.setBindGroup(0, ribbonBindGroup);
          particlePass.draw(6, particleRibbonInstanceCount, 0, 0);
          particlePass.end();
        }
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: gpuContext.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
        if (isParticleRibbon) {
          pass.setPipeline(ribbonCompositePipeline);
          pass.setBindGroup(0, ribbonCompositeBindGroup!);
        } else {
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
        }
        pass.draw(3, 1, 0, 0);
        pass.end();
        device.queue.submit([encoder.finish()]);
        renderedPresentationScale = requestedPresentationScale;
        const preparation = pendingPreparation;
        if (preparation && !preparation.submitted && preparation.scale === renderedPresentationScale) {
          const submittedPreparation = preparation;
          submittedPreparation.submitted = true;
          const completion = typeof device.queue.onSubmittedWorkDone === "function"
            ? device.queue.onSubmittedWorkDone()
            : Promise.resolve();
          void completion.then(() => {
            if (disposed || failed || pendingPreparation?.id !== submittedPreparation.id) return;
            settlePreparation(true);
          }).catch(() => {
            if (pendingPreparation?.id === submittedPreparation.id) {
              requestedPresentationScale = 1;
              settlePreparation(false);
            }
          });
        }
        if (!readyNotified) {
          readyNotified = true;
          onReady();
        }
        animationFrame = requestAnimationFrame(frame);
      } catch (error) {
        if (requestedPresentationScale > 1 && pendingPreparation) {
          requestedPresentationScale = 1;
          renderedPresentationScale = 0;
          ribbonTarget?.destroy();
          ribbonTarget = null;
          ribbonCompositeBindGroup = null;
          settlePreparation(false);
          animationFrame = requestAnimationFrame(frame);
          return;
        }
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }

    animationFrame = requestAnimationFrame(frame);
  }

  start().catch((error: unknown) => {
    fail(error instanceof Error ? error : new Error(String(error)));
  });

  function stop(): void {
    disposed = true;
    cancelAnimationFrame(animationFrame);
    settlePreparation(false);
    ribbonTarget?.destroy();
    device?.destroy();
  }

  function prepareScale(scale: number): Promise<boolean> {
    if (disposed || failed || !device || !readyNotified) return Promise.resolve(false);
    const normalizedScale = Number.isFinite(scale) ? Math.max(1, scale) : 1;
    if (renderedPresentationScale === normalizedScale && !pendingPreparation) {
      return Promise.resolve(true);
    }

    settlePreparation(false);
    requestedPresentationScale = normalizedScale;
    const id = ++preparationSequence;
    return new Promise<boolean>((resolve) => {
      pendingPreparation = { id, scale: normalizedScale, submitted: false, resolve };
    });
  }

  return { prepareScale, stop };
}
