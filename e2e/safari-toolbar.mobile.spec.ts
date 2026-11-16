import { expect, test } from '@playwright/test';
import { installBrowserErrorWatch, openApp } from './support/map-fixture';

// Safari on iOS 26 floats its toolbar over the bottom 80 points of a page that
// runs down to the screen's edge (an iPhone 16 Pro, below its status bar).
test.use({
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 393, height: 790 },
});

const TOOLBAR = 80;

test.describe('Safari’s floating toolbar', () => {
  test('keeps a collapsed sheet’s head and the map’s bottom controls above it', async ({ page }) => {
    const errors = await installBrowserErrorWatch(page);
    await page.addInitScript(() => Object.defineProperty(window.screen, 'height', { get: () => 852 }));
    await openApp(page);
    const viewport = page.viewportSize();

    const attribution = page.locator('.maplibregl-ctrl-bottom-right');
    const controls = await attribution.boundingBox();
    expect(controls.y + controls.height).toBeLessThanOrEqual(viewport.height - TOOLBAR + 1);

    await page.getByRole('button', { name: 'Layers' }).click();
    const panel = page.locator('.map-layers-panel');
    await page.getByRole('button', { name: 'Collapse layers' }).click();
    await expect(panel).toHaveClass(/sheet-collapsed/);
    // The head shows above the toolbar; the sheet still runs down behind it.
    await expect.poll(async () => viewport.height - (await panel.boundingBox()).y).toBeGreaterThan(TOOLBAR + 30);
    await expect.poll(async () => viewport.height - (await panel.boundingBox()).y).toBeLessThan(TOOLBAR + 80);
    const header = await panel.locator('.map-layers-header').boundingBox();
    expect(header.y + header.height).toBeLessThanOrEqual(viewport.height - TOOLBAR + 1);

    errors.assertNoErrors();
  });
});
