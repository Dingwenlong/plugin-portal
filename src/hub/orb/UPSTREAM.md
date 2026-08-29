# Liquid Orb vendored source

- Source: https://github.com/LerSent001/orb
- Commit: `047c58cc93587c21dac12183fc0fb1e4101c8e1a`
- License: MIT, Copyright (c) 2026 LerSent001
- Imported: 2026-08-29

The TypeScript files under `upstream/` and the adjacent `effect.wgsl` are retained from
the pinned source commit. Portal-specific
selection of the `orb-glass-liquid` / `particleRibbon` preset and React lifecycle wiring
live outside that directory so the third-party implementation remains identifiable.

The requested URL configuration is represented by `CoverLiquidOrbConfig.ts`. The shared
shader is bundled as raw source by Vite; the deployed Portal does not request code or
assets from the upstream site at runtime.
