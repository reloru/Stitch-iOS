# Stitch

Mobile-first photo editor (edit, overlay, mask, stitch) built as an installable PWA for iPhone Safari.
All image processing runs client-side in the browser; there is no backend. Served as static assets
from a Cloudflare Worker named `stitch` (https://stitch.reloru.workers.dev).

## Checks

- `npm run typecheck` — TypeScript (`tsc --noEmit`)
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
- Icons: edit `public/icons/icon.svg`, then `npm run icons` to regenerate the PNGs.

## Layout

- `src/core/` — framework-free logic: `geometry` (matrices, crop fitting), `doc` (document model + orientation ops),
  `adjust` + `gl` (colour pipeline; GLSL mirrors `adjustPixel`, keep them in sync — the parity e2e test enforces ±3),
  `mask`, `history` (undo with shared mask snapshots), `render`, `text`, `stitch` (layout), `autostitch`
  (screenshot overlap), `png` (streaming encoder), `export`, `source` (decode + proxies), `canvas` (limits, helpers).
- `src/editor/` — `view.ts` is the imperative canvas/gesture engine; `Editor.tsx` is the Preact UI around it.
- `src/stitch/` — same split for the stitcher.

## Testing notes

- E2E fixtures are generated in code (`tests/e2e/fixtures.ts`); there are no binary fixtures.
- Test hooks read from `globalThis`: `__stitchLimits = { maxArea, maxSide }` emulates a device canvas limit;
  `__stitchForceCPU = true` disables WebGL; `__stitchGL` is set when the shader initialised.
- `SHOTS=<dir> npx playwright test` writes screenshots of key states for visual review.
