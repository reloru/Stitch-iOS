import { test, expect, type Page } from '@playwright/test';
import { overlay, photo } from './fixtures';
import { settle } from './util';

const SHOTS = process.env.SHOTS;

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Reads a pixel of the editor's display canvas at a CSS-pixel position relative to the canvas. */
async function pixel(page: Page, fx: number, fy: number): Promise<number[]> {
  return page.evaluate(
    ([fx, fy]) => {
      const c = document.querySelector('[data-testid=editor-canvas]') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    },
    [fx, fy],
  );
}

async function setRange(page: Page, label: string, value: number) {
  const input = page.getByRole('slider', { name: label, exact: true });
  await input.evaluate((el, v) => {
    const i = el as HTMLInputElement;
    i.value = String(v);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}


async function openPhoto(page: Page) {
  await page.goto('/');
  await page.getByTestId('pick-one').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: await photo() });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.topbar .title')).toHaveText('1600 × 1200');
  await settle(page);
}

test('adjust, filters, crop, rotate, undo and export', async ({ page }) => {
  await openPhoto(page);
  await shot(page, '01-editor');

  // left half of the photo is red
  let p = await pixel(page, 0.25, 0.5);
  expect(p[0]).toBeGreaterThan(180);
  expect(p[2]).toBeLessThan(90);

  await setRange(page, 'Saturation', -100);
  await settle(page);
  p = await pixel(page, 0.25, 0.5);
  expect(Math.abs(p[0] - p[1])).toBeLessThan(6);
  expect(Math.abs(p[1] - p[2])).toBeLessThan(6);
  await shot(page, '02-desaturated');

  await page.getByRole('button', { name: 'Undo' }).click();
  await settle(page);
  p = await pixel(page, 0.25, 0.5);
  expect(p[0]).toBeGreaterThan(180);

  await page.getByRole('tab', { name: 'Filters' }).click();
  await page.getByRole('button', { name: 'Noir' }).click();
  await settle(page);
  p = await pixel(page, 0.75, 0.5);
  expect(Math.abs(p[0] - p[2])).toBeLessThan(6);
  await shot(page, '03-filters');

  await page.getByRole('tab', { name: 'Crop' }).click();
  await page.getByRole('button', { name: 'Rotate right' }).click();
  await expect(page.locator('.topbar .title')).toHaveText('1200 × 1600');
  await page.getByRole('button', { name: 'Square' }).click();
  await expect(page.locator('.topbar .title')).toHaveText('1200 × 1200');
  await setRange(page, 'Straighten', 10);
  await settle(page);
  await shot(page, '04-crop');
  const title = await page.locator('.topbar .title').textContent();
  const [cw] = title!.split(' × ').map(Number);
  expect(cw).toBeLessThan(1200);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.topbar .title')).toHaveText('1200 × 1200');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('export-dims')).toContainText('1200 × 1200');
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-info')).toContainText('1200 × 1200');
  await expect(page.getByTestId('export-info')).toContainText('JPEG');
  const nat = await page.getByTestId('export-preview').evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  });
  expect(nat).toEqual([1200, 1200]);
  await shot(page, '05-export');
});

test('overlay layer with blend mode, text layer and mask', async ({ page }) => {
  await openPhoto(page);
  await page.getByRole('tab', { name: 'Overlay' }).click();
  await page.getByTestId('pick-layer').setInputFiles({ name: 'disc.png', mimeType: 'image/png', buffer: await overlay() });
  await expect(page.locator('.layer-chip.on')).toContainText('disc');
  await settle(page);
  // disc is centred on the image; its centre covers the green square -> yellow
  let p = await pixel(page, 0.5, 0.5);
  expect(p[0]).toBeGreaterThan(200);
  expect(p[1]).toBeGreaterThan(180);
  expect(p[2]).toBeLessThan(90);
  await shot(page, '06-overlay');

  await page.getByRole('button', { name: 'Multiply' }).click();
  await settle(page);
  p = await pixel(page, 0.5, 0.5);
  // yellow × green = green-ish
  expect(p[0]).toBeLessThan(90);
  expect(p[1]).toBeGreaterThan(150);

  // drag the layer to the left
  const box = (await page.getByTestId('editor-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await settle(page);
  p = await pixel(page, 0.5, 0.5);
  expect(p[1]).toBeGreaterThan(150); // green square visible again (not multiplied)
  expect(p[0]).toBeLessThan(90);

  await page.getByTestId('add-text-layer').click();
  await page.getByTestId('text-input').fill('Hello');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.layer-chip.on')).toContainText('Hello');
  await settle(page);
  await shot(page, '07-text');

  // mask: hide part of the background photo with the brush
  await page.getByRole('tab', { name: 'Mask' }).click();
  await page.locator('.layer-chip', { hasText: 'Background' }).click();
  await page.getByRole('button', { name: 'Show mask overlay' }).click();
  await settle(page);
  // the dock is taller in Mask mode, so the canvas has a new size
  const mbox = (await page.getByTestId('editor-canvas').boundingBox())!;
  await page.mouse.move(mbox.x + mbox.width * 0.85, mbox.y + mbox.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(mbox.x + mbox.width * 0.85, mbox.y + mbox.height * 0.45, { steps: 8 });
  await page.mouse.up();
  await settle(page);
  p = await pixel(page, 0.85, 0.4);
  // transparent -> checkerboard grey shows through
  expect(Math.abs(p[0] - p[2])).toBeLessThan(8);
  expect(p[0]).toBeLessThan(80);
  await shot(page, '08-mask');

  // undo restores the mask pixels
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await pixel(page, 0.85, 0.4))[2]).toBeGreaterThan(180);

  // invert the mask -> whole background hidden, then export PNG keeps transparency
  await page.getByRole('button', { name: 'Invert' }).click();
  await settle(page);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'PNG' }).click();
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-info')).toContainText('PNG');
  const corner = await page.getByTestId('export-preview').evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const x = c.getContext('2d')!;
    x.drawImage(img, 0, 0);
    return Array.from(x.getImageData(5, 5, 1, 1).data);
  });
  expect(corner[3]).toBe(0);
});

test('top bar is a fixed, opaque, full-width edge bar that does not cover the canvas', async ({ page }) => {
  // iOS 26+ only skips its Liquid Glass top-edge blur when a fixed, opaque, full-width box covers the edge.
  await openPhoto(page);
  const bar = await page.locator('.topbar').evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { position: cs.position, bg: cs.backgroundColor, top: r.top, left: r.left, width: r.width, bottom: r.bottom };
  });
  expect(bar.position).toBe('fixed');
  expect(bar.bg).toBe('rgb(11, 11, 15)');
  expect(bar.top).toBe(0);
  expect(bar.left).toBe(0);
  expect(bar.width).toBe(430);
  const canvasTop = (await page.getByTestId('editor-canvas').boundingBox())!.y;
  expect(canvasTop).toBeGreaterThanOrEqual(bar.bottom - 1);
});
