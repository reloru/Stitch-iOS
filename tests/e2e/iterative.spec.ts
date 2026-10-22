import { test, expect, type Page } from '@playwright/test';
import { photo } from './fixtures';

/** Left half of the photo is pure-ish red; returns red minus blue at that spot (a saturation measure). */
async function redSpread(page: Page): Promise<number> {
  const p = await page.evaluate(() => {
    const c = document.querySelector('[data-testid=editor-canvas]') as HTMLCanvasElement;
    return Array.from(c.getContext('2d')!.getImageData(Math.round(c.width * 0.2), Math.round(c.height * 0.5), 1, 1).data);
  });
  return p[0] - p[2];
}

async function brightness(page: Page): Promise<number> {
  const p = await page.evaluate(() => {
    const c = document.querySelector('[data-testid=editor-canvas]') as HTMLCanvasElement;
    return Array.from(c.getContext('2d')!.getImageData(Math.round(c.width * 0.8), Math.round(c.height * 0.5), 1, 1).data);
  });
  return p[0] + p[1] + p[2];
}

async function setRange(page: Page, label: string, value: number) {
  await page.getByRole('slider', { name: label, exact: true }).evaluate((el, v) => {
    const i = el as HTMLInputElement;
    i.value = String(v);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

const title = (page: Page) => page.locator('.topbar .title');

test('✓ applies edits so the next ones stack; ✗ discards unapplied edits', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('pick-one').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: await photo() });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  const apply = page.getByTestId('apply');
  const discard = page.getByTestId('discard');
  await expect(apply).toBeDisabled();
  await expect(discard).toBeDisabled();

  // two rounds of -50 saturation stack
  await expect.poll(() => redSpread(page)).toBeGreaterThan(150);
  const s0 = await redSpread(page);
  await setRange(page, 'Saturation', -50);
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.locator('.toast')).toContainText('Applied');
  await expect(page.getByRole('slider', { name: 'Saturation', exact: true })).toHaveValue('0');
  await expect(apply).toBeDisabled();
  await expect.poll(() => redSpread(page)).toBeLessThan(s0 - 40);
  const s1 = await redSpread(page);
  await setRange(page, 'Saturation', -50);
  await apply.click();
  await expect(apply).toBeDisabled();
  await expect.poll(() => redSpread(page)).toBeLessThan(s1 - 20);

  // crop, apply, crop the result again
  await page.getByRole('tab', { name: 'Crop' }).click();
  await page.getByRole('button', { name: 'Square' }).click();
  await expect(title(page)).toHaveText('1200 × 1200');
  await apply.click();
  await expect(apply).toBeDisabled();
  await page.getByRole('button', { name: '4:5' }).click();
  await expect(title(page)).toHaveText('960 × 1200');
  await apply.click();
  await expect(apply).toBeDisabled();
  await page.getByRole('button', { name: 'Reset', exact: true }).click(); // resets to the applied photo, not the original
  await expect(title(page)).toHaveText('960 × 1200');

  // ✗ throws away edits since the last ✓
  await page.getByRole('tab', { name: 'Adjust' }).click();
  await expect.poll(() => brightness(page)).toBeGreaterThan(0);
  const b0 = await brightness(page);
  await setRange(page, 'Exposure', 80);
  await setRange(page, 'Contrast', 40);
  await expect.poll(() => brightness(page)).toBeGreaterThan(b0 + 30);
  await discard.click();
  await expect(discard).toBeDisabled();
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toHaveValue('0');
  await expect.poll(async () => Math.abs((await brightness(page)) - b0)).toBeLessThan(4);

  // Undo still steps back across an apply
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(apply).toBeEnabled();
});
