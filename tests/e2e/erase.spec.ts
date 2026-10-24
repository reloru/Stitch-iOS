import { test, expect, type Page, type Route } from '@playwright/test';
import { encodePng } from '../../src/core/png';
import { photo } from './fixtures';
import { settle } from './util';

/**
 * Erase (object removal). The real model is never called: /api/inpaint is intercepted and answers with a patch whose
 * left half is opaque magenta and right half transparent, so placement and alpha compositing can be checked exactly.
 */

/** Pixel of the editor canvas at a world point of the 1600×1200 photo (no crop, no zoom, unrotated). */
async function worldPixel(page: Page, wx: number, wy: number, w = 1600, h = 1200): Promise<number[]> {
  return page.evaluate(
    ([wx, wy, w, h]) => {
      const c = document.querySelector('[data-testid=editor-canvas]') as HTMLCanvasElement;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const m = 16 * dpr;
      const k = Math.min((c.width - 2 * m) / w, (c.height - 2 * m) / h);
      const x = Math.round(c.width / 2 + (wx - w / 2) * k);
      const y = Math.round(c.height / 2 + (wy - h / 2) * k);
      return Array.from(c.getContext('2d')!.getImageData(x, y, 1, 1).data);
    },
    [wx, wy, w, h],
  );
}

const isMagenta = (p: number[]) => p[0] > 200 && p[1] < 60 && p[2] > 200;
const isRed = (p: number[]) => p[0] > 180 && p[1] < 80 && p[2] < 90;
const isBlue = (p: number[]) => p[2] > 180 && p[0] < 90;

/** width/height of every PNG in a byte buffer (multipart body) */
function pngSizes(buf: Buffer): { w: number; h: number }[] {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const out: { w: number; h: number }[] = [];
  for (let i = buf.indexOf(sig); i >= 0; i = buf.indexOf(sig, i + 8)) out.push({ w: buf.readUInt32BE(i + 16), h: buf.readUInt32BE(i + 20) });
  return out;
}

async function halfPatch(w: number, h: number): Promise<Buffer> {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i] = 255;
      px[i + 2] = 255;
      px[i + 3] = x < w / 2 ? 255 : 0;
    }
  const blob = await encodePng({ width: w, height: h, stripHeight: 128, rows: (y, n) => px.subarray(y * w * 4, (y + n) * w * 4) }, { alpha: true });
  return Buffer.from(await blob.arrayBuffer());
}

function mockInpaint(page: Page) {
  const seen: { w: number; h: number }[][] = [];
  void page.route('**/api/inpaint', async (route: Route) => {
    const sizes = pngSizes(route.request().postDataBuffer()!);
    seen.push(sizes);
    await route.fulfill({ status: 200, contentType: 'image/png', body: await halfPatch(sizes[0].w, sizes[0].h) });
  });
  return seen;
}

async function open(page: Page) {
  await page.goto('/');
  await page.getByTestId('pick-one').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: await photo() });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await page.getByRole('tab', { name: 'Erase' }).click();
  await settle(page);
}

