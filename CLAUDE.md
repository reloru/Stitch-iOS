# Stitch

Mobile-first photo editor (edit, overlay, mask, stitch) built as an installable PWA for iPhone Safari.
Image processing runs client-side in the browser. The only server code is `worker/` (`POST /api/remove-bg`,
Cloudflare Images `segment: "foreground"` via the Images binding, rate-limited per IP). Static files are served by
Workers static assets on the Worker named `stitch` (https://stitch.reloru.workers.dev); `run_worker_first` sends only
`/api/*` to the Worker.

## Checks

- `npm run typecheck` — TypeScript for the app (`tsc --noEmit`) and the Worker (`tsc -p worker`, Workers types)
- `npm test` — Vitest unit tests (`tests/unit`, Node environment; pure logic only)
- `npm run build` — Vite production build into `dist/` (also emits `sw.js` and `version.json`)
- `npm run e2e` — Playwright against `vite preview`, Chromium with iPhone 14 Pro Max emulation (`tests/e2e`). Run after `build`.
- `npm run deploy:dry` — `wrangler deploy --dry-run`
- `npm run check` — typecheck + unit + build + e2e

Playwright is pinned to 1.56.1 to match the Chromium build preinstalled in Claude Code cloud containers
(`/opt/pw-browsers`); do not run `playwright install` there.

## Deploy

GitHub Actions (`.github/workflows/ci.yml`): every PR runs the checks; every push to `main` runs the checks,
builds, deploys with `cloudflare/wrangler-action@v4`, then polls `/version.json` until the live build id
matches the one just built. Manual fallback: `npm run build && npx wrangler deploy`.

## Conventions

- Preact 11 + TypeScript, no CSS framework. Styles in `src/styles.css` (dark UI, safe-area aware).
- Build id (`__BUILD__`) = `package.json` version + short git sha; shown on the home screen and in `/version.json`.
- `src/sw-template.js` becomes `/sw.js` at build time (see `vite.config.ts`): network-first navigations, cache-first hashed assets.
- iOS Safari constraints drive the design: edit on downscaled proxies, decode full resolution only at export,
  probe the canvas size limit at runtime, release canvases (`width = height = 0`) after use, and call
  `navigator.share` only directly from a tap (render the file first, then show the Save button).
- Top edge: iOS 26+ blurs the top of home-screen web apps (Liquid Glass scroll edge effect) unless a fixed, full-width,
  opaque box covers it. Keep `.topbar` `position: fixed` + opaque (with `.topbar-space` in flow) and `.status-cap` on screens
  without a top bar; an e2e test guards this.
- Icons: edit `public/icons/icon.svg`, then `npm run icons` to regenerate the PNGs.

## Layout

- `src/core/` — framework-free logic: `geometry` (matrices, crop fitting), `doc` (document model + orientation ops),
  `adjust` + `gl` (colour pipeline; GLSL mirrors `adjustPixel`, keep them in sync — the parity e2e test enforces ±3),
  `mask`, `history` (undo with shared mask snapshots), `render`, `text`, `stitch` (layout), `autostitch`
  (screenshot overlap), `png` (streaming encoder), `export`, `source` (decode + proxies), `canvas` (limits, helpers).
- `src/editor/` — `view.ts` is the imperative canvas/gesture engine; `Editor.tsx` is the Preact UI around it.
- `src/stitch/` — same split for the stitcher.
- `worker/` — `handler.ts` is pure (bindings injected, unit-tested in Node); `index.ts` wires `env.IMAGES` and
  `env.REMOVE_BG_LIMIT`. E2E tests never call the real API: they intercept `/api/remove-bg` with `page.route`.
- ✓ Apply = `flattenDoc` (full-res render → new single-photo doc); applied docs are recorded as checkpoints and
  ✗ Discard undoes back to the latest one. Opaque applies are stored as JPEG 0.97 (`sourceFromCanvas(…, alpha)`)
  to bound memory, since every applied photo stays referenced by undo history.
- Overlay photos: `ImageLayer.crop` is in source px; always map layer pixels with `imageLayerMat(l)` (crop-aware),
  and change crops via `setLayerCrop` so the visible pixels stay put. Masks stay in full source px.

## Testing notes

- E2E fixtures are generated in code (`tests/e2e/fixtures.ts`); there are no binary fixtures.
- Test hooks read from `globalThis`: `__stitchLimits = { maxArea, maxSide }` emulates a device canvas limit;
  `__stitchForceCPU = true` disables WebGL; `__stitchGL` is set when the shader initialised.
- `SHOTS=<dir> npx playwright test` writes screenshots of key states for visual review.
