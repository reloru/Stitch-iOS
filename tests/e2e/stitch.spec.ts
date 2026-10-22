import { test, expect, type Page } from '@playwright/test';
import { photo, screenshots, SHOT } from './fixtures';


const SHOTS = process.env.SHOTS;
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function openShots(page: Page) {
  const { files, pageHeight, expected } = await screenshots();
  await page.goto('/');
  await page.getByTestId('pick-multi').setInputFiles(files.map((buffer, i) => ({ name: `shot${i + 1}.png`, mimeType: 'image/png', buffer })));
  await expect(page.locator('.topbar .title')).toHaveText('Stitch · 3');
  return { pageHeight, expected };
}

/** Number of pixels whose channels differ from the expected image by more than 2. */
function mismatches(got: { w: number; h: number; data: number[] }, expected: Uint8ClampedArray): number {
  expect(got.data.length).toBe(expected.length);
  let bad = 0;
  for (let i = 0; i < expected.length; i += 4)
    if (Math.abs(got.data[i] - expected[i]) > 2 || Math.abs(got.data[i + 1] - expected[i + 1]) > 2 || Math.abs(got.data[i + 2] - expected[i + 2]) > 2) bad++;
  return bad;
}

/** Decodes the exported preview image and returns rows of it as RGBA. */
async function exportedPixels(page: Page) {
  return page.getByTestId('export-preview').evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const x = c.getContext('2d')!;
    x.drawImage(img, 0, 0);
    return { w: c.width, h: c.height, data: Array.from(x.getImageData(0, 0, c.width, c.height).data) };
  });
}

test('auto-stitch scrolling screenshots into one seamless image', async ({ page }) => {
  const { pageHeight, expected } = await openShots(page);
  await shot(page, '10-stitch-raw');
  await page.getByTestId('auto-align').click();
  await expect(page.locator('.toast')).toHaveText('Screenshots aligned');
  await shot(page, '11-stitch-aligned');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('export-dims')).toContainText(`${SHOT.w} × ${pageHeight}`);
  await page.getByRole('button', { name: 'PNG' }).click();
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-info')).toContainText(`${SHOT.w} × ${pageHeight}`);
  const out = await exportedPixels(page);
  // pixel-exact reconstruction of the whole page: header once, content without duplicates, footer once
  expect(mismatches(out, expected)).toBe(0);
  await shot(page, '12-stitch-export');
});

test('oversized stitch is written as strips when the canvas limit is small (iOS emulation)', async ({ page }) => {
  // one screenshot (300×640) fits, the stitched result (300×1460) does not
  await page.addInitScript(() => {
    (globalThis as { __stitchLimits?: unknown }).__stitchLimits = { maxArea: 300 * 700, maxSide: 4096 };
  });
  const { pageHeight, expected } = await openShots(page);
  await page.getByTestId('auto-align').click();
  await expect(page.locator('.toast')).toHaveText('Screenshots aligned');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'PNG' }).click();
  await expect(page.getByTestId('export-dims')).toContainText('written in strips');
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-info')).toContainText(`${SHOT.w} × ${pageHeight}`);
  const tiled = await exportedPixels(page);
  expect(tiled.h).toBe(pageHeight);
  expect(mismatches(tiled, expected)).toBe(0);
});

test('grid layout, style and send to editor', async ({ page }) => {
  await page.goto('/');
  const p = await photo();
  await page.getByTestId('pick-multi').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: p },
    { name: 'b.png', mimeType: 'image/png', buffer: p },
    { name: 'c.png', mimeType: 'image/png', buffer: p },
  ]);
  await expect(page.locator('.topbar .title')).toHaveText('Stitch · 3');
  await page.getByRole('tab', { name: 'Layout' }).click();
  await page.getByRole('button', { name: 'Grid' }).click();
  await page.getByRole('tab', { name: 'Style' }).click();
  const gap = page.getByRole('slider', { name: 'Spacing', exact: true });
  await gap.evaluate((el) => {
    const i = el as HTMLInputElement;
    i.value = '20';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await shot(page, '13-grid');
  await page.getByRole('button', { name: 'Save' }).click();
  // 2 columns of square cells, 1600 px wide each (the widest photo), 20 px gap
  await expect(page.getByTestId('export-dims')).toContainText('3220 × 3220');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Edit result' }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.topbar .title')).toHaveText('3220 × 3220');
});
