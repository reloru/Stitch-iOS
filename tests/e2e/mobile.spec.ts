import { test, expect, type Page } from '@playwright/test';
import { gradient, overlay, photo } from './fixtures';
import { settle } from './util';

/** Regression tests for phone-specific behaviour: gestures, hints, sheets, touch target sizes. */

async function openPhoto(page: Page) {
  await page.goto('/');
  await page.getByTestId('pick-one').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: await photo() });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await settle(page);
}

/** Number of available Undo steps (undoes them all, then redoes them back). */
async function undoDepth(page: Page): Promise<number> {
  const undo = page.getByRole('button', { name: 'Undo' });
  let n = 0;
  while ((await undo.isEnabled()) && n < 30) {
    await undo.click();
    n++;
  }
  for (let i = 0; i < n; i++) await page.getByRole('button', { name: 'Redo' }).click();
  return n;
}

async function pixel(page: Page, fx: number, fy: number): Promise<number[]> {
  return page.evaluate(
    ([fx, fy]) => {
      const c = document.querySelector('[data-testid=editor-canvas]') as HTMLCanvasElement;
      return Array.from(c.getContext('2d')!.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data);
    },
    [fx, fy],
  );
}

const isGreen = (p: number[]) => p[1] > 150 && p[0] < 90 && p[2] < 120;

async function doubleTap(page: Page, x: number, y: number) {
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(60);
  await page.touchscreen.tap(x, y);
}

async function canvasCentre(page: Page) {
  const b = (await page.getByTestId('editor-canvas').boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
}

for (const tool of ['Brush', 'Color'] as const) {
  test(`double-tap in Mask (${tool}) zooms and leaves the photo alone`, async ({ page }) => {
    await openPhoto(page);
    await page.getByRole('tab', { name: 'Mask' }).click();
    await page.getByRole('button', { name: tool }).click();
    await settle(page);
    const { x, y } = await canvasCentre(page);
    // 0.4 across is red before zooming; at 2.5× about the centre the green square reaches it
    expect(isGreen(await pixel(page, 0.4, 0.5))).toBe(false);
    await doubleTap(page, x, y);
    await page.waitForTimeout(500);
    await settle(page);
    await expect(page.locator('.busy')).toHaveCount(0);
    expect(await undoDepth(page)).toBe(0);
    await expect.poll(async () => isGreen(await pixel(page, 0.4, 0.5))).toBe(true);
  });
}

test('a single tap in Mask still edits once the double-tap window has passed', async ({ page }) => {
  await openPhoto(page);
  await page.getByRole('tab', { name: 'Mask' }).click();
  await settle(page);
  const { x, y } = await canvasCentre(page);
  await page.touchscreen.tap(x - 100, y);
  await page.waitForTimeout(500);
  expect(await undoDepth(page)).toBe(1);
  await page.getByRole('button', { name: 'Color' }).click();
  await page.touchscreen.tap(x + 100, y);
  await page.waitForTimeout(500);
  await expect(page.locator('.busy')).toHaveCount(0);
  expect(await undoDepth(page)).toBe(2);
});

test('crop drags do not re-render the uncropped picture', async ({ page }) => {
  await openPhoto(page);
  await page.getByRole('tab', { name: 'Crop' }).click();
  await settle(page);
  await page.evaluate(() => {
    const w = window as unknown as { __renders: number };
    w.__renders = 0;
    const orig = CanvasRenderingContext2D.prototype.clearRect;
    // renderDoc() starts with clearRect on the offscreen composite
    CanvasRenderingContext2D.prototype.clearRect = function (...a: [number, number, number, number]) {
      if (!this.canvas.isConnected) w.__renders++;
      return orig.apply(this, a);
    };
  });
  const { x, y } = await canvasCentre(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 3, y: y + i * 2 }] });
    await settle(page);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await settle(page);
  expect(await page.evaluate(() => (window as unknown as { __renders: number }).__renders)).toBe(0);
  // the straighten slider does not need it either
  await page.getByRole('slider', { name: 'Straighten', exact: true }).evaluate((el) => {
    const i = el as HTMLInputElement;
    i.value = '5';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(page);
  expect(await page.evaluate(() => (window as unknown as { __renders: number }).__renders)).toBe(0);
});

