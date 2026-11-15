import { expect, test } from '@playwright/test';
import { installBrowserErrorWatch, openApp } from './support/map-fixture';
import { searchSourceFeatureCount } from './support/map-interactions';

test.describe('POI search in a real browser', () => {
  test('renders Photon results and selects a result on the map', async ({ page }) => {
    const errors = await installBrowserErrorWatch(page);
    await openApp(page);

    await page.getByRole('searchbox', { name: 'Search places or trains' }).fill('shanghai station');
    await expect(page.locator('.poi-search-result')).toHaveCount(2);
    await page.locator('.poi-search-result', { hasText: 'Shanghai Railway Station' }).click();

    await expect(page.locator('.poi-search-popup')).toContainText('Shanghai Railway Station');
    await expect.poll(() => searchSourceFeatureCount(page)).toBe(1);
    await expect(page.locator('.poi-search-result', { hasText: 'Shanghai Railway Station' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    errors.assertNoErrors();
  });

  test('clears the selected result, popup, and search source', async ({ page }) => {
    const errors = await installBrowserErrorWatch(page);
    await openApp(page);

    await page.getByRole('searchbox', { name: 'Search places or trains' }).fill('temple');
    await page.locator('.poi-search-result').first().click();
    await expect.poll(() => searchSourceFeatureCount(page)).toBe(1);

    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.locator('.poi-search-result')).toHaveCount(0);
    await expect(page.locator('.poi-search-popup')).toHaveCount(0);
    await expect.poll(() => searchSourceFeatureCount(page)).toBe(0);
    errors.assertNoErrors();
  });

  test('does not query Photon for one-character input', async ({ page }) => {
    const errors = await installBrowserErrorWatch(page);
    await openApp(page);
    let photonRequests = 0;
    await page.route(/https:\/\/photon\.komoot\.io\/api\/.*/, (route) => {
      photonRequests += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"features":[]}' });
    });

    await page.getByRole('searchbox', { name: 'Search places or trains' }).fill('s');
    await page.waitForTimeout(450);
    expect(photonRequests).toBe(0);
    await expect(page.locator('.poi-search-result')).toHaveCount(0);
    errors.assertNoErrors();
  });

  test('finds China Railway trains by number and opens one in the timetable', async ({ page }) => {
    const errors = await installBrowserErrorWatch(page);
    await openApp(page);
    // The API: two trains for G1, G1's stops, and nothing else (its track, trainset).
    await page.route(/\/api\/v1\/.*/, (route) => {
      const url = new URL(route.request().url());
      const json = (status: number, body: unknown) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(body),
        });
      if (url.pathname === '/api/v1/search') {
        return json(200, {
          data_version: '20261120',
          query: 'G1',
          results: [
            {
              type: 'cr_train',
              train: 'G1',
              origin: '北京南',
              destination: '上海虹桥',
              service: { from: '2026-01-27', to: null },
            },
            {
              type: 'cr_train',
              train: 'G10',
              origin: '上海虹桥',
              destination: '北京南',
              service: { from: '2026-01-26', to: null },
            },
          ],
        });
      }
      if (url.pathname === '/api/v1/cr/trains/G1') {
        const stop = (name: string, km: number, arrival: string | null, departure: string | null) => ({
          name,
          telecode: '',
          arrival,
          departure,
          day: 1,
          km,
          platform: null,
        });
        return json(200, {
          data_version: '20261120',
          train: 'G1',
          date: url.searchParams.get('date'),
          trains: [
            {
              train: 'G1',
              service: { from: '2026-01-27', to: null },
              runs: true,
              stops: [stop('北京南', 0, null, '06:30'), stop('上海虹桥', 1318, '10:58', null)],
            },
          ],
        });
      }
      return json(404, { error: { code: 'not_found', message: 'not found' } });
    });

    await page.getByRole('searchbox', { name: 'Search places or trains' }).fill('G1');
    const trains = page.locator('.poi-search-train');
    await expect(trains).toHaveCount(2);
    // Trains come before places.
    await expect(page.locator('.poi-search-result').first()).toHaveClass(/poi-search-train/);
    await expect(trains.first()).toContainText('G1');
    await expect(trains.first()).toContainText('北京南 → 上海虹桥');

    await trains.first().click();
    const timetable = page.locator('.timetable-panel');
    await expect(timetable.locator('.timetable-title')).toHaveText('G1');
    await expect(timetable.locator('.timetable-stop-name')).toHaveText(['北京南', '上海虹桥']);
    // The results fold away so they do not cover the timetable, and can come back.
    await expect(page.locator('.poi-search-results')).toBeHidden();
    await expect(page.getByRole('searchbox', { name: 'Search places or trains' })).not.toBeFocused();
    await expect(page.locator('.poi-search-results-toggle')).toHaveText('Show 4 results');
    await page.locator('.poi-search-results-toggle').dispatchEvent('click');
    await expect(trains.first()).toHaveAttribute('aria-selected', 'true');
    errors.assertNoErrors();
  });

  test('shows failure status when Photon returns an error', async ({ page }) => {
    await openApp(page);
    await page.route(/https:\/\/photon\.komoot\.io\/api\/.*/, (route) =>
      route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"bad gateway"}' }),
    );

    await page.getByRole('searchbox', { name: 'Search places or trains' }).fill('station');
    await expect(page.locator('.poi-search-status')).toHaveText('Search failed');
    await expect(page.locator('.poi-search-result')).toHaveCount(0);
  });
});
