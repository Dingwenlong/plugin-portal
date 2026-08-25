import { useEffect, useRef, useState } from "react";
import {
  COVER_ACCRETION_FIELD_FRAGMENT_SHADER,
  COVER_ACCRETION_FIELD_VERTEX_SHADER,
} from "./CoverAccretionFieldShader";

type RenderState = "loading" | "ready" | "fallback";
type AnimationState = "running" | "static" | "frozen";
type AnimationController = { setFrozen: (frozen: boolean) => void };

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create the cover shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    throw new Error("Unable to compile the cover shader.");
  }
  return shader;
}
function createProgram(gl: WebGLRenderingContext) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, COVER_ACCRETION_FIELD_VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, COVER_ACCRETION_FIELD_FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("Unable to create the cover shader program.");
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    throw new Error("Unable to link the cover shader program.");
  }
  return program;
}

export function CoverAccretionBackground({
  intensity = "ambient",
  frozen = false,
}: {
  intensity?: "ambient" | "surge";
  frozen?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const intensityRef = useRef(intensity);
  const frozenRef = useRef(frozen);
  const controllerRef = useRef<AnimationController | null>(null);
  const [renderState, setRenderState] = useState<RenderState>("loading");
  const [animationState, setAnimationState] = useState<AnimationState>("running");
  intensityRef.current = intensity;
  frozenRef.current = frozen;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setAnimationState(motionQuery.matches ? "static" : "running");

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      powerPreference: "low-power",
    });
    if (!gl) {
      setRenderState("fallback");
      return;
    }

    let program: WebGLProgram;
    try {
      program = createProgram(gl);
    } catch {
      setRenderState("fallback");
      return;
    }

    const positionBuffer = gl.createBuffer();
    const positionLocation = gl.getAttribLocation(program, "aViewportCorner");
    const viewportLocation = gl.getUniformLocation(program, "uViewport");
    const clockLocation = gl.getUniformLocation(program, "uClock");
    if (!positionBuffer || positionLocation < 0 || !viewportLocation || !clockLocation) {
      if (positionBuffer) gl.deleteBuffer(positionBuffer);
      gl.deleteProgram(program);
      setRenderState("fallback");
      return;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
      3, -1,
      -1, 3,
    ]), gl.STATIC_DRAW);
    gl.useProgram(program);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    let animationFrame = 0;
    let disposed = false;
    let renderedFrames = 0;
    let lastClockSeconds = 0;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.uniform2f(viewportLocation, width, height);
    };

    const render = (seconds: number, countFrame = true) => {
      resize();
      gl.uniform1f(clockLocation, seconds);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      lastClockSeconds = seconds;
      if (countFrame) renderedFrames += 1;
      canvas.dataset.renderedFrame = String(renderedFrames);
      canvas.dataset.renderedClock = seconds.toFixed(6);
    };

    const animate = (time: number) => {
      if (disposed || frozenRef.current) return;
      const clockMultiplier = intensityRef.current === "surge" ? 1.65 : 1;
      render((time / 1000) * clockMultiplier);
      animationFrame = window.requestAnimationFrame(animate);
    };

    const start = () => {
      window.cancelAnimationFrame(animationFrame);
      if (frozenRef.current) {
        setAnimationState("frozen");
      } else if (motionQuery.matches) {
        setAnimationState("static");
        render(0);
      } else {
        setAnimationState("running");
        animationFrame = window.requestAnimationFrame(animate);
      }
    };

    const handleResize = () => {
      if (frozenRef.current) render(lastClockSeconds, false);
      else if (motionQuery.matches) render(0);
    };
    const handleMotionChange = () => start();

    setRenderState("ready");
    controllerRef.current = { setFrozen: () => start() };
    start();
    window.addEventListener("resize", handleResize);
    motionQuery.addEventListener("change", handleMotionChange);

    return () => {
      disposed = true;
      controllerRef.current = null;
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", handleResize);
      motionQuery.removeEventListener("change", handleMotionChange);
      gl.deleteBuffer(positionBuffer);
      gl.deleteProgram(program);
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setFrozen(frozen);
  }, [frozen]);

  return <div
    className="portal-cover-accretion"
    data-animation-state={animationState}
    data-motion-intensity={intensity}
    data-cover-accretion-background
    aria-hidden="true"
  >
    <canvas
      ref={canvasRef}
      className="portal-cover-accretion-canvas"
      data-cover-accretion-canvas
      data-render-state={renderState}
      data-rendered-frame="0"
      data-rendered-clock="0.000000"
    />
  </div>;
}
