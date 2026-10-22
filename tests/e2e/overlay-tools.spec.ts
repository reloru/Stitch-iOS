import { test, expect, type Page } from '@playwright/test';
import { encodePng } from '../../src/core/png';
import { gradient, photo } from './fixtures';
import { settle } from './util';


/** Pixel of the editor canvas at a world point of the 1600×1200 base photo (no crop, no zoom). */
async function worldPixel(page: Page, wx: number, wy: number): Promise<number[]> {
  return page.evaluate(
    ([wx, wy]) => {
      const c = document.querySelector('[data-testid=editor-canvas]') as HTMLCanvasElement;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const m = 16 * dpr;
      const k = Math.min((c.width - 2 * m) / 1600, (c.height - 2 * m) / 1200);
      const x = Math.round(c.width / 2 + (wx - 800) * k);
      const y = Math.round(c.height / 2 + (wy - 600) * k);
      return Array.from(c.getContext('2d')!.getImageData(x, y, 1, 1).data);
    },
    [wx, wy],
  );
}

/** Base photo + a 600×400 gradient overlay. The overlay lands centred at 1.6× (world x 320..1280, y 280..920). */
async function setup(page: Page) {
  await page.goto('/');
  await page.getByTestId('pick-one').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: await photo() });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await page.getByRole('tab', { name: 'Overlay' }).click();
  await page.getByTestId('pick-layer').setInputFiles({ name: 'grad.png', mimeType: 'image/png', buffer: await gradient() });
  await expect(page.locator('.layer-chip.on')).toContainText('grad');
  await settle(page);
}

const isBlue = (p: number[]) => p[2] > 180 && p[0] < 90;
const isRed = (p: number[]) => p[0] > 180 && p[2] < 90;
const isGradient = (p: number[]) => Math.abs(p[2] - 128) < 12;

test('remove background turns the returned cut-out into an undoable mask', async ({ page }) => {
  // 300×200 response (half the 600×400 upload): left half opaque subject, right half transparent background
  const w = 300;
  const h = 200;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4 + 3] = i % w < w / 2 ? 255 : 0;
  }
  const blob = await encodePng({ width: w, height: h, stripHeight: 64, rows: (y, n) => px.subarray(y * w * 4, (y + n) * w * 4) }, { alpha: true });
  const cutout = Buffer.from(await blob.arrayBuffer());
  const seen: { type?: string; origin?: string; size: number }[] = [];
  await page.route('**/api/remove-bg', async (route) => {
    const r = route.request();
    seen.push({ type: r.headers()['content-type'], origin: r.headers()['origin'], size: r.postDataBuffer()?.length ?? 0 });
    await route.fulfill({ status: 200, contentType: 'image/png', body: cutout });
  });

  await setup(page);
  await expect.poll(async () => isGradient(await worldPixel(page, 1000, 500))).toBe(true);
  await page.getByTestId('layer-removebg').click();
  await expect(page.getByText('This sends this photo to Cloudflare')).toBeVisible();
  await page.getByTestId('removebg-confirm').click();
  await expect(page.locator('.toast')).toContainText('Background removed');
  await settle(page);
  expect(seen).toHaveLength(1);
  expect(seen[0].type).toBe('image/jpeg');
  expect(seen[0].size).toBeGreaterThan(1000);
  // right half of the overlay is now transparent: the blue base shows through; left half is still the overlay
  await expect.poll(async () => isBlue(await worldPixel(page, 1000, 500))).toBe(true);
  await expect.poll(async () => isGradient(await worldPixel(page, 600, 500))).toBe(true);

  await page.getByRole('button', { name: 'Undo' }).click();
  await settle(page);
  await expect.poll(async () => isGradient(await worldPixel(page, 1000, 500))).toBe(true);

  // the notice is shown once; the second run goes straight to the request
  await page.getByRole('button', { name: 'Redo' }).click();
  await page.getByTestId('layer-removebg').click();
  await expect.poll(() => seen.length).toBe(2);
  await expect(page.locator('.busy')).toHaveCount(0);
});

test('remove background errors leave the photo unchanged and explain why', async ({ page }) => {
  await page.route('**/api/remove-bg', (route) =>
    route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'rate', message: 'Too many requests — try again in a minute' }) }),
  );
  await setup(page);
  await page.getByTestId('layer-removebg').click();
  await page.getByTestId('removebg-confirm').click();
  await expect(page.locator('.toast')).toContainText('Too many requests');
  await settle(page);
  await expect.poll(async () => isGradient(await worldPixel(page, 1000, 500))).toBe(true);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled(); // only the layer add is undoable
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
});

test('cropping an overlay keeps the visible part in place', async ({ page }) => {
  await setup(page);
  const centreBefore = await worldPixel(page, 800, 600);
  await expect.poll(async () => isGradient(await worldPixel(page, 400, 600))).toBe(true); // overlay source x ≈ 50
  await page.getByTestId('layer-crop').click();
  await expect(page.getByTestId('layer-crop-size')).toHaveText('600 × 400 px');
  await page.getByRole('button', { name: 'Square' }).click();
  await expect(page.getByTestId('layer-crop-size')).toHaveText('400 × 400 px');
  await page.getByTestId('layer-crop-done').click();
  await settle(page);
  // the cropped-away left strip now shows the red base; the overlay centre has not moved
  await expect.poll(async () => isRed(await worldPixel(page, 400, 600))).toBe(true);
  const centreAfter = await worldPixel(page, 800, 600);
  for (let c = 0; c < 3; c++) expect(Math.abs(centreAfter[c] - centreBefore[c])).toBeLessThan(6);
  await page.getByRole('button', { name: 'Undo' }).click();
  await settle(page);
  await expect.poll(async () => isGradient(await worldPixel(page, 400, 600))).toBe(true);
});

test('undo and redo sit directly below the picture', async ({ page }) => {
  await setup(page);
  const canvas = (await page.getByTestId('editor-canvas').boundingBox())!;
  const undo = (await page.getByRole('button', { name: 'Undo' }).boundingBox())!;
  const tabs = (await page.getByRole('tablist').boundingBox())!;
  expect(undo.y).toBeGreaterThanOrEqual(canvas.y + canvas.height - 1);
  expect(undo.y).toBeLessThan(canvas.y + canvas.height + 60);
  expect(undo.y + undo.height).toBeLessThan(tabs.y);
});
