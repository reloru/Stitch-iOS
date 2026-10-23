import { test, expect, type Page } from '@playwright/test';
import { gradient, overlay, photo } from './fixtures';
import { editLayer, setRange, settle } from './util';

/** Autosave: the open edit survives the page being closed and reopened (iOS closing a backgrounded app). */

async function pixel(page: Page, fx: number, fy: number): Promise<number[]> {
  return page.evaluate(
    ([fx, fy]) => {
      const c = document.querySelector('[data-testid=editor-canvas]') as HTMLCanvasElement;
      return Array.from(c.getContext('2d')!.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data);
    },
    [fx, fy],
  );
}

const isGrey = (p: number[]) => Math.abs(p[0] - p[1]) < 10 && Math.abs(p[1] - p[2]) < 10 && p[0] > 60;
const isYellow = (p: number[]) => p[0] > 200 && p[1] > 180 && p[2] < 90;
/** transparent: the dark checkerboard shows through */
const isClear = (p: number[]) => Math.abs(p[0] - p[2]) < 8 && p[0] < 80;

test('an edit with layers and a mask comes back after the app is closed', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('home-resume')).toHaveCount(0);
  await page.getByTestId('pick-one').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: await photo() });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await setRange(page, 'Saturation', -100);
  await page.getByRole('tab', { name: 'Overlay' }).click();
  await page.getByTestId('pick-layer').setInputFiles({ name: 'disc.png', mimeType: 'image/png', buffer: await overlay() });
  await page.getByRole('tab', { name: 'Mask' }).click();
  await editLayer(page, 'Background');
  await page.getByRole('button', { name: 'Show mask overlay' }).click();
  await settle(page);
  const box = (await page.getByTestId('editor-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.45, { steps: 8 });
  await page.mouse.up();
  await settle(page);
  const check = async () => {
    await expect.poll(async () => isGrey(await pixel(page, 0.2, 0.5))).toBe(true);
    await expect.poll(async () => isYellow(await pixel(page, 0.5, 0.5))).toBe(true);
    await expect.poll(async () => isClear(await pixel(page, 0.85, 0.4))).toBe(true);
  };
  await check();
  await page.waitForTimeout(1500); // autosave is debounced

  await page.reload();
  await expect(page.getByTestId('home-resume')).toContainText('Continue editing');
  await page.getByTestId('home-resume').click();
  await expect(page.locator('.topbar .title')).toHaveText('1600 × 1200');
  await page.getByRole('tab', { name: 'Mask' }).click();
  await page.getByRole('button', { name: 'Show mask overlay' }).click();
  await settle(page);
  await check();
  await page.getByRole('tab', { name: 'Overlay' }).click();
  await expect(page.locator('.layer-chip', { hasText: 'disc' })).toBeVisible();

  // leaving on purpose forgets it; leaving a resumed edit always asks first
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByTestId('leave-discard').click();
  await expect(page.getByTestId('home-edit')).toBeVisible();
  await expect(page.getByTestId('home-resume')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('home-edit')).toBeVisible();
  await expect(page.getByTestId('home-resume')).toHaveCount(0);
});

test('a stitch comes back with its order and trims', async ({ page }) => {
  await page.goto('/');
  const files = await Promise.all([photo(), gradient(), overlay()]);
  await page.getByTestId('pick-multi').setInputFiles(files.map((buffer, i) => ({ name: `p${i + 1}.png`, mimeType: 'image/png', buffer })));
  await expect(page.locator('.topbar .title')).toHaveText('Stitch · 3');
  await page.getByRole('button', { name: 'Photo 1' }).click();
  await page.getByRole('button', { name: 'Move later' }).click();
  await setRange(page, 'Trim top', 100);
  await page.getByRole('tab', { name: 'Style' }).click();
  await setRange(page, 'Spacing', 40);
  await page.waitForTimeout(1500);

  await page.reload();
  await page.getByTestId('home-resume').click();
  await expect(page.locator('.topbar .title')).toHaveText('Stitch · 3');
  await page.getByRole('tab', { name: 'Style' }).click();
  await expect(page.getByRole('slider', { name: 'Spacing', exact: true })).toHaveValue('40');
  await page.getByRole('tab', { name: 'Photos' }).click();
  // the 1600×1200 photo moved to second place and keeps its trim
  await page.getByRole('button', { name: 'Photo 2' }).click();
  await expect(page.getByRole('slider', { name: 'Trim top', exact: true })).toHaveValue('100');
});

test('opening something else and backing out without changes keeps the saved edit', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('pick-one').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: await photo() });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await setRange(page, 'Saturation', -100);
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.getByTestId('home-resume')).toBeVisible();

  // look at another photo, change nothing, go back
  await page.getByTestId('pick-one').setInputFiles({ name: 'g.png', mimeType: 'image/png', buffer: await gradient() });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByTestId('home-resume')).toBeVisible();

  // same for a stitch
  await page.getByTestId('pick-multi').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: await gradient() },
    { name: 'b.png', mimeType: 'image/png', buffer: await overlay() },
  ]);
  await expect(page.locator('.topbar .title')).toHaveText('Stitch · 2');
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Back', exact: true }).click();

  await page.reload();
  await expect(page.getByTestId('home-resume')).toContainText('Continue editing');
  await page.getByTestId('home-resume').click();
  await expect(page.locator('.topbar .title')).toHaveText('1600 × 1200');
  await expect(page.getByRole('slider', { name: 'Saturation', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Saturation', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Saturation', exact: true })).toHaveValue('-100');
});
