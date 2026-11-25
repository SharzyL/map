import { expect, test } from '@playwright/test';
import { routeExternalMapResources } from './support/map-fixture';

test.describe('a browser without WebGL 2', () => {
  test('says why the map cannot be drawn and what to do, instead of a blank page', async ({ page }) => {
    // As a browser with WebGL 2 turned off answers
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (type === 'webgl2') return null;
        return getContext.call(this, type, ...rest);
      } as typeof getContext;
    });
    await routeExternalMapResources(page);
    await page.goto('/');
    const alert = page.locator('#map .map-unavailable[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert.locator('.map-unavailable-title')).toHaveText('This browser cannot draw the map');
    await expect(alert).toContainText('WebGL 2');
    await expect(alert.locator('a')).toHaveAttribute(
      'href',
      'https://wiki.openstreetmap.org/wiki/This_map_requires_WebGL',
    );
  });
});