/** Paints a short stroke around the picture centre with the mouse. */
async function paintCentre(page: Page) {
  const b = (await page.getByTestId('editor-canvas').boundingBox())!;
  await page.mouse.move(b.x + b.width / 2 - 10, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 10, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  await settle(page);
}

async function remove(page: Page) {
  await page.getByTestId('erase-remove').click();
  const confirm = page.getByTestId('erase-confirm');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(page.locator('.toast')).toContainText('Removed');
  await settle(page);
}

test('removes the painted object through the patch alpha, only around it; Undo and autosave', async ({ page }) => {
  const seen = mockInpaint(page);
  await open(page);
  const remove_ = page.getByTestId('erase-remove');
  await expect(remove_).toBeDisabled();
  await paintCentre(page);
  await expect(remove_).toBeEnabled();
  // before: red left of centre, blue right of centre
  expect(isRed(await worldPixel(page, 650, 600))).toBe(true);
  await remove_.click();
  await expect(page.getByText('This sends the area around what you painted to Cloudflare')).toBeVisible();
  await page.getByTestId('erase-confirm').click();
  await expect(page.locator('.toast')).toContainText('Removed');
  await settle(page);

  // a small object goes up as a 512 px square at native resolution, with a mask of the same size
  expect(seen).toHaveLength(1);
  expect(seen[0]).toEqual([
    { w: 512, h: 512 },
    { w: 512, h: 512 },
  ]);
  // the crop is centred on the stroke (world ~800,600): its opaque left half covers 544..800, its right half is clear
  await expect.poll(async () => isMagenta(await worldPixel(page, 650, 600))).toBe(true);
  expect(isBlue(await worldPixel(page, 950, 600))).toBe(true);
  expect(isRed(await worldPixel(page, 300, 600))).toBe(true);
  // the selection is gone with the old photo
  await expect(remove_).toBeDisabled();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => isRed(await worldPixel(page, 650, 600))).toBe(true);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(async () => isMagenta(await worldPixel(page, 650, 600))).toBe(true);

  // the result is part of the autosaved edit
  await page.waitForTimeout(1500);
  await page.reload();
  await page.getByTestId('home-resume').click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await settle(page);
  await expect.poll(async () => isMagenta(await worldPixel(page, 650, 600))).toBe(true);
});

test('Undo in Erase steps back through selection strokes before touching the photo', async ({ page }) => {
  mockInpaint(page);
  await open(page);
  await page.getByRole('button', { name: 'Undo' }).isDisabled();
  await paintCentre(page);
  await expect(page.getByTestId('erase-remove')).toBeEnabled();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('erase-remove')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(page.getByTestId('erase-remove')).toBeEnabled();
  // ✗ clears the selection
  await page.getByTestId('tool-cancel').click();
  await expect(page.getByTestId('erase-remove')).toBeDisabled();
});

test('works on a rotated photo: the patch lands where it was painted', async ({ page }) => {
  mockInpaint(page);
  await open(page);
  await page.getByRole('tab', { name: 'Crop' }).click();
  await page.getByRole('button', { name: 'Rotate right' }).click();
  await expect(page.locator('.topbar .title')).toHaveText('1200 × 1600');
  await page.getByRole('tab', { name: 'Erase' }).click();
  await settle(page);
  await paintCentre(page);
  await remove(page);
  // rotated world is 1200×1600; the opaque half of the patch is the left half in *source* px, which after a
  // clockwise quarter turn is the top half on screen
  await expect.poll(async () => isMagenta(await worldPixel(page, 600, 700, 1200, 1600))).toBe(true);
  expect(isMagenta(await worldPixel(page, 600, 900, 1200, 1600))).toBe(false);
});

test('a failed removal leaves the photo unchanged and says why', async ({ page }) => {
  await page.route('**/api/inpaint', (route) =>
    route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'upstream', message: 'Removing the object failed — try again' }) }),
  );
  await open(page);
  await paintCentre(page);
  await page.getByTestId('erase-remove').click();
  await page.getByTestId('erase-confirm').click();
  await expect(page.locator('.toast')).toContainText('failed');
  await settle(page);
  expect(isRed(await worldPixel(page, 650, 600))).toBe(true);
  // the selection is kept for another try
  await expect(page.getByTestId('erase-remove')).toBeEnabled();
});

test('while the eraser starts up, the app shows progress and retries until it is ready', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/inpaint', async (route) => {
    calls++;
    if (calls <= 2) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'starting', message: 'The eraser is still starting up — try again in a moment' }) });
      return;
    }
    const sizes = pngSizes(route.request().postDataBuffer()!);
    await route.fulfill({ status: 200, contentType: 'image/png', body: await halfPatch(sizes[0].w, sizes[0].h) });
  });
  await open(page);
  await paintCentre(page);
  await page.getByTestId('erase-remove').click();
  await page.getByTestId('erase-confirm').click();
  await expect(page.locator('.busy')).toContainText('Starting the eraser');
  await expect(page.locator('.toast')).toContainText('Removed', { timeout: 20_000 });
  expect(calls).toBe(3);
  await settle(page);
  await expect.poll(async () => isMagenta(await worldPixel(page, 650, 600))).toBe(true);
});
