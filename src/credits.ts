// Credits for the map's data and services. The attribution line, bottom
// right, keeps OpenStreetMap's credit (its licence asks for it on the map) and
// imagery's while it shows (main.ts withShortAttributions); its Credits button
// (CREDITS_ATTRIBUTION) opens this panel with everything else. MapLibre
// rewrites the attribution line's markup whenever the visible sources change,
// so the button is found by its class on each click.
import { createPanelShell, el } from './map-panel.js';
import {
  emitUiPanelOpen,
  isOtherUiPanelOpen,
  onOutsideClick,
  UI_PANEL_OPEN_EVENT,
  type OutsideClickMap,
} from './ui-panels.js';

export const CREDITS_ATTRIBUTION = '<button type="button" class="attribution-credits">Credits</button>';
export const OSM_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap</a>';

type Credit = { name: string; href?: string; use: string; note?: string };

export const CREDIT_GROUPS: Array<{ title: string; credits: Credit[] }> = [
  {
    title: 'Map data',
    credits: [
      {
        name: '© OpenStreetMap contributors',
        href: 'https://www.openstreetmap.org/copyright',
        use: 'Railways, stations and the base map',
        note: 'Open Database License (ODbL)',
      },
      {
        name: 'OpenRailwayMap',
        href: 'https://github.com/hiddewie/OpenRailwayMap-vector',
        use: 'Railway styles and the database the railway tiles are built from',
      },
      {
        name: '国土数値情報（鉄道データ）, 国土交通省',
        href: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html',
        use: "Japan's official railway lines",
        note: '出典：国土数値情報（鉄道データ）（国土交通省）を加工して作成 · CC BY 4.0',
      },
      {
        name: 'OpenHistoricalMap',
        href: 'https://www.openhistoricalmap.org/',
        use: 'Railways of past years (the year slider)',
      },
    ],
  },
  {
    title: 'Base map and imagery',
    credits: [
      { name: 'OpenFreeMap', href: 'https://openfreemap.org/', use: 'Base map tiles and style' },
      { name: '© OpenMapTiles', href: 'https://www.openmaptiles.org/', use: 'Base map tile schema' },
      { name: 'Natural Earth', href: 'https://www.naturalearthdata.com/', use: 'Shaded relief when zoomed out' },
      {
        name: '© Mapterhorn',
        href: 'https://mapterhorn.com/attribution',
        use: 'Elevation: hillshade, contour lines, 3D terrain and the Locate readout',
      },
      { name: '© Google', use: 'Satellite imagery' },
    ],
  },
  {
    title: 'Services',
    credits: [
      { name: 'Yahoo!乗換案内', href: 'https://transit.yahoo.co.jp/', use: 'Station timetables in Japan' },
      { name: 'Photon by komoot', href: 'https://photon.komoot.io/', use: 'Search' },
      { name: 'OSRM', href: 'https://project-osrm.org/', use: 'Routes drawn with the Route tool' },
      {
        name: 'Open-Meteo',
        href: 'https://open-meteo.com/',
        use: 'Weather forecasts',
        note: 'CC BY 4.0',
      },
      { name: 'weather.mgt.moe', href: 'https://weather.mgt.moe/', use: 'Weather dashboard in weather cards' },
      {
        name: 'Nominatim',
        href: 'https://nominatim.openstreetmap.org/',
        use: 'Place names of weather forecasts',
      },
      {
        name: 'Wikidata and Wikimedia Commons',
        href: 'https://www.wikidata.org/',
        use: 'Links and images in info boxes (each image credits its author)',
      },
    ],
  },
  {
    title: 'Software',
    credits: [
      { name: 'MapLibre GL JS', href: 'https://maplibre.org/', use: 'Map rendering' },
      {
        name: 'maplibre-contour',
        href: 'https://github.com/onthegomap/maplibre-contour',
        use: 'Contour lines',
      },
      { name: 'Lucide', href: 'https://lucide.dev/', use: 'Icons' },
    ],
  },
];

class CreditsPanel {
  readonly panel: HTMLElement;
  private readonly _container: HTMLElement;
  private _open = false;

  constructor(container: HTMLElement) {
    this._container = container;
    const shell = createPanelShell(container, 'credits', {
      title: 'Credits',
      label: 'Credits',
      closeLabel: 'Close credits',
      onClose: () => this.close(),
    });
    this.panel = shell.panel;
    shell.summary.textContent = 'Data, imagery and services this map uses';
    for (const { title, credits } of CREDIT_GROUPS) {
      const group = el('section', 'credits-group', shell.body);
      el('h3', 'credits-group-title', group).textContent = title;
      const list = el('ul', 'credits-list', group);
      for (const credit of credits) {
        const item = el('li', 'credits-item', list);
        const name = el(credit.href ? 'a' : 'span', 'credits-name', item);
        name.textContent = credit.name;
        if (name instanceof HTMLAnchorElement) {
          name.href = credit.href;
          name.target = '_blank';
          name.rel = 'noopener noreferrer';
        }
        el('span', 'credits-use', item).textContent = credit.use;
        if (credit.note) el('span', 'credits-note', item).textContent = credit.note;
      }
    }
    this.panel.inert = true;
  }

  get isOpen() {
    return this._open;
  }

  open() {
    this._open = true;
    emitUiPanelOpen(this._container, 'credits');
    this._sync();
  }

  close() {
    this._open = false;
    this._sync();
  }

  private _sync() {
    this.panel.classList.toggle('credits-panel-visible', this._open);
    this.panel.setAttribute('aria-hidden', this._open ? 'false' : 'true');
    this.panel.inert = !this._open;
    for (const button of this._container.querySelectorAll('.attribution-credits')) {
      button.setAttribute('aria-expanded', this._open ? 'true' : 'false');
    }
  }
}

export function installCredits(map: OutsideClickMap) {
  const container = map.getContainer();
  const panel = new CreditsPanel(container);
  container.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('.attribution-credits')) return;
    if (panel.isOpen) panel.close();
    else panel.open();
  });
  container.addEventListener(UI_PANEL_OPEN_EVENT, (event) => {
    if (isOtherUiPanelOpen(event, 'credits')) panel.close();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.isOpen) panel.close();
  });
  onOutsideClick(
    map,
    () => [panel.panel, ...container.querySelectorAll('.attribution-credits')],
    () => panel.close(),
  );
  return panel;
}
