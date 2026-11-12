// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFeatureCatalog, installOrmPopups, popupContent, popupRoom } from './popup.js';
import { ROUTE_SELECT_EVENT } from './route-highlight.js';

// Attributes of a real light rail segment and station in Frankfurt (OpenRailwayMap tiles).
const LINE_PROPERTIES = {
  way_length: 655,
  feature: 'light_rail',
  state: 'present',
  usage: 'main',
  highspeed: false,
  tunnel: false,
  bridge: true,
  name: 'A-Strecke',
  ref: 'A',
  preferred_direction: 'forward',
  osm_id: '137315646',
  maxspeed: 60,
  speed_label: '60',
  train_protection_rank: 1,
  train_protection0: 'pzb',
  train_protection1: 'etcs_2',
  electrification_state: 'present',
  voltage: 15000,
  frequency: 16.7,
  gaugeint0: 1435,
  gaugeint1: 1000,
  gauges: '1435, 1000',
  operator: 'VGF',
  primary_operator: 'VGF',
  radio: 'gsm-r',
  wikipedia: 'de:A-Strecke',
  line_routes: '66615\u001e#4a5eaa\u001eU3: Oberursel Hohemark => Südbahnhof',
  line_relations: '1924436\u001e\u001eA-Strecke\u001eA\u001d5611\u001e\u001e3\u001e3',
  unexpected_tag: 'kept',
};

const STATION_PROPERTIES = {
  id: 'node-5902639720-subway-subway-station',
  osm_id: '5902639720',
  osm_type: 'N',
  feature: 'station',
  state: 'present',
  station: 'light_rail',
  station_size: 'normal',
  label: 'MA',
  name: 'Miquel-/Adickesallee',
  localized_name: 'Miquel-/Adickesallee',
  count: 1,
  references: 'railway-ref\u001eMA\u001duic\u001e100404',
  operator: 'VGF',
  network: 'Rhein-Main-Verkehrsverbund',
  discr_iso: 1989.39,
};

