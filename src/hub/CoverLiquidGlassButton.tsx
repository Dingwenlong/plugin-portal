import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEventHandler,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  coverLiquidGlassBackingSize,
  startCoverLiquidGlassFallback,
} from "./CoverLiquidGlassButtonFallback";
import { COVER_LIQUID_GLASS_BUTTON_SHADER } from "./CoverLiquidGlassButtonShader";

type RenderState = "loading" | "ready" | "fallback";
type AnimationState = "running" | "static";

type GpuApi = {
  getPreferredCanvasFormat: () => string;
  requestAdapter: () => Promise<GpuAdapter | null>;
};

type GpuAdapter = {
  requestDevice: () => Promise<GpuDevice>;
};

type GpuDevice = {
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  createBindGroup: (descriptor: unknown) => GpuBindGroup;
  createBuffer: (descriptor: unknown) => GpuBuffer;
  createCommandEncoder: () => GpuCommandEncoder;
  createRenderPipelineAsync?: (descriptor: unknown) => Promise<GpuPipeline>;
  createShaderModule: (descriptor: unknown) => GpuShaderModule;
  destroy: () => void;
  lost: Promise<{ message?: string; reason?: string }>;
  queue: {
    submit: (commands: unknown[]) => void;
    writeBuffer: (buffer: GpuBuffer, offset: number, values: Float32Array) => void;
  };
};

type GpuShaderModule = {
  getCompilationInfo: () => Promise<{
    messages: Array<{ lineNum: number; linePos: number; message: string; type: string }>;
  }>;
};

type GpuCanvasContext = {
  configure: (descriptor: unknown) => void;
  getCurrentTexture: () => { createView: () => unknown };
};

type GpuPipeline = {
  getBindGroupLayout: (index: number) => unknown;
};

type GpuBindGroup = object;
type GpuBuffer = object;

type GpuCommandEncoder = {
  beginRenderPass: (descriptor: unknown) => {
    draw: (vertexCount: number) => void;
    end: () => void;
    setBindGroup: (index: number, bindGroup: GpuBindGroup) => void;
    setPipeline: (pipeline: GpuPipeline) => void;
  };
  finish: () => unknown;
};

const CHROME_PARAMETERS = [
  2,
  0.72,
  0.36,
  3.8,
  0.44,
  5.2,
  0.58,
  0.36,
  0.28,
  0.2,
  0.22,
  1.08,
  12,
  0.005,
  0,
  0,
  1,
  0.42,
  0,
] as const;

const CHROME_COLORS = [
  "#FFFFFF",
  "#B9C0CA",
  "#343A43",
  "#030405",
  "#FFFFFF",
  "#FFFFFF",
  "#B9C0CA",
  "#FFFFFF",
  "#EAF4FF",
  "#DCEAFF",
  "#050608",
  "#FFFFFF",
  "#F7FBFF",
  "#EFF6FD",
  "#E0EEF9",
  "#D4E6F7",
  "#BBD5F3",
  "#A6C7F0",
  "#87B0EB",
  "#6F9EE8",
  "#6F9EE8",
  "#6F9EE8",
  "#6F9EE8",
  "#6F9EE8",
] as const;

function rgba(hex: string) {
  const value = hex.slice(1);
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
    1,
  ];
}

function writeChromeUniforms(
  values: Float32Array,
  width: number,
  height: number,
  time: number,
) {
  values.fill(0);
  values[0] = width;
  values[1] = height;
  values[2] = time;
  values.set(CHROME_PARAMETERS, 3);
  CHROME_COLORS.forEach((color, index) => {
    values.set(rgba(color), 24 + index * 4);
  });
}

function asError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}

