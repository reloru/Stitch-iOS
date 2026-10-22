import type { Page } from '@playwright/test';

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
