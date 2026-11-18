import { describe, expect, it } from 'vitest';

import { buildUrl, parseRoutes, routeErrors, withPage, type BuildUrlArgs } from './routes.js';

const FIXTURES: Record<string, string> = import.meta.glob(
  ['../fixtures/*.html', '../fixtures/*.routes.expected.json'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);
const fixture = (name: string) => FIXTURES[`../fixtures/${name}`];

describe('parseRoutes', () => {
  // The expected files hold what the Python Worker parsed from the same pages
  for (const name of ['basic', 'airline', 'ferry', 'shinkansen_reserved', 'no_station']) {
    it(`parses ${name}.html as the Python Worker did`, () => {
      const html = fixture(`${name}.html`);
      const expected = JSON.parse(fixture(`${name}.routes.expected.json`));
      expect(parseRoutes(html)).toEqual(expected.routes);
      expect(routeErrors(html)).toEqual(expected.errors);
    });
  }

  it('reads legs, platforms and fares', () => {
    const [route] = parseRoutes(fixture('basic.html'));
    expect(route.legs[0].from.name).toBe('渋谷');
    expect(route.fare.total).toBeGreaterThan(0);
  });

  it('finds no errors on a page without page data', () => {
    expect(routeErrors('<html></html>')).toEqual([]);
    expect(parseRoutes('<html></html>')).toEqual([]);
  });
});

describe('buildUrl', () => {
  const args: BuildUrlArgs = {
    stations: ['新宿', '渋谷', '品川', '東京'],
    date: '2026/12/01',
    hour: 21,
    minute: 5,
    timeType: 'arrival',
    ticket: 'cash',
    seatPreference: 'green',
    walkSpeed: 'fast',
    sortBy: 'fare',
    noAirline: false,
    noShinkansen: true,
    noExpress: false,
    noHighwayBus: true,
    noLocalBus: true,
    noFerry: false,
  };

  // Both URLs are what the Python Worker built for the same arguments
  it('maps the options to Yahoo parameters', () => {
    expect(withPage(buildUrl(args), 2)).toBe(
      'https://transit.yahoo.co.jp/search/result?from=%E6%96%B0%E5%AE%BF&to=%E6%9D%B1%E4%BA%AC&y=2026&m=12&d=01' +
        '&hh=21&m1=0&m2=5&type=4&ticket=normal&expkind=3&ws=1&s=1&al=1&shin=0&ex=1&hb=0&lb=0&sr=1' +
        '&via=%E6%B8%8B%E8%B0%B7&via=%E5%93%81%E5%B7%9D&fl=4&tl=6',
    );
  });

  it('encodes station names as quote_plus does', () => {
    const url = buildUrl({
      ...args,
      stations: ["A B&C/'!()*~", 'x+y=z'],
      date: '2026/1/5',
      hour: 0,
      minute: 0,
      timeType: 'departure',
      ticket: 'ic',
      seatPreference: 'non_reserved',
      walkSpeed: 'slightly_slow',
      sortBy: 'time',
      noAirline: true,
      noShinkansen: false,
      noExpress: true,
      noHighwayBus: false,
      noLocalBus: false,
      noFerry: true,
    });
    expect(url).toBe(
      'https://transit.yahoo.co.jp/search/result?from=A+B%26C%2F%27%21%28%29%2A~&to=x%2By%3Dz&y=2026&m=01&d=05' +
        '&hh=0&m1=0&m2=0&type=1&ticket=ic&expkind=1&ws=3&s=0&al=0&shin=1&ex=0&hb=1&lb=1&sr=0',
    );
    expect(withPage(url, 1)).toBe(url);
  });
});
