import { expect, test, type Page } from '@playwright/test';
import { installBrowserErrorWatch, openApp } from './support/map-fixture';

type ViewMap = {
  jumpTo(options: { center: [number, number]; zoom: number }): void;
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
};

const view = (page: Page) =>
  page.evaluate(() => {
    const map = (window as unknown as { _mlmap: ViewMap })._mlmap;
    const { lng, lat } = map.getCenter();
    return { lng: Number(lng.toFixed(2)), lat: Number(lat.toFixed(2)), zoom: Number(map.getZoom().toFixed(1)) };
  });

test.describe('the map’s starting view', () => {
  test('reopens where it was left without a view in the URL, but a URL’s view wins', async ({ page }) => {
    const errors = await installBrowserErrorWatch(page);
    await openApp(page);
    // The first time: Tokyo's Yamanote loop.
    expect(await view(page)).toMatchObject({ lng: 139.74, lat: 35.68 });

    await page.evaluate(() =>
      (window as unknown as { _mlmap: ViewMap })._mlmap.jumpTo({ center: [116.38, 39.87], zoom: 11 }),
    );
    await expect.poll(() => page.evaluate(() => localStorage.getItem('atlas-realm:map-view'))).toContain('116.38');

    // The bare address, as a bookmark opens it, reopens there.
    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as { _mlmap?: ViewMap })._mlmap));
    expect(await view(page)).toEqual({ lng: 116.38, lat: 39.87, zoom: 11 });

    // A URL with a view opens at it.
    await page.goto('/#9/34.7/135.5');
    await page.reload();
    await page.waitForFunction(() => Boolean((window as unknown as { _mlmap?: ViewMap })._mlmap));
    expect(await view(page)).toEqual({ lng: 135.5, lat: 34.7, zoom: 9 });
    errors.assertNoErrors();
  });
});
