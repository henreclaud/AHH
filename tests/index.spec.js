// @ts-check
const { test, expect } = require('@playwright/test');

test('homepage has a prominent "My Opportunities / Cancel" button linking to /cancel.html', async ({ page }) => {
  await page.goto('/');

  // Find a button or link with the exact text (case-insensitive, trimmed)
  const el = page.getByRole('link', { name: /my opportunities \/ cancel/i });
  await expect(el).toBeVisible();

  // Must link to /cancel.html
  await expect(el).toHaveAttribute('href', /cancel\.html/);

  // Must not be small text — font-size >= 14px
  const fontSize = await el.evaluate(node => {
    return parseFloat(getComputedStyle(node).fontSize);
  });
  expect(fontSize).toBeGreaterThanOrEqual(14);

  // Must not be styled as tiny inline text — bounding box height >= 30px
  const box = await el.boundingBox();
  expect(box).not.toBeNull();
  expect(box.height).toBeGreaterThanOrEqual(30);
});
