import { expect, test } from '@playwright/test';
import { installBrowserErrorWatch, mapState, openApp } from './support/map-fixture';
import { openLayers, openLayersFold, openRouting } from './support/map-interactions';

test.describe('map shell', () => {
  test('boots a real MapLibre map and exposes the primary controls', async ({ page }) => {
    const errors = await installBrowserErrorWatch(page);

    await openApp(page);

    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Layers' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Annotations' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pick a point for weather' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Railway filter' })).toBeVisible();

    const state = await mapState(page);
    expect(state.hasMap).toBe(true);
    expect(state.styleLoaded).toBe(true);
    expect(state.styleLayerCount).toBeGreaterThan(5);

    errors.assertNoErrors();
  });

  test('keeps overlay panels mutually exclusive and closeable', async ({ page }) => {
    const errors = await installBrowserErrorWatch(page);

    await openApp(page);

    const layersButton = page.locator('.maplibregl-ctrl-layers');
    const annotationsButton = page.locator('.maplibregl-ctrl-annotation');

    await layersButton.click();
    await expect(page.locator('.layer-manager-panel')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('.annotation-panel')).toHaveAttribute('aria-hidden', 'true');

    await annotationsButton.click();
    await expect(page.locator('.annotation-panel')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('.layer-manager-panel')).toHaveAttribute('aria-hidden', 'true');

    await openRouting(page);
    await expect(page.locator('.annotation-panel')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.layer-manager-panel')).toHaveAttribute('aria-hidden', 'false');

    await page.getByRole('button', { name: 'Close layers' }).click();
    await expect(page.locator('.routing-panel')).toHaveAttribute('aria-hidden', 'true');

    errors.assertNoErrors();
  });

  test('shows map toggles, layers and foldable import and navigation in one Layers panel', async ({ page }) => {
    const errors = await installBrowserErrorWatch(page);

    await openApp(page);
    const panel = await openLayers(page);
    await expect(panel.getByLabel('Hybrid')).toBeVisible();
    await expect(panel.getByLabel('Contour lines')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import GPX / GeoJSON' })).toBeHidden();
    await expect(page.locator('.routing-panel')).toHaveAttribute('aria-hidden', 'true');

    await openLayersFold(page, 'Import');
    await expect(page.getByRole('button', { name: 'Import GPX / GeoJSON' })).toBeVisible();

    await openRouting(page);
    await expect(page.getByRole('button', { name: 'Add route' })).toBeVisible();

    await page.getByRole('button', { name: 'Close layers' }).click();
    await expect(page.locator('.routing-panel')).toHaveAttribute('aria-hidden', 'true');
    await page.locator('.maplibregl-ctrl-layers').click();
    await expect(page.locator('.routing-panel')).toHaveAttribute('aria-hidden', 'false');

    errors.assertNoErrors();
  });

  test('switches base map, terrain and 3D from the map display panel', async ({ page }) => {
    const errors = await installBrowserErrorWatch(page);

    await openApp(page);
    await expect.poll(() => mapState(page)).toMatchObject({ terrain: false, baseMap: 'map', showHillshade: true });

    const panel = await openLayers(page);

    await panel.getByLabel('Hybrid').check();
    await panel.getByLabel('Hillshade').uncheck();
    await panel.getByLabel('3D terrain').check();
    await expect
      .poll(() => mapState(page))
      .toMatchObject({ terrain: true, baseMap: 'hybrid', showHillshade: false, showContours: true });

    await panel.getByLabel('Satellite').check();
    await panel.getByLabel('3D terrain').uncheck();
    await expect.poll(() => mapState(page)).toMatchObject({ terrain: false, baseMap: 'satellite' });

    await expect(panel.getByLabel('Railways')).toHaveCount(0);
    await page.getByRole('button', { name: 'Railway filter' }).click();
    await page.locator('.railway-filter-check', { hasText: 'Show railway overlay' }).locator('input').uncheck();
    await expect.poll(() => mapState(page)).toMatchObject({ railwayOverlay: false });

    errors.assertNoErrors();
  });
});
