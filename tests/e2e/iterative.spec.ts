import { test, expect, type Page } from '@playwright/test';
import { photo } from './fixtures';
import { setRange } from './util';

/** Left half of the photo is pure-ish red; returns red minus blue at that spot (a saturation measure). */
async function redSpread(page: Page): Promise<number> {
  const p = await page.evaluate(() => {
    const c = document.querySelector('[data-testid=editor-canvas]') as HTMLCanvasElement;
    return Array.from(c.getContext('2d')!.getImageData(Math.round(c.width * 0.2), Math.round(c.height * 0.5), 1, 1).data);
  });
  return p[0] - p[2];
}

const title = (page: Page) => page.locator('.topbar .title');

async function open(page: Page) {
  await page.goto('/');
  await page.getByTestId('pick-one').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: await photo() });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect.poll(() => redSpread(page)).toBeGreaterThan(150);
}

test('✓ keeps and ✗ cancels only the current tool’s changes', async ({ page }) => {
  await open(page);
  const keep = page.getByTestId('tool-keep');
  const cancel = page.getByTestId('tool-cancel');
  await expect(keep).toBeDisabled();
  await expect(cancel).toBeDisabled();
  const s0 = await redSpread(page);

  // ✗ throws away this tool's changes
  await setRange(page, 'Saturation', -60);
  await setRange(page, 'Contrast', 30);
  await expect(cancel).toBeEnabled();
  await expect.poll(() => redSpread(page)).toBeLessThan(s0 - 40);
  await cancel.click();
  await expect(cancel).toBeDisabled();
  await expect(page.getByRole('slider', { name: 'Contrast', exact: true })).toHaveValue('0');
  await expect.poll(async () => Math.abs((await redSpread(page)) - s0)).toBeLessThan(4);

  // ✓ keeps them, and they stay editable (nothing is baked in)
  await setRange(page, 'Saturation', -60);
  await keep.click();
  await expect(keep).toBeDisabled();
  await expect(page.getByRole('slider', { name: 'Saturation', exact: true })).toHaveValue('-60');
  const s1 = await redSpread(page);

  // ✗ in Crop undoes the crop only, not the earlier adjustment
  await page.getByRole('tab', { name: 'Crop' }).click();
  await expect(cancel).toBeDisabled();
  await page.getByRole('button', { name: 'Square' }).click();
  await page.getByRole('button', { name: 'Rotate right' }).click();
  await expect(title(page)).toHaveText('1200 × 1200');
  await cancel.click();
  await expect(title(page)).toHaveText('1600 × 1200');
  await page.getByRole('tab', { name: 'Adjust' }).click();
  await expect(page.getByRole('slider', { name: 'Saturation', exact: true })).toHaveValue('-60');
  await expect.poll(async () => Math.abs((await redSpread(page)) - s1)).toBeLessThan(4);

  // switching tools keeps changes; undoing past the session start moves the start back (✗ stays harmless)
  await setRange(page, 'Exposure', 40);
  await page.getByRole('tab', { name: 'Filters' }).click();
  await expect(cancel).toBeDisabled();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(cancel).toBeDisabled();
  await page.getByRole('tab', { name: 'Adjust' }).click();
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toHaveValue('0');
  await expect(page.getByRole('slider', { name: 'Saturation', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Saturation', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Saturation', exact: true })).toHaveValue('-60');
});

test('Flatten bakes edits losslessly so the next ones stack', async ({ page }) => {
  await open(page);
  const s0 = await redSpread(page);
  await setRange(page, 'Saturation', -50);
  await expect.poll(() => redSpread(page)).toBeLessThan(s0 - 40);
  const s1 = await redSpread(page);
  await page.getByTestId('flatten').click();
  await expect(page.locator('.toast')).toContainText('Flattened');
  await expect(page.getByRole('slider', { name: 'Saturation', exact: true })).toHaveValue('0');
  await expect.poll(async () => Math.abs((await redSpread(page)) - s1)).toBeLessThan(4);
  await setRange(page, 'Saturation', -50);
  await expect.poll(() => redSpread(page)).toBeLessThan(s1 - 20);

  // crop the flattened photo, flatten, and crop the result again
  await page.getByRole('tab', { name: 'Crop' }).click();
  await page.getByRole('button', { name: 'Square' }).click();
  await expect(title(page)).toHaveText('1200 × 1200');
  await page.getByRole('tab', { name: 'Adjust' }).click();
  await page.getByTestId('flatten').click();
  await expect(page.locator('.toast')).toContainText('Flattened');
  await page.getByRole('tab', { name: 'Crop' }).click();
  await page.getByRole('button', { name: '4:5' }).click();
  await expect(title(page)).toHaveText('960 × 1200');
  await page.getByRole('button', { name: 'Reset', exact: true }).click(); // resets to the flattened photo
  await expect(title(page)).toHaveText('1200 × 1200');

  // Undo steps back across a flatten
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Undo' }).click();
  await expect(title(page)).toHaveText('1200 × 1200');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(title(page)).toHaveText('1600 × 1200');
});