function render(source: string, sourceLayer: string, properties: Record<string, unknown>) {
  const content = popupContent(
    { source, sourceLayer, properties, geometry: { type: 'Point' } },
    buildFeatureCatalog(),
    new AbortController(),
  );
  const sections: Record<string, Array<[string, string]>> = {};
  for (const section of content.querySelectorAll('.orm-popup-section')) {
    const title = section.querySelector('.orm-popup-section-title').textContent;
    const terms = Array.from(section.querySelectorAll('dt'));
    sections[title] = terms.map((dt) => [dt.textContent, dt.nextElementSibling.textContent]);
  }
  return { content, sections };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('structured railway line popup', () => {
  it('groups line metadata into a few combined rows', () => {
    const { sections } = render('high', 'railway_line_high', LINE_PROPERTIES);
    expect(Object.keys(sections)).toEqual(['Line', 'Links', 'Other']);
    expect(sections.Line).toEqual([
      ['Lines', 'A-StreckeA3'],
      ['Type', 'Main · Bridge'],
      ['Speed', '60 km/h'],
      ['Electrification', 'Electrified · 15 kV 16.7 Hz'],
      ['Gauge', '1435 mm, 1000 mm'],
      ['Signalling', 'PZB, ETCS 2 · GSM-R'],
      ['Operator', 'VGF'],
      ['Preferred direction', 'Forward'],
    ]);
    expect(sections.Links).toEqual([['Wikipedia', 'A-Strecke']]);
    expect(sections.Other).toEqual([['Unexpected tag', 'kept']]);
  });

  it('names states other than in service and adds planned systems', () => {
    const { sections } = render('high', 'railway_line_high', {
      ...LINE_PROPERTIES,
      state: 'construction',
      highspeed: true,
      future_voltage: 25000,
      future_frequency: 50,
      loading_gauge: 'GC',
      track_class: 'D4',
      train_protection_construction: 'etcs_3',
    });
    const rows = Object.fromEntries(sections.Line);
    expect(rows.Type).toBe('Construction · Main · High speed · Bridge');
    expect(rows.Electrification).toBe('Electrified · 15 kV 16.7 Hz · planned 25 kV 50 Hz');
    expect(rows.Gauge).toBe('1435 mm, 1000 mm · loading gauge GC · class D4');
    expect(rows.Signalling).toBe('PZB, ETCS 2 · planned ETCS 3 · GSM-R');
  });

  it('links external references and keeps routes below the sections', () => {
    const { content } = render('high', 'railway_line_high', LINE_PROPERTIES);
    const link = content.querySelector<HTMLAnchorElement>('.orm-popup-fields a');
    expect(link.href).toBe('https://wikipedia.org/wiki/de%3AA-Strecke');
    expect(content.querySelectorAll('.orm-popup-route-list')[1].textContent).toContain('U3: Oberursel Hohemark');
    expect(content.querySelector('.orm-popup-badges')).toBeNull();
  });

  it('links lines to their OSM way without an osm_type attribute', () => {
    for (const feature of ['light_rail', 'unlisted_kind']) {
      const { content } = render('high', 'railway_line_high', { ...LINE_PROPERTIES, feature });
      const links = [...content.querySelectorAll<HTMLAnchorElement>('a')].map((link) => link.href);
      expect(links).toContain('https://www.openstreetmap.org/way/137315646');
      expect(links).toContain('https://www.openstreetmap.org/edit?way=137315646');
    }
  });

  it('asks the map to highlight a route when it is clicked', () => {
    const { content } = render('high', 'railway_line_high', LINE_PROPERTIES);
    // The Routes list comes after the Lines list.
    const item = content.querySelectorAll('.orm-popup-route-list')[1].querySelector<HTMLElement>('li');
    const selected = vi.fn();
    content.addEventListener(ROUTE_SELECT_EVENT, (event) => selected((event as CustomEvent).detail));
    expect(item.getAttribute('role')).toBe('button');
    item.click();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(selected).toHaveBeenCalledTimes(2);
    expect(selected).toHaveBeenCalledWith({
      id: '66615',
      color: '#4a5eaa',
      label: 'U3: Oberursel Hohemark => Südbahnhof',
    });
  });

  it('lists the railway lines a segment belongs to in the Line section and highlights one when clicked', () => {
    const { content, sections } = render('high', 'railway_line_high', LINE_PROPERTIES);
    // Lines sit with the line's own details; routes stay below the sections.
    const lineSection = content.querySelector('.orm-popup-section');
    expect(lineSection.querySelector('.orm-popup-section-title').textContent).toBe('Line');
    expect(lineSection.querySelector('dt').textContent).toBe('Lines');
    expect([...content.querySelectorAll('.orm-popup-lists > .orm-badge-title')].map((it) => it.textContent)).toEqual([
      'Routes (1):',
    ]);
    expect(sections.Other).toEqual([['Unexpected tag', 'kept']]);

    const [line, refOnly] = lineSection.querySelectorAll<HTMLElement>('.orm-popup-route-list li');
    expect(line.textContent).toBe('A-StreckeA');
    expect(line.querySelector('.orm-popup-list-detail').textContent).toBe('A');
    expect(line.title).toBe('Highlight this line on the map');
    // A line named only by its number shows it once.
    expect(refOnly.querySelector('.orm-popup-list-detail')).toBeNull();

    const selected = vi.fn();
    content.addEventListener(ROUTE_SELECT_EVENT, (event) => selected((event as CustomEvent).detail));
    line.click();
    expect(selected).toHaveBeenCalledWith({ id: '1924436', color: null, label: 'A-Strecke · A' });
  });

  it('tells the highlight where a line was picked', () => {
    const content = popupContent(
      {
        source: 'openrailwaymap',
        sourceLayer: 'railway_line_high',
        properties: LINE_PROPERTIES,
        geometry: { type: 'Point' },
      },
      buildFeatureCatalog(),
      new AbortController(),
      [8.68, 50.11],
    );
    const selected = vi.fn();
    content.addEventListener(ROUTE_SELECT_EVENT, (event) => selected((event as CustomEvent).detail));
    content.querySelector<HTMLElement>('.orm-popup-section .orm-popup-route-list li').click();
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: '1924436', at: [8.68, 50.11] }));
  });

  it('names track counts, heritage and rack railways and opening dates', () => {
    const { sections } = render('high', 'railway_line_high', {
      ...LINE_PROPERTIES,
      tracks: 2,
      preserved: true,
      rack: 'abt',
      start_date: '1846',
      opening_date: '2027-12',
      operator_color: 'hsl(120, 100%, 30%)',
    });
    const rows = Object.fromEntries(sections.Line);
    expect(rows.Type).toBe('Main · Double track · Heritage railway · Rack (Abt) · Bridge');
    expect(rows.Opening).toBe('1846 · planned 2027-12');
    expect(sections.Other).toEqual([['Unexpected tag', 'kept']]);
    expect(
      Object.fromEntries(render('high', 'railway_line_high', { ...LINE_PROPERTIES, tracks: 6 }).sections.Line).Type,
    ).toBe('Main · 6 tracks · Bridge');
  });

  it('shows DC lines without a frequency in hertz', () => {
    const { sections } = render('high', 'railway_line_high', { ...LINE_PROPERTIES, voltage: 750, frequency: 0 });
    expect(Object.fromEntries(sections.Line).Electrification).toBe('Electrified · 750 V DC');
  });
});

