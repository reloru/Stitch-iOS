# Stitch-iOS
Image editing for iPhone 

Stitch is a photo editor that runs in Safari and installs to the iPhone home screen as an app (PWA).
Photos are processed entirely on the device and never uploaded.

Live: https://stitch.reloru.workers.dev

## Install on iPhone

Open the link in Safari, tap **Share**, then **Add to Home Screen**. The app opens full screen and works offline
after the first visit.

## Features

**Edit a photo**
- Adjust: exposure, brightness, contrast, highlights, shadows, saturation, vibrance, warmth, tint, fade, sharpen, vignette.
  Hold the eye button to compare with the original.
- Filters: 11 looks with a strength slider.
- Crop: free or fixed aspect (square, 4:5, 9:16, …), drag edges, pinch, straighten ±45°, rotate, flip.
- Overlay: add photos or text on top; drag to move, pinch or use the corner handle to resize and rotate; opacity and
  16 blend modes (multiply, screen, overlay, …); reorder, duplicate, mirror. Each photo layer has its own adjustments and filters.
- Mask (on the background photo or any photo layer): brush to hide/reveal (size, hardness, flow), linear and radial
  gradients, colour select (magic wand), invert, show/hide all. A masked background exports as a transparent PNG.
- Undo/redo for everything, including mask strokes.
- Save: JPEG or PNG at full, 50% or 25% size, then **Save → Save Image** puts it in Photos.

**Stitch photos**
- Vertical, side-by-side or grid layouts; spacing, border, rounded corners, background colour.
- Trim each photo by dragging its orange handles (or with sliders) — crop and stitch.
- **Auto-stitch screenshots**: finds the overlap between scrolling screenshots and removes the repeated status/nav/tab bars.
- Very long results that exceed what Safari can draw in one canvas are written as PNG in strips at full resolution.
- Send the result to the editor for overlays, text and masks.

## How it works

Everything is client-side TypeScript (Preact UI, Canvas 2D compositing, a WebGL2 shader for adjustments with a CPU
fallback). Editing happens on ≤2048 px proxies; full resolution is decoded only when saving. The largest canvas the
device can draw is probed at runtime and exports are capped to it. Hosting is a static Cloudflare Worker.

## Develop

```sh
npm ci
npm run dev        # Vite dev server
npm run check      # typecheck, unit tests, build, Playwright e2e
```

## Deploy

Pushing to `main` runs CI and deploys to Cloudflare Workers (static assets) with Wrangler, then checks that
`/version.json` reports the new build. Manual deploy: `npm run build && npx wrangler deploy`
(needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`).

## Test coverage and limits

Automated tests run in Chromium emulating an iPhone 14 Pro Max (viewport, pixel ratio, touch). Safari-specific behaviour
— the share sheet, HEIC decoding, the exact canvas size/memory limits, and gesture feel — is verified on the device, not in CI.
