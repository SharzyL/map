// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFeatureCatalog, popupContent } from './popup.js';

// Attributes of a real light rail segment and station in Frankfurt (OpenRailwayMap tiles).
const LINE_PROPERTIES = {
  id: '137315646-0',
  way_length: 654.85,
  feature: 'light_rail',
  state: 'present',
  usage: 'main',
  highspeed: false,
  tunnel: false,
  bridge: true,
  name: 'A-Strecke',
  ref: 'A',
  preferred_direction: 'forward',
  rank: 110,
  osm_id: '137315646',
  osm_type: 'W',
  maxspeed: 60,
  speed_label: '60',
  train_protection_rank: 1,
  train_protection0: 'pzb',
  train_protection1: 'etcs_2',
  electrification_state: 'present',
  voltage: 15000,
  frequency: 16.7,
  gaugeint0: 1435,
  gauge0: '1435',
  gauges: '1435, 1000',
  operator: 'VGF',
  primary_operator: 'VGF',
  radio: 'gsm-r',
  wikipedia: 'de:A-Strecke',
  line_routes: '66615\u001e#4a5eaa\u001eU3: Oberursel Hohemark => Südbahnhof',
  route_count: 1,
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
  it('groups line metadata into titled sections with readable values', () => {
    const { sections } = render('high', 'railway_line_high', LINE_PROPERTIES);
    expect(Object.keys(sections)).toEqual([
      'Line',
      'Speed',
      'Electrification',
      'Track',
      'Signalling & radio',
      'Operation',
      'Links',
      'Other',
    ]);
    expect(sections.Line).toEqual([
      ['State', 'Present'],
      ['Usage', 'Main'],
      ['Preferred direction', 'Forward'],
      ['Bridge', 'Yes'],
    ]);
    expect(sections.Speed).toEqual([['Maximum speed', '60 km/h']]);
    expect(sections.Electrification).toEqual([
      ['Electrification', 'Electrified'],
      ['Voltage', '15 kV'],
      ['Frequency', '16.7 Hz'],
    ]);
    expect(sections.Track).toEqual([['Gauge', '1435 mm, 1000 mm']]);
    expect(sections['Signalling & radio']).toEqual([
      ['Train protection', 'PZB, ETCS 2'],
      ['Radio', 'GSM-R'],
    ]);
    expect(sections.Operation).toEqual([['Operator', 'VGF']]);
    expect(sections.Links).toEqual([['Wikipedia', 'A-Strecke']]);
    expect(sections.Other).toEqual([['Unexpected tag', 'kept']]);
  });

  it('links external references and keeps routes below the sections', () => {
    const { content } = render('high', 'railway_line_high', LINE_PROPERTIES);
    const link = content.querySelector<HTMLAnchorElement>('.orm-popup-fields a');
    expect(link.href).toBe('https://wikipedia.org/wiki/de%3AA-Strecke');
    expect(content.querySelector('.orm-popup-route-list').textContent).toContain('U3: Oberursel Hohemark');
    expect(content.querySelector('.orm-popup-badges')).toBeNull();
  });

  it('shows DC lines without a frequency in hertz', () => {
    const { sections } = render('high', 'railway_line_high', { ...LINE_PROPERTIES, voltage: 750, frequency: 0 });
    expect(sections.Electrification).toEqual([
      ['Electrification', 'Electrified'],
      ['Voltage', '750 V'],
      ['Frequency', 'DC'],
    ]);
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
