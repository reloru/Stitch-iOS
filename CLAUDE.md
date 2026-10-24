# Stitch

Mobile-first photo editor (edit, overlay, mask, stitch) built as an installable PWA for iPhone Safari.
Image processing runs client-side in the browser. The server code is `worker/`: `POST /api/remove-bg` (Cloudflare
Images `segment: "foreground"` via the Images binding) and `POST /api/inpaint` (object removal: the `Inpainter`
Durable Object starts the `container/` image — LaMa on CPU via ONNX Runtime — and forwards to it), each rate-limited
per IP. Static files are served by
Workers static assets on the Worker named `stitch` (https://stitch.reloru.workers.dev); `run_worker_first` sends only
`/api/*` to the Worker.

## Checks

- `npm run typecheck` — TypeScript for the app (`tsc --noEmit`) and the Worker (`tsc -p worker`, Workers types)
- `npm test` — Vitest unit tests (`tests/unit`, Node environment; pure logic only)
- `npm run build` — Vite production build into `dist/` (also emits `sw.js` and `version.json`)
- `npm run e2e` — Playwright against `vite preview`, Chromium with iPhone 14 Pro Max emulation (`tests/e2e`). Run after `build`.
- `npm run deploy:dry` — `wrangler deploy --dry-run`. Builds the container image, so it needs a Docker daemon. In a
  Claude Code cloud session start one with `dockerd &`; the build still fails there because pip inside the build
  does not trust the session's TLS proxy — rely on CI for this check (CI also runs `container/selftest.py` in the image).
- Container locally: `docker build -t stitch-inpaint container && docker run --rm stitch-inpaint python /app/selftest.py`
- `npm run check` — typecheck + unit + build + e2e + deploy:dry

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
- Touch: double-tap always means zoom and never edits. In Mask, a single brush dab or colour pick waits out the
  double-tap window (350 ms) before it is committed (`EditorView.flush/settle`). Controls are ≥ 44 pt (an e2e test
  checks). Hints use `useHint` (hidden after the first touch). Sheets that hold work pass `keep` (no backdrop
  dismiss). Open text fields from a tap via `raiseKeyboard()` so iOS shows the keyboard; `--kb` keeps sheets above it.
- Icons: edit `public/icons/icon.svg`, then `npm run icons` to regenerate the PNGs.

## Layout

- `src/core/` — framework-free logic: `geometry` (matrices, crop fitting), `doc` (document model + orientation ops),
  `adjust` + `gl` (colour pipeline; GLSL mirrors `adjustPixel`, keep them in sync — the parity e2e test enforces ±3),
  `mask`, `history` (undo with shared mask snapshots), `render`, `text`, `stitch` (layout), `autostitch`
  (screenshot overlap), `png` (streaming encoder), `export`, `source` (decode + proxies), `canvas` (limits, helpers).
- `src/editor/` — `view.ts` is the imperative canvas/gesture engine; `Editor.tsx` is the Preact UI around it.
- `src/stitch/` — same split for the stitcher.
- `worker/` — `handler.ts` is pure (bindings injected, unit-tested in Node); `index.ts` wires `env.IMAGES`, the rate
  limits and the `Inpainter` Durable Object. E2E tests never call the real APIs: they intercept `/api/*` with
  `page.route`.
- `container/` — `server.py` (HTTP on :8080: `/health`, `POST /inpaint` = image bytes + mask bytes, header
  `x-image-length`; returns RGBA PNG whose alpha is the grown, feathered mask), `selftest.py`, `Dockerfile` (pinned
  model revision + sha256, converted to ORT format at build time). Model input is fixed at 512×512.
  Container app: `default` scheduling policy (cannot change after creation), custom 4 vCPU / 12 GiB, stops 2 min after
  the last request.
- ✓/✗ under the picture are per tool session: the session starts at `History.position` when a tool is opened (or at
  the last ✓/✗); ✗ undoes back to it, ✓ moves it to now. Nothing is baked in. Merge / Flatten = `flattenDoc`
  (full-res render → new single-photo doc), stored as PNG so it adds no lossy generation. Photos no longer reachable
  from `History.docs()` or the current doc are disposed (the Editor effect after each render).
- Tool panel: fixed height (`--panel-h`, three 44 pt rows) so the picture never resizes between tools; panels show
  one slider at a time with chips choosing what it controls. An e2e test asserts the stage height is constant.
- Adjust/Filters/Mask edit one layer, chosen with the layer chip under the picture (shown when there are photo layers).
- Autosave (`src/core/persist.ts`): the open editor document or stitch is written to IndexedDB (debounced after each
  commit, flushed when the page is hidden): photo bytes once per source, mask alpha, layers, settings; no undo history.
  The home screen offers "Continue"; Back → Discard clears it. New document fields must survive structured clone
  (plain data) or be converted in `saveEditor`/`restoreSession`.
- Erase tool: the selection is a `Mask` in the background photo's source px (mapped with `geo.orient`), owned by the
  Editor (not the document) with its own undo stack, which Undo/Redo/✗ use first while in Erase; it resets when the
  background source changes. `core/inpaint.ts` plans the crop (`planCrop`: native 512 px square if the object fits,
  else scaled down), posts it, and composites the returned RGBA patch at full resolution; the result replaces
  `doc.base.src` (PNG) as one undoable commit. E2E tests mock `/api/inpaint` with a half-transparent patch.
- Overlay photos: `ImageLayer.crop` is in source px; always map layer pixels with `imageLayerMat(l)` (crop-aware),
  and change crops via `setLayerCrop` so the visible pixels stay put. Masks stay in full source px.

## Testing notes

- E2E fixtures are generated in code (`tests/e2e/fixtures.ts`); there are no binary fixtures.
- Test hooks read from `globalThis`: `__stitchLimits = { maxArea, maxSide }` emulates a device canvas limit;
  `__stitchForceCPU = true` disables WebGL; `__stitchGL` is set when the shader initialised.
- `SHOTS=<dir> npx playwright test` writes screenshots of key states for visual review.
