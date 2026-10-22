import { test, expect } from '@playwright/test';

test('home screen renders with build marker', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Stitch', exact: true })).toBeVisible();
  await expect(page.getByText(/^Build \d+\.\d+\.\d+\+/)).toBeVisible();
});

test('version.json and manifest are served', async ({ request }) => {
  const v = await request.get('/version.json');
  expect(v.ok()).toBeTruthy();
  expect((await v.json()).build).toMatch(/^\d+\.\d+\.\d+\+/);
  const m = await request.get('/manifest.webmanifest');
  expect((await m.json()).display).toBe('standalone');
});
