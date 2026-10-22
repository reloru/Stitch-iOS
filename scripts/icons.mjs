// Renders public/icons/icon.svg to the PNG sizes iOS and the web manifest need.
// Usage: npm run icons   (uses the Playwright Chromium already on the machine)
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const svg = readFileSync(new URL('../public/icons/icon.svg', import.meta.url), 'utf8');
const sizes = [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
];
const browser = await chromium.launch();
for (const [name, size] of sizes) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.screenshot({ path: new URL(`../public/icons/${name}`, import.meta.url).pathname });
  await page.close();
}
await browser.close();
console.log('icons written');
