import { expect, test } from '@playwright/test';
import { installBrowserErrorWatch, openApp } from './support/map-fixture';

test.describe('mobile map shell', () => {
  test('keeps the main map controls usable on a phone viewport', async ({ page }) => {
    const errors = await installBrowserErrorWatch(page);

    await openApp(page);

    await expect(page.locator('#map canvas')).toBeVisible();
    await page.getByRole('button', { name: 'Layers' }).click();
    await expect(page.locator('.map-layers-panel')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('#map')).toHaveAttribute('data-map-layers-panel-open', 'true');

    // It collapses to its header from the grabber, and back.
    const panel = page.locator('.map-layers-panel');
    const viewport = page.viewportSize();
    await page.getByRole('button', { name: 'Collapse layers' }).click();
    await expect(panel).toHaveClass(/sheet-collapsed/);
    await expect.poll(async () => viewport.height - (await panel.boundingBox()).y).toBeLessThan(80);
    await page.getByRole('button', { name: 'Expand layers' }).click();
    await expect(panel).not.toHaveClass(/sheet-collapsed/);

    await page.getByRole('button', { name: 'Close layers' }).click();
    await expect(page.locator('.map-layers-panel')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#map')).toHaveAttribute('data-map-layers-panel-open', 'false');

    errors.assertNoErrors();
  });

  // Safari on iOS zooms into a focused field with text under 16px.
  test('sets every text field at 16px or more', async ({ page }) => {
    await openApp(page);
    for (const name of ['Layers', 'Railway filter', 'Annotations']) {
      await page.getByRole('button', { name, exact: true }).click();
      await page.getByRole('button', { name: `Close ${name.toLowerCase()}` }).click();
    }
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('input, textarea, select')]
        .filter((field) => !['checkbox', 'radio', 'range', 'color', 'file'].includes(field.getAttribute('type') ?? ''))
        .filter((field) => parseFloat(getComputedStyle(field).fontSize) < 16)
        .map((field) => field.outerHTML.slice(0, 120)),
    );
    expect(small).toEqual([]);
    expect(await page.locator('input, textarea, select').count()).toBeGreaterThan(5);
  });
});
