import { expect, type Page } from '@playwright/test';

/**
 * Waits until a state change has reached the canvas: Preact runs effects in a setTimeout after the next
 * animation frame, and the canvas view then draws on the following frame.
 */
export async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        const tick = () => new Promise<void>((r) => setTimeout(r, 0));
        (async () => {
          for (let i = 0; i < 2; i++) {
            await frame();
            await tick();
          }
          await frame();
          await frame();
          resolve();
        })();
      }),
  );
}

/**
 * Sets a slider by its label. Panels show one slider at a time, so if it is not on screen the chip with the same
 * name is tapped first (Adjust settings, brush settings, Stitch style).
 */
export async function setRange(page: Page, label: string, value: number, commit = true) {
  const slider = page.getByRole('slider', { name: label, exact: true });
  if (!(await slider.count())) await page.getByRole('button', { name: label, exact: true }).click();
  await slider.evaluate(
    (el, [v, c]) => {
      const i = el as HTMLInputElement;
      i.value = String(v);
      i.dispatchEvent(new Event('input', { bubbles: true }));
      if (c) i.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [value, commit] as const,
  );
}

/** Picks which layer Adjust/Filters/Mask edit (the layer chip under the picture). */
export async function editLayer(page: Page, name: string) {
  await page.getByTestId('target-chip').click();
  await page.locator('.sheet .layer-chip', { hasText: name }).click();
  await expect(page.getByTestId('target-chip')).toContainText(name);
}
