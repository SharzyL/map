import { expect, test } from '@playwright/test';
import { installBrowserErrorWatch, mapState, openApp } from './support/map-fixture';
import { openImport, openLayerList, openLayers } from './support/map-interactions';

test.describe('map shell', () => {
  test('boots a real MapLibre map and exposes the primary controls', async ({ page }) => {
    const errors = await installBrowserErrorWatch(page);

    await openApp(page);

    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Layers' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Annotations' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pick a point for weather' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Railway filter' })).toBeVisible();
    // Annotations ends the control column.
    await expect(
      page.locator('.maplibregl-ctrl-top-right > .maplibregl-ctrl').last().locator('.maplibregl-ctrl-annotation'),
    ).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', 'https://github.com/SharzyL/map');

    const state = await mapState(page);
    expect(state.hasMap).toBe(true);
    expect(state.styleLoaded).toBe(true);
    expect(state.styleLayerCount).toBeGreaterThan(5);

    errors.assertNoErrors();
  });

  test('keeps overlay panels mutually exclusive and closeable', async ({ page }) => {
    const errors = await installBrowserErrorWatch(page);

    await openApp(page);

    const layersButton = page.locator('.maplibregl-ctrl-map-layers');
    const annotationsButton = page.locator('.maplibregl-ctrl-annotation');

    await layersButton.click();
    await expect(page.locator('.map-layers-panel')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('.annotation-panel')).toHaveAttribute('aria-hidden', 'true');

    await annotationsButton.click();
    await expect(page.locator('.annotation-panel')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('.map-layers-panel')).toHaveAttribute('aria-hidden', 'true');

    await layersButton.click();
    await expect(page.locator('.annotation-panel')).toHaveAttribute('aria-hidden', 'true');
    await page.getByRole('button', { name: 'Close layers' }).click();
    await expect(page.locator('.map-layers-panel')).toHaveAttribute('aria-hidden', 'true');

    // Settings panels close when the map is clicked.
    await page.locator('.maplibregl-ctrl-railways').click();
    await expect(page.locator('.railway-filter-panel')).toHaveAttribute('aria-hidden', 'false');
    await page.locator('.maplibregl-canvas').click({ position: { x: 200, y: 300 } });
    await expect(page.locator('.railway-filter-panel')).toHaveAttribute('aria-hidden', 'true');

    errors.assertNoErrors();
  });

  test('keeps the layer list and a foldable import in the annotation panel', async ({ page }) => {
    const errors = await installBrowserErrorWatch(page);

    await openApp(page);
    const list = await openLayerList(page);
    await expect(list.locator('.layer-manager-item-name', { hasText: 'Annotations' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import GPX / GeoJSON' })).toBeHidden();

    await openImport(page);
    await expect(page.getByRole('button', { name: 'Import GPX / GeoJSON' })).toBeVisible();

    await page.getByRole('button', { name: 'Close annotations' }).click();
    await expect(page.locator('.layer-manager-dropzone')).toBeDisabled();

    errors.assertNoErrors();
  });

  test('switches base map, terrain and 3D from the Layers panel', async ({ page }) => {
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