export async function createCurrentCoverLiquidGlassPipeline(
  device: { createRenderPipelineAsync?: (descriptor: unknown) => Promise<GpuPipeline> },
  descriptor: unknown,
  isCurrent: () => boolean,
) {
  if (typeof device.createRenderPipelineAsync !== "function") {
    throw new Error("Asynchronous WebGPU pipeline creation is unavailable.");
  }
  const pipeline = await device.createRenderPipelineAsync(descriptor);
  if (!isCurrent()) throw new Error("The WebGPU renderer is no longer current.");
  return pipeline;
}

export function CoverLiquidGlassButton({
  children,
  onClick,
  className,
  disabled,
  style,
  onAnimationEnd,
}: {
  children: ReactNode;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  style?: CSSProperties;
  onAnimationEnd?: AnimationEventHandler<HTMLButtonElement>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const disabledRef = useRef(Boolean(disabled));
  const [renderState, setRenderState] = useState<RenderState>("loading");
  const [animationState, setAnimationState] = useState<AnimationState>("running");
  disabledRef.current = Boolean(disabled);

  useLayoutEffect(() => {
    if (renderState !== "fallback") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setAnimationState(motionQuery.matches ? "static" : "running");
    try {
      return startCoverLiquidGlassFallback({
        canvas,
        motionQuery,
        onReady: () => setRenderState("fallback"),
        onAnimationStateChange: setAnimationState,
        isPaused: () => disabledRef.current,
      });
    } catch {
      canvas.dataset.fallbackRenderer = "css-static";
      return;
    }
  }, [renderState]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setAnimationState(motionQuery.matches ? "static" : "running");
    let disposed = false;
    let animationFrame = 0;
    let device: GpuDevice | null = null;
    let failed = false;
    let readyNotified = false;
    let renderedFrames = 0;
    let startedAt = performance.now();
    let removeListeners: (() => void) | undefined;

    const fail = (_error: Error) => {
      if (disposed || failed) return;
      failed = true;
      window.clearTimeout(initializationTimeout);
      window.cancelAnimationFrame(animationFrame);
      removeListeners?.();
      device?.destroy();
      device = null;
      setRenderState("fallback");
    };
    const initializationTimeout = window.setTimeout(
      () => fail(new Error("WebGPU initialization timed out.")),
      10_000,
    );

    const start = async () => {
      const gpu = (navigator as unknown as { gpu?: GpuApi }).gpu;
      const usage = (globalThis as typeof globalThis & {
        GPUBufferUsage?: { COPY_DST: number; UNIFORM: number };
      }).GPUBufferUsage;
      if (!gpu || !usage) throw new Error("WebGPU is unavailable.");

      const adapter = await gpu.requestAdapter();
      if (disposed || failed) return;
      if (!adapter) throw new Error("A WebGPU adapter is unavailable.");
      const rendererDevice = await adapter.requestDevice();
      if (disposed || failed) {
        rendererDevice.destroy();
        return;
      }
      device = rendererDevice;

      const format = gpu.getPreferredCanvasFormat();
      const shader = rendererDevice.createShaderModule({
        code: COVER_LIQUID_GLASS_BUTTON_SHADER,
        label: "portal-cover-liquid-chrome-capsule",
      });
      const compilation = await shader.getCompilationInfo();
      if (disposed || failed) return;
      const compilationErrors = compilation.messages.filter((message) => message.type === "error");
      if (compilationErrors.length > 0) {
        throw new Error(compilationErrors.map((message) => (
          `${message.lineNum}:${message.linePos} ${message.message}`
        )).join("\n"));
      }

      const pipeline = await createCurrentCoverLiquidGlassPipeline(rendererDevice, {
        layout: "auto",
        vertex: { module: shader, entryPoint: "coverGlassVertex" },
        fragment: {
          module: shader,
          entryPoint: "coverGlassFragment",
          targets: [{ format }],
        },
        primitive: { topology: "triangle-list" },
      }, () => !disposed && !failed && !disabledRef.current && device === rendererDevice);
      // Bind the visible canvas only after a current pipeline is available.
      const context = (
        canvas.getContext as unknown as (contextId: string) => GpuCanvasContext | null
      ).call(canvas, "webgpu");
      if (!context) throw new Error("The WebGPU canvas context is unavailable.");
      context.configure({ device: rendererDevice, format, alphaMode: "premultiplied" });
      const values = new Float32Array(120);
      const uniformBuffer = rendererDevice.createBuffer({
        size: values.byteLength,
        usage: usage.UNIFORM | usage.COPY_DST,
      });
      const bindGroup = rendererDevice.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
      });

      rendererDevice.lost.then((info) => {
        fail(new Error(`WebGPU device lost: ${info.message || info.reason || "unknown"}`));
      });
      rendererDevice.addEventListener("uncapturederror", (event) => fail(asError(event)));

      const render = (now: number) => {
        if (disposed || failed || device !== rendererDevice) return;
        const bounds = canvas.getBoundingClientRect();
        const { width, height } = coverLiquidGlassBackingSize({
          clientWidth: canvas.clientWidth,
          clientHeight: canvas.clientHeight,
          transformedWidth: bounds.width,
          transformedHeight: bounds.height,
          devicePixelRatio: window.devicePixelRatio || 1,
        });
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }

        writeChromeUniforms(values, width, height, (now - startedAt) / 1000);
        rendererDevice.queue.writeBuffer(uniformBuffer, 0, values);
        const encoder = rendererDevice.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
        rendererDevice.queue.submit([encoder.finish()]);
        renderedFrames += 1;
        canvas.dataset.renderedFrame = String(renderedFrames);
        if (!readyNotified) {
          readyNotified = true;
          window.clearTimeout(initializationTimeout);
          setRenderState("ready");
        }
      };

      const animate = (now: number) => {
        if (disposed || failed || motionQuery.matches || disabledRef.current) return;
        try {
          render(now);
          animationFrame = window.requestAnimationFrame(animate);
        } catch (error) {
          fail(asError(error));
        }
      };

      const applyMotionPreference = () => {
        window.cancelAnimationFrame(animationFrame);
        if (motionQuery.matches) {
          setAnimationState("static");
          try {
            render(startedAt);
          } catch (error) {
            fail(asError(error));
          }
        } else {
          setAnimationState("running");
          if (disabledRef.current) return;
          startedAt = performance.now();
          animationFrame = window.requestAnimationFrame(animate);
        }
      };

      const handleResize = () => {
        if (!motionQuery.matches) return;
        try {
          render(startedAt);
        } catch (error) {
          fail(asError(error));
        }
      };

      motionQuery.addEventListener("change", applyMotionPreference);
      window.addEventListener("resize", handleResize);
      applyMotionPreference();

      return () => {
        motionQuery.removeEventListener("change", applyMotionPreference);
        window.removeEventListener("resize", handleResize);
      };
    };

    start().then((cleanup) => {
      if (disposed || failed) cleanup?.();
      else removeListeners = cleanup;
    }).catch((error) => fail(asError(error)));

    return () => {
      disposed = true;
      window.clearTimeout(initializationTimeout);
      window.cancelAnimationFrame(animationFrame);
      removeListeners?.();
      device?.destroy();
    };
  }, []);

  return <button
    className={`portal-cover-enter${className ? ` ${className}` : ""}`}
    type="button"
    onClick={onClick}
    disabled={disabled}
    style={style}
    onAnimationEnd={onAnimationEnd}
    data-animation-state={animationState}
    data-cover-liquid-glass-button="true"
    data-render-state={renderState}
  >
    <canvas
      key={renderState === "fallback" ? "fallback" : "webgpu"}
      ref={canvasRef}
      className="portal-cover-enter-canvas"
      aria-hidden="true"
      data-cover-liquid-glass-canvas
      data-render-state={renderState}
      data-rendered-frame="0"
      data-rendered-clock="0.000000"
      data-shape="circle"
    />
    <span className="portal-cover-enter-label">{children}</span>
  </button>;
}