test('hints get out of the way after the first touch', async ({ page }) => {
  await openPhoto(page);
  await page.getByRole('tab', { name: 'Crop' }).click();
  const hint = page.locator('.stage .hint');
  await expect(hint).not.toHaveClass(/gone/);
  const { x, y } = await canvasCentre(page);
  await page.touchscreen.tap(x, y);
  await expect(hint).toHaveClass(/gone/);
  // narrow phones: the hint wraps inside the picture instead of running off the edges
  await page.setViewportSize({ width: 320, height: 700 });
  await page.getByRole('tab', { name: 'Mask' }).click();
  const r = (await page.locator('.stage .hint').boundingBox())!;
  expect(r.x).toBeGreaterThanOrEqual(10);
  expect(r.x + r.width).toBeLessThanOrEqual(310);
});

test('sheets holding work do not close on a stray tap above them', async ({ page }) => {
  await openPhoto(page);
  // export result sheet
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-preview')).toBeVisible();
  await page.mouse.click(215, 80);
  await expect(page.getByTestId('export-preview')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('export-preview')).toHaveCount(0);
});

test('controls are at least 44 pt tall', async ({ page }) => {
  await openPhoto(page);
  const small = async () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.chip, .btn, .tb-btn, .icon-btn, .tab, .slider .val'))
        .map((e) => ({ t: (e.textContent || e.getAttribute('aria-label') || e.className).trim(), h: e.getBoundingClientRect().height }))
        .filter((x) => x.h > 0 && x.h < 43.5),
    );
  for (const tab of ['Adjust', 'Filters', 'Crop', 'Overlay', 'Mask']) {
    await page.getByRole('tab', { name: tab }).click();
    expect(await small(), tab).toEqual([]);
  }
});

test('tapping a slider value resets it', async ({ page }) => {
  await openPhoto(page);
  const s = page.getByRole('slider', { name: 'Contrast', exact: true });
  await s.evaluate((el) => {
    const i = el as HTMLInputElement;
    i.value = '40';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(s).toHaveValue('40');
  await page.getByRole('button', { name: 'Reset Contrast' }).click();
  await expect(s).toHaveValue('0');
});

test('the overlay crop sheet survives a stray tap above it', async ({ page }) => {
  await openPhoto(page);
  await page.getByRole('tab', { name: 'Overlay' }).click();
  await page.getByTestId('pick-layer').setInputFiles({ name: 'disc.png', mimeType: 'image/png', buffer: await overlay() });
  await page.getByTestId('layer-crop').click();
  await page.getByRole('button', { name: 'Square' }).click();
  await page.mouse.click(215, 80);
  await expect(page.getByTestId('layer-crop-canvas')).toBeVisible();
  await page.getByTestId('layer-crop-done').click();
  await expect(page.getByTestId('layer-crop-canvas')).toHaveCount(0);
});

test('stitch: hold a thumbnail and drag it to reorder; a quick tap still selects', async ({ page }) => {
  await page.goto('/');
  const files = await Promise.all([photo(), gradient(), overlay()]);
  await page.getByTestId('pick-multi').setInputFiles(files.map((buffer, i) => ({ name: `p${i + 1}.png`, mimeType: 'image/png', buffer })));
  await expect(page.locator('.topbar .title')).toHaveText('Stitch · 3');
  const thumbs = page.locator('.strip-item img');
  const srcs = async () => thumbs.evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src));
  const before = await srcs();
  const first = (await page.getByRole('button', { name: 'Photo 1' }).boundingBox())!;
  const third = (await page.getByRole('button', { name: 'Photo 3' }).boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const y = first.y + first.height / 2;
  await touch('touchStart', first.x + first.width / 2, y);
  await page.waitForTimeout(500);
  for (let i = 1; i <= 8; i++) await touch('touchMove', first.x + first.width / 2 + ((third.x - first.x) * i) / 8, y);
  await touch('touchEnd', 0, 0);
  await expect.poll(srcs).toEqual([before[1], before[2], before[0]]);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(srcs).toEqual(before);
  // a quick tap selects (shows the trim controls)
  await page.getByRole('button', { name: 'Photo 2' }).tap();
  await expect(page.getByRole('button', { name: 'Remove photo' })).toBeVisible();
});
