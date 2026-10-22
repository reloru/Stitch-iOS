import { test, expect, type Page } from '@playwright/test';
import { overlay, photo } from './fixtures';
import { settle } from './util';

async function centre(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid=editor-canvas]') as HTMLCanvasElement;
    return Array.from(c.getContext('2d')!.getImageData(Math.round(c.width / 2), Math.round(c.height / 2), 1, 1).data);
  });
}

async function setRange(page: Page, label: string, value: number) {
  await page.getByRole('slider', { name: label, exact: true }).evaluate((el, v) => {
    const i = el as HTMLInputElement;
    i.value = String(v);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

const isYellow = (p: number[]) => p[0] > 200 && p[1] > 180 && p[2] < 90;
const isGrey = (p: number[]) => Math.abs(p[0] - p[1]) < 8 && Math.abs(p[1] - p[2]) < 8;

test('merge layers into one photo, edit it as a whole, undo to get the layers back', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('pick-one').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: await photo() });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await page.getByRole('tab', { name: 'Crop' }).click();
  await page.getByRole('button', { name: 'Square' }).click();
  await expect(page.locator('.topbar .title')).toHaveText('1200 × 1200');
  await page.getByRole('tab', { name: 'Overlay' }).click();
  await page.getByTestId('pick-layer').setInputFiles({ name: 'disc.png', mimeType: 'image/png', buffer: await overlay() });
  await expect(page.locator('.layer-chip.on')).toContainText('disc');
  await expect.poll(async () => isYellow(await centre(page))).toBe(true);

  // while layered, background adjustments leave the overlay alone
  await page.locator('.layer-chip', { hasText: 'Background' }).click();
  await page.getByRole('tab', { name: 'Adjust' }).click();
  await expect(page.getByTestId('merge-hint')).toBeVisible();
  await setRange(page, 'Saturation', -100);
  await settle(page);
  await expect.poll(async () => isYellow(await centre(page))).toBe(true);
  await page.getByRole('button', { name: 'Undo' }).click();

  await page.getByRole('tab', { name: 'Overlay' }).click();
  await page.getByTestId('merge-layers').click();
  await expect(page.locator('.toast')).toContainText('Merged into one photo');
  await expect(page.getByRole('tab', { name: 'Adjust' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.topbar .title')).toHaveText('1200 × 1200');
  await expect(page.getByTestId('merge-hint')).toHaveCount(0);
  await expect.poll(async () => isYellow(await centre(page))).toBe(true);

  // now the same adjustment changes everything, including what used to be the overlay
  await setRange(page, 'Saturation', -100);
  await expect.poll(async () => isGrey(await centre(page))).toBe(true);

  // the merged photo has no layers and a fresh, full crop
  await page.getByRole('tab', { name: 'Overlay' }).click();
  await expect(page.locator('.layer-chip')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Crop' }).click();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.locator('.topbar .title')).toHaveText('1200 × 1200');

  // undo back past the merge: layers return
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('tab', { name: 'Overlay' }).click();
  await expect(page.locator('.layer-chip', { hasText: 'disc' })).toBeVisible();
  await expect.poll(async () => isYellow(await centre(page))).toBe(true);
});
