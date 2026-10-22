# Stitch-iOS
Image editing for iPhone 

Stitch is a photo editor that runs in Safari and installs to the iPhone home screen as an app (PWA).
Photos are processed entirely on the device and never uploaded.

Live: https://stitch.reloru.workers.dev

## Install on iPhone

Open the link in Safari, tap **Share**, then **Add to Home Screen**.

## Develop

```sh
npm ci
npm run dev        # Vite dev server
npm run check      # typecheck, unit tests, build, Playwright e2e
```

## Deploy

Pushing to `main` runs CI and deploys to Cloudflare Workers (static assets) with Wrangler.
Manual deploy: `npm run build && npx wrangler deploy` (needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`).
