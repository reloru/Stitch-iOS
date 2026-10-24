import { test, expect, type Page } from '@playwright/test';
import { gradient, overlay, photo } from './fixtures';
import { setRange, settle } from './util';

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

for (const tool of ['Brush', 'Color', 'Erase'] as const) {
  test(`double-tap in ${tool === 'Erase' ? 'Erase' : `Mask (${tool})`} zooms and leaves the photo alone`, async ({ page }) => {
    await openPhoto(page);
    if (tool === 'Erase') await page.getByRole('tab', { name: 'Erase' }).click();
    else {
      await page.getByRole('tab', { name: 'Mask' }).click();
      await page.getByRole('button', { name: tool }).click();
    }
    await settle(page);
    const { x, y } = await canvasCentre(page);
    // 0.4 across is red before zooming; at 2.5× about the centre the green square reaches it
    expect(isGreen(await pixel(page, 0.4, 0.5))).toBe(false);
    await doubleTap(page, x, y);
    await page.waitForTimeout(500);
    await settle(page);
    await expect(page.locator('.busy')).toHaveCount(0);
    expect(await undoDepth(page)).toBe(0);
    if (tool === 'Erase') await expect(page.getByTestId('erase-remove')).toBeDisabled();
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
  for (const tab of ['Adjust', 'Filters', 'Crop', 'Overlay', 'Mask', 'Erase']) {
    await page.getByRole('tab', { name: tab }).click();
    expect(await small(), tab).toEqual([]);
  }
});

test('tapping a slider value resets it', async ({ page }) => {
  await openPhoto(page);
  await setRange(page, 'Contrast', 40);
  const s = page.getByRole('slider', { name: 'Contrast', exact: true });
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

test('the picture keeps one size across every tool and panel state (430 and 375 pt wide)', async ({ page }) => {
  for (const width of [430, 375]) {
    await page.setViewportSize({ width, height: width === 430 ? 932 : 667 });
    await openPhoto(page);
    const heights = new Map<string, number>();
    const record = async (label: string) => {
      await settle(page);
      heights.set(label, Math.round((await page.locator('.stage').boundingBox())!.height));
    };
    for (const tab of ['Adjust', 'Filters', 'Crop']) {
      await page.getByRole('tab', { name: tab }).click();
      await record(tab);
    }
    await page.getByRole('tab', { name: 'Overlay' }).click();
    await record('Overlay, background');
    await page.getByTestId('pick-layer').setInputFiles({ name: 'disc.png', mimeType: 'image/png', buffer: await overlay() });
    await record('Overlay, photo layer');
    for (const sub of ['Opacity', 'Blend', 'Arrange']) {
      await page.getByRole('button', { name: sub, exact: true }).click();
      await record(`Overlay, ${sub}`);
    }
    await page.getByTestId('add-text-layer').click();
    await page.getByRole('button', { name: 'Done' }).click();
    for (const sub of ['Edit', 'Font', 'Colour', 'Style']) {
      await page.getByRole('button', { name: sub, exact: true }).click();
      await record(`Overlay, text ${sub}`);
    }
    await page.getByRole('tab', { name: 'Adjust' }).click();
    await record('Adjust with layer chip');
    await page.getByRole('tab', { name: 'Mask' }).click();
    for (const t of ['Brush', 'Linear', 'Radial', 'Color']) {
      await page.getByRole('button', { name: t, exact: true }).click();
      await record(`Mask ${t}`);
    }
    await page.getByTestId('mask-actions').click();
    await record('Mask actions');
    await page.getByRole('tab', { name: 'Erase' }).click();
    await record('Erase');
    const values = [...heights.values()];
    expect(new Set(values).size, JSON.stringify(Object.fromEntries(heights))).toBe(1);
    // and it is the larger part of the screen
    expect(values[0]).toBeGreaterThan((width === 430 ? 932 : 667) * (width === 430 ? 0.5 : 0.4));
    // the layer chip under the picture fits beside the bar buttons (Erase always edits the background: no chip)
    await expect(page.getByTestId('target-chip')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Mask' }).click();
    const bar = (await page.locator('.editbar').boundingBox())!;
    const chip = (await page.getByTestId('target-chip').boundingBox())!;
    expect(chip.x + chip.width).toBeLessThanOrEqual(bar.x + bar.width);
    expect(chip.height).toBeGreaterThanOrEqual(44);
  }
});

test('changing the brush size shows the brush outline on the picture', async ({ page }) => {
  await openPhoto(page);
  await page.getByRole('tab', { name: 'Mask' }).click();
  await settle(page);
  // a point on the outline of a 60 pt brush centred in the picture
  const ring = async () =>
    page.evaluate(() => {
      const c = document.querySelector('[data-testid=editor-canvas]') as HTMLCanvasElement;
      const dpr = c.width / c.getBoundingClientRect().width;
      const d = c.getContext('2d')!.getImageData(Math.round(c.width / 2 + 60 * dpr), Math.round(c.height / 2), 1, 1).data;
      return d[0] + d[1] + d[2];
    });
  const before = await ring();
  await setRange(page, 'Size', 60, false);
  await settle(page);
  expect(await ring()).toBeGreaterThan(before + 150);
  await page.waitForTimeout(1100);
  await settle(page);
  expect(Math.abs((await ring()) - before)).toBeLessThan(30);
});

test('hold-to-compare hides adjustments on overlay photos too', async ({ page }) => {
  await openPhoto(page);
  await page.getByRole('tab', { name: 'Overlay' }).click();
  await page.getByTestId('pick-layer').setInputFiles({ name: 'disc.png', mimeType: 'image/png', buffer: await overlay() });
  await page.getByRole('tab', { name: 'Adjust' }).click();
  await expect(page.getByTestId('target-chip')).toContainText('disc');
  await setRange(page, 'Saturation', -100);
  const yellow = (p: number[]) => p[0] > 200 && p[1] > 180 && p[2] < 90;
  await expect.poll(async () => yellow(await pixel(page, 0.5, 0.5))).toBe(false);
  const eye = (await page.getByRole('button', { name: 'Hold to compare without adjustments' }).boundingBox())!;
  await page.mouse.move(eye.x + eye.width / 2, eye.y + eye.height / 2);
  await page.mouse.down();
  await expect.poll(async () => yellow(await pixel(page, 0.5, 0.5))).toBe(true);
  await page.mouse.up();
  await expect.poll(async () => yellow(await pixel(page, 0.5, 0.5))).toBe(false);
});
