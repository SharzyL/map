// The "Layers" panel: the layer manager's panel extended with
//   - the map display toggles (base map, terrain, overlays) at the top,
//   - its own GPX/GeoJSON import moved into a foldable "Import" section,
//   - routing in a foldable "Navigation" section.
// The map display and routing controls are added to the map without their
// toolbar buttons; their content moves into the layer manager's panel and is
// marked data-embedded-panel so the layer manager leaves their controls alone.
// Routing is only active (its inputs enabled, picking possible) while the
// Layers panel is open and the Navigation section is unfolded.
import { el } from './map-panel.js';

type PanelControl<M> = {
  onAdd(map: M): HTMLElement;
  onRemove(): void;
  readonly panelElement: HTMLElement;
};

export type LayersPanelParts<M> = {
  layerManager: PanelControl<M>;
  mapLayers: PanelControl<M>;
  routing: PanelControl<M> & { setExpanded(expanded: boolean): void };
};

type LayersPanelMap<M> = {
  addControl(control: { onAdd(map: M): HTMLElement; onRemove(): void }, position?: string): unknown;
};

function fold(title: string, hint: string, className: string) {
  const details = el('details', `layers-panel-fold ${className}`);
  const summary = el('summary', 'layers-panel-fold-summary', details);
  el('span', 'layers-panel-fold-title', summary).textContent = title;
  el('span', 'layers-panel-fold-hint', summary).textContent = hint;
  const content = el('div', 'layers-panel-fold-content', details);
  return { details, content };
}

export function installLayersPanel<M extends LayersPanelMap<M>>(map: M, parts: LayersPanelParts<M>) {
  const { layerManager, mapLayers, routing } = parts;
  map.addControl(layerManager, 'top-right');
  mapLayers.onAdd(map);
  routing.onAdd(map);

  const panel = layerManager.panelElement;
  const body = panel.querySelector('.layer-manager-body');

  // Map display toggles first.
  const mapBody = mapLayers.panelElement.querySelector<HTMLElement>('.map-layers-body');
  mapBody.classList.add('layers-panel-map');
  mapBody.dataset.embeddedPanel = 'map-layers';
  body.insertBefore(mapBody, body.firstChild);
  mapLayers.panelElement.remove();

  // The layer manager's own import controls, folded below the layer list.
  const importFold = fold('Import', 'GPX or GeoJSON file or URL', 'layers-panel-import');
  for (const selector of ['.layer-manager-import-row', '.layer-manager-url-form']) {
    const node = body.querySelector(selector);
    if (node) importFold.content.appendChild(node);
  }
  body.appendChild(importFold.details);
  const status = body.querySelector('.layer-manager-status');
  if (status) body.appendChild(status);

  // Routing, folded at the bottom.
  const navigationFold = fold('Navigation', 'Driving route between two points', 'layers-panel-navigation');
  const routingPanel = routing.panelElement;
  routingPanel.classList.add('layers-panel-routing');
  routingPanel.dataset.embeddedPanel = 'routing';
  navigationFold.content.appendChild(routingPanel);
  body.appendChild(navigationFold.details);

  const isOpen = () => panel.getAttribute('aria-hidden') === 'false';
  const syncEmbedded = () => {
    const open = isOpen();
    // Hidden panels must not keep focusable controls.
    mapBody.inert = !open;
    routing.setExpanded(open && navigationFold.details.open);
  };
  navigationFold.details.addEventListener('toggle', syncEmbedded);
  // The layer manager opens and closes itself (button, close, Escape, other panels).
  new MutationObserver(syncEmbedded).observe(panel, { attributes: true, attributeFilter: ['aria-hidden'] });
  syncEmbedded();
}
