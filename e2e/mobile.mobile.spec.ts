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

    await page.getByRole('button', { name: 'Close layers' }).click();
    await expect(page.locator('.map-layers-panel')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#map')).toHaveAttribute('data-map-layers-panel-open', 'false');

    errors.assertNoErrors();
  });
});