describe('structured station popup', () => {
  it('shows station metadata and expands references into rows', () => {
    const { content, sections } = render(
      'openrailwaymap_standard',
      'standard_railway_text_stations',
      STATION_PROPERTIES,
    );
    expect(content.querySelector('.orm-popup-title').textContent).toBe('Station');
    expect(sections.Station).toEqual([
      ['Type', 'Light rail'],
      ['State', 'Present'],
      ['Size', 'Normal'],
    ]);
    expect(sections.Operation).toEqual([
      ['Operator', 'VGF'],
      ['Network', 'Rhein-Main-Verkehrsverbund'],
    ]);
    expect(sections.References).toEqual([
      ['Railway reference', 'MA'],
      ['UIC', '100404'],
    ]);
    expect(sections.Other).toBeUndefined();
  });
});

describe('unstructured popups', () => {
  it('keeps badges for catalogs without sections', () => {
    const { content } = render('openrailwaymap_standard', 'standard_railway_platforms', {
      feature: 'platform',
      ref: '3',
      height: 0.76,
    });
    expect(content.querySelector('.orm-popup-sections')).toBeNull();
    expect(content.querySelector('.orm-popup-badges').textContent).toContain('Reference: 3');
  });
});

describe('installOrmPopups', () => {
  // A map whose click lands on the given features; returns the popups opened.
  function clickMap(
    features: Array<{ source: string; sourceLayer?: string; properties?: Record<string, unknown> }>,
    options = {},
  ) {
    const handlers: Record<string, (event: unknown) => void> = {};
    const container = document.createElement('div');
    const map = {
      getContainer: () => container,
      getCanvas: () => document.createElement('canvas'),
      queryRenderedFeatures: () =>
        features.map((feature) => ({ ...feature, geometry: { type: 'Point', coordinates: [8.6, 50.1] } })),
      setFeatureState: () => {},
      getZoom: () => 5,
      on: (type: string, handler: (event: unknown) => void) => (handlers[type] = handler),
      off: () => {},
      project: () => ({ y: 100 }),
    };
    const opened: Node[] = [];
    class Popup {
      element = document.createElement('div');
      setLngLat() {
        return this;
      }
      getLngLat() {
        return { lng: 8.6, lat: 50.1 };
      }
      getElement() {
        return this.element;
      }
      setDOMContent(node: Node) {
        opened.push(node);
        return this;
      }
      addTo() {
        return this;
      }
      on() {}
      remove() {}
    }
    const maplibre = {
      LngLat: {
        convert: ({ lng, lat }: { lng: number; lat: number }) => ({ toArray: () => [lng, lat], distanceTo: () => 0 }),
      },
      Popup,
    };
    installOrmPopups(map as never, maplibre as never, buildFeatureCatalog(), options);
    handlers.click({ point: [0, 0], lngLat: { lng: 8.6, lat: 50.1 } });
    return opened;
  }

  it('opens a popup for railway features whatever their source is called', () => {
    const opened = clickMap([
      { source: 'openrailwaymap', sourceLayer: 'standard_railway_text_stations', properties: STATION_PROPERTIES },
    ]);
    expect(opened).toHaveLength(1);
    expect((opened[0] as HTMLElement).querySelector('.orm-popup-section-title').textContent).toBe('Station');
  });

  it('looks up the lines of a line clicked while zoomed out and shows them', async () => {
    const lookupLineLists = vi.fn(async () => ({ line_relations: '12265072\u001e\u001e京广高速线\u001e3001' }));
    const opened = clickMap(
      [
        {
          source: 'openrailwaymap',
          sourceLayer: 'standard_railway_line_low',
          properties: { feature: 'rail', name: '京广高速线' },
        },
      ],
      { lookupLineLists },
    );
    expect(opened).toHaveLength(1);
    expect((opened[0] as HTMLElement).querySelector('.orm-popup-route-list')).toBeNull();
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    const [query] = lookupLineLists.mock.calls[0] as unknown as [
      { lng: number; lat: number; radius: number; name: string },
    ];
    expect(query).toMatchObject({ lng: 8.6, lat: 50.1, name: '京广高速线' });
    // Ten pixels at zoom 5 and latitude 50: about 16 km.
    expect(query.radius).toBeGreaterThan(15000);
    expect(query.radius).toBeLessThan(16500);
    expect((opened[1] as HTMLElement).querySelector('.orm-popup-section .orm-popup-route-list li').textContent).toBe(
      '京广高速线3001',
    );
  });

  it('ignores base map features', () => {
    expect(
      clickMap([{ source: 'openmaptiles', sourceLayer: 'transportation', properties: { class: 'rail' } }]),
    ).toEqual([]);
  });
});

describe('popupRoom', () => {
  it('caps an info box at the room on the roomier side of its point', () => {
    // Clicked at y 528 on a 1050 px map: 528 px above, 522 px below.
    expect(popupRoom(528, 1050)).toBe(528 - 68);
    expect(popupRoom(900, 1050)).toBe(900 - 68);
    expect(popupRoom(100, 1050)).toBe(950 - 68);
    expect(popupRoom(100, 200)).toBe(120);
  });
});
