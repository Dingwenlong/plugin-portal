import { useEffect, useId, useRef, useState } from "react";
import { glassMaps } from "./glassDisplacement";

interface GlassMap { width: number; height: number; url: string }

export function GlassSurface() {
  const id = `capsule-glass-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const surface = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<GlassMap | null>(null);

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const supported = /(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent)
      && typeof CSS !== "undefined" && CSS.supports("backdrop-filter", `url("#${id}")`)
      && typeof ResizeObserver !== "undefined";
    let disposed = false;
    let frame: number | null = null;
    let previous = "";
    const measure = () => {
      frame = null;
      if (disposed) return;
      if (!supported || reduced.matches) { previous = ""; setMap(null); return; }
      const bounds = element.getBoundingClientRect();
      const width = Math.ceil(bounds.width);
      const height = Math.ceil(bounds.height);
      const key = `${width}x${height}`;
      if (!width || !height || key === previous) return;
      try {
        const url = glassMaps.get(width, height);
        if (!disposed) { setMap({ width, height, url }); previous = key; }
      } catch { previous = ""; setMap(null); }
    };
    const schedule = () => {
      if (!disposed && frame === null) frame = window.requestAnimationFrame(measure);
    };
    const observer = supported ? new ResizeObserver(schedule) : null;
    observer?.observe(element);
    reduced.addEventListener("change", schedule);
    measure();
    return () => {
      disposed = true;
      observer?.disconnect();
      reduced.removeEventListener("change", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [id]);

  return <div
    aria-hidden="true"
    className="portal-capsule-glass"
    data-glass-mode={map ? "refractive" : "clear"}
    ref={surface}
  >
    {map && <div
      className="portal-capsule-glass-refraction"
      style={{ backdropFilter: `url("#${id}")`, WebkitBackdropFilter: `url("#${id}")` }}
    />}
    <div className="portal-capsule-glass-fog" />
    <div className="portal-capsule-glass-optics" />
    {map && <svg className="portal-glass-definitions" width="0" height="0" focusable="false">
      <defs>
        <filter id={id} x="0" y="0" width={map.width} height={map.height} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feImage href={map.url} x="0" y="0" width={map.width} height={map.height} preserveAspectRatio="none" result="map" />
          <feComponentTransfer in="map" result="neutralMap">
            <feFuncR type="linear" slope={255 / 256} />
            <feFuncG type="linear" slope={255 / 256} />
          </feComponentTransfer>
          <feDisplacementMap in="SourceGraphic" in2="neutralMap" scale="26" xChannelSelector="R" yChannelSelector="G" result="redShift" />
          <feDisplacementMap in="SourceGraphic" in2="neutralMap" scale="29" xChannelSelector="R" yChannelSelector="G" result="greenShift" />
          <feDisplacementMap in="SourceGraphic" in2="neutralMap" scale="32" xChannelSelector="R" yChannelSelector="G" result="blueShift" />
          <feColorMatrix in="redShift" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
          <feColorMatrix in="greenShift" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green" />
          <feColorMatrix in="blueShift" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue" />
          <feBlend in="red" in2="green" mode="screen" result="redGreen" />
          <feBlend in="redGreen" in2="blue" mode="screen" />
        </filter>
      </defs>
    </svg>}
  </div>;
}
