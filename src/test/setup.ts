import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }),
  });
}

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => null,
});

afterEach(() => cleanup());
