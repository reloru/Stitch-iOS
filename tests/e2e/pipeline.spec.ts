import { test, expect, type Page } from '@playwright/test';
import { gradient } from './fixtures';

async function setRange(page: Page, label: string, value: number) {
  await page.getByRole('slider', { name: label, exact: true }).evaluate((el, v) => {
    const i = el as HTMLInputElement;
    i.value = String(v);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

const POINTS = [
  [0.2, 0.3],
  [0.5, 0.5],
  [0.8, 0.4],
  [0.35, 0.65],
  [0.65, 0.35],
];

async function adjustedPixels(page: Page, forceCPU: boolean): Promise<{ gl: boolean; px: number[][] }> {
  if (forceCPU) await page.addInitScript(() => ((globalThis as { __stitchForceCPU?: boolean }).__stitchForceCPU = true));
  await page.goto('/');
  await page.getByTestId('pick-one').setInputFiles({ name: 'g.png', mimeType: 'image/png', buffer: await gradient() });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  for (const [k, v] of [
    ['Exposure', 30],
    ['Contrast', 25],
    ['Highlights', -40],
    ['Shadows', 30],
    ['Warmth', 20],
    ['Tint', -15],
    ['Vibrance', 40],
    ['Fade', 20],
  ] as const)
    await setRange(page, k, v);
  await page.getByRole('tab', { name: 'Filters' }).click();
  await page.getByRole('button', { name: 'Chrome' }).click();
  await settle(page);
  return page.evaluate((pts) => {
    const c = document.querySelector('[data-testid=editor-canvas]') as HTMLCanvasElement;
    const x = c.getContext('2d')!;
    const px = pts.map(([fx, fy]) => Array.from(x.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data.slice(0, 3)));
    return { gl: !!(globalThis as { __stitchGL?: boolean }).__stitchGL, px };
  }, POINTS);
}

test('WebGL shader is used and matches the CPU fallback', async ({ browser }) => {
  const a = await browser.newPage();
  const hasWebGL2 = await a.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  const gpu = await adjustedPixels(a, false);
  if (hasWebGL2) expect(gpu.gl).toBe(true);
  const b = await browser.newPage();
  const cpu = await adjustedPixels(b, true);
  expect(cpu.gl).toBe(false);
  for (let i = 0; i < POINTS.length; i++)
    for (let ch = 0; ch < 3; ch++) expect(Math.abs(gpu.px[i][ch] - cpu.px[i][ch]), `point ${i} channel ${ch}`).toBeLessThanOrEqual(3);
  // and the adjustments did something
  const plain = await (async () => {
    const p = await browser.newPage();
    await p.goto('/');
    await p.getByTestId('pick-one').setInputFiles({ name: 'g.png', mimeType: 'image/png', buffer: await gradient() });
    await expect(p.getByTestId('editor-canvas')).toBeVisible();
    await settle(p);
    return p.evaluate(() => {
      const c = document.querySelector('[data-testid=editor-canvas]') as HTMLCanvasElement;
      return Array.from(c.getContext('2d')!.getImageData(Math.round(c.width * 0.5), Math.round(c.height * 0.5), 1, 1).data.slice(0, 3));
    });
  })();
  expect(Math.abs(plain[0] - gpu.px[1][0]) + Math.abs(plain[2] - gpu.px[1][2])).toBeGreaterThan(10);
});

/** Inserts an EXIF APP1 segment with the given orientation right after SOI. */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF header, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation SHORT
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = body.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, len >> 8, len & 0xff]), body]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

test('EXIF orientation is applied (portrait photo shot sideways)', async ({ page }) => {
  await page.goto('/');
  // 400×200 JPEG: red block in the stored top-left corner, blue elsewhere
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 200;
    const x = c.getContext('2d')!;
    x.fillStyle = '#2040e0';
    x.fillRect(0, 0, 400, 200);
    x.fillStyle = '#e02020';
    x.fillRect(0, 0, 100, 100);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.95));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const v of bytes) s += String.fromCharCode(v);
    return btoa(s);
  });
  const jpeg = withOrientation(Buffer.from(b64, 'base64'), 6); // 6 = rotate 90° clockwise to display
  await page.getByTestId('pick-one').setInputFiles({ name: 'portrait.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(page.locator('.topbar .title')).toHaveText('200 × 400');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-info')).toContainText('200 × 400');
  const [tl, tr] = await page.getByTestId('export-preview').evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const x = c.getContext('2d')!;
    x.drawImage(img, 0, 0);
    return [Array.from(x.getImageData(10, 10, 1, 1).data), Array.from(x.getImageData(190, 10, 1, 1).data)];
  });
  // after a clockwise quarter turn the stored top-left corner is at the top-right
  expect(tr[0]).toBeGreaterThan(180);
  expect(tr[2]).toBeLessThan(90);
  expect(tl[2]).toBeGreaterThan(180);
});
