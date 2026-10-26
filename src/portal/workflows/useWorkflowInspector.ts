import { useLayoutEffect, useRef, useState } from "react";

/** Compact editing is a page view, not a modal. Keep its canvas position and trigger. */
export function useWorkflowInspector(enabled: boolean) {
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 899px)").matches);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const returnTo = useRef<{ element: HTMLElement | null; top: number; scrollY: number } | undefined>(undefined);
  const returning = useRef(false);
  useLayoutEffect(() => {
    const media = window.matchMedia("(max-width: 899px)");
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    if (!enabled || !compact) return;
    if (open) {
      const panel = panelRef.current;
      if (panel) {
        window.scrollTo({ top: Math.max(0, window.scrollY + panel.getBoundingClientRect().top - 112), behavior: "instant" });
        panel.querySelector<HTMLInputElement>("input:not([disabled])")?.focus({ preventScroll: true });
      }
    } else if (returning.current) {
      const target = returnTo.current;
      if (target) {
        const original = target.element?.isConnected ? target.element : null;
        const element = original ?? canvasRef.current?.querySelector<HTMLElement>('[aria-current="true"]')
          ?? canvasRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], button');
        const top = element
          ? window.scrollY + element.getBoundingClientRect().top - (original ? target.top : 112) : target.scrollY;
        window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
        element?.focus({ preventScroll: true });
      }
      returning.current = false;
    }
  }, [compact, enabled, open]);
  const show = () => {
    if (!open) {
      const element = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
      returnTo.current = { element, top: element?.getBoundingClientRect().top ?? 112, scrollY: window.scrollY };
    }
    setOpen(true);
  };
  const back = () => { returning.current = true; setOpen(false); };
  return { compact: enabled && compact, open, show, back, panelRef, canvasRef };
}
