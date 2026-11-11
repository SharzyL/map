import {
  createExpression,
  featureFilter,
  latest,
  validateStyleMin,
  type StyleSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import ormStyleText from '../public/orm/style/standard.json?raw';
import {
  applyRailwayFilterToStyle,
  countActiveRailwayFilters,
  defaultRailwayFilterSettings,
  loadRailwayFilterSettings,
  normalizeRailwayFilterSettings,
  RAILWAY_FILTER_STORAGE_KEY,
  RAILWAY_LINE_FILTER,
  RAILWAY_STATION_AREA_FILTER,
  RAILWAY_STATION_AREA_SOURCE_LAYER,
  RAILWAY_STATION_FILTER,
  RAILWAY_STATION_SOURCE_LAYERS,
  railwayFilterGlobalState,
  saveRailwayFilterSettings,
  withTunnelAndBridgeMarks,
  type RailwayFilterSettings,
} from './railway-filter.js';

type Properties = Record<string, string | number | boolean>;

function settingsWith(patch: (settings: RailwayFilterSettings) => void) {
  const settings = defaultRailwayFilterSettings();
  patch(settings);
  return settings;
}

function lineVisible(properties: Properties, settings = defaultRailwayFilterSettings()) {
  const filter = featureFilter(RAILWAY_LINE_FILTER as never, railwayFilterGlobalState(settings));
  return filter.filter({ zoom: 12 }, { type: 2, properties } as never);
}

function stationVisible(properties: Properties, settings = defaultRailwayFilterSettings()) {
  const filter = featureFilter(RAILWAY_STATION_FILTER as never, railwayFilterGlobalState(settings));
  return filter.filter({ zoom: 12 }, { type: 1, properties } as never);
}

function stationAreaVisible(properties: Properties, settings = defaultRailwayFilterSettings()) {
  const filter = featureFilter(RAILWAY_STATION_AREA_FILTER as never, railwayFilterGlobalState(settings));
  return filter.filter({ zoom: 14 }, { type: 3, properties } as never);
}

function onlyCategories(...categories: Array<keyof RailwayFilterSettings['categories']>) {
  return settingsWith((settings) => {
    for (const key of Object.keys(settings.categories) as Array<keyof typeof settings.categories>) {
      settings.categories[key] = categories.includes(key);
    }
  });
}

const MAIN_LINE = { feature: 'rail', usage: 'main', state: 'present', maxspeed: 160, electrification_state: 'present' };

describe('railway line filter expression', () => {
  it('shows every line with default settings', () => {
    for (const properties of [
      MAIN_LINE,
      { feature: 'rail', service: 'yard' },
      { feature: 'tram' },
      { feature: 'narrow_gauge' },
      { feature: 'miniature' },
    ]) {
      expect(lineVisible(properties)).toBe(true);
    }
  });

  it('classifies lines into categories with urban and service tracks first', () => {
    const only = (category: keyof RailwayFilterSettings['categories']) => onlyCategories(category);
    expect(lineVisible(MAIN_LINE, only('main'))).toBe(true);
    expect(lineVisible({ feature: 'rail', usage: 'branch' }, only('branch'))).toBe(true);
    expect(lineVisible({ feature: 'rail', usage: 'military' }, only('industrial'))).toBe(true);
    expect(lineVisible({ feature: 'rail', usage: 'main', service: 'siding' }, only('service'))).toBe(true);
    expect(lineVisible({ feature: 'rail', usage: 'main', service: 'siding' }, only('main'))).toBe(false);
    expect(lineVisible({ feature: 'subway', usage: 'main' }, only('urban'))).toBe(true);
    expect(lineVisible({ feature: 'subway', usage: 'main' }, only('main'))).toBe(false);
    expect(lineVisible({ feature: 'miniature' }, only('tourism'))).toBe(true);
    expect(lineVisible({ feature: 'rail' }, only('other'))).toBe(true);
    expect(lineVisible({ feature: 'rail' }, only('main'))).toBe(false);
  });

  it('filters by minimum speed and treats missing speed separately', () => {
    const fast = settingsWith((settings) => (settings.minSpeed = 200));
    expect(lineVisible({ ...MAIN_LINE, maxspeed: 250 }, fast)).toBe(true);
    expect(lineVisible({ ...MAIN_LINE, maxspeed: 160 }, fast)).toBe(false);
    expect(lineVisible({ feature: 'rail', usage: 'main' }, fast)).toBe(true);

    const fastKnownOnly = settingsWith((settings) => {
      settings.minSpeed = 200;
      settings.includeUnknown = false;
    });
    expect(lineVisible({ feature: 'rail', usage: 'main' }, fastKnownOnly)).toBe(false);
    expect(lineVisible({ ...MAIN_LINE, maxspeed: 300 }, fastKnownOnly)).toBe(true);
  });

  it('filters by gauge, matching any gauge of dual-gauge lines', () => {
    const standard = settingsWith((settings) => (settings.gauge = 'standard'));
    const broad = settingsWith((settings) => (settings.gauge = 'broad'));
    const narrow = settingsWith((settings) => (settings.gauge = 'narrow'));
    expect(lineVisible({ ...MAIN_LINE, gaugeint0: 1435 }, standard)).toBe(true);
    expect(lineVisible({ ...MAIN_LINE, gaugeint0: 1520 }, standard)).toBe(false);
    expect(lineVisible({ ...MAIN_LINE, gaugeint0: 1520 }, broad)).toBe(true);
    expect(lineVisible({ ...MAIN_LINE, gaugeint0: 1067 }, narrow)).toBe(true);
    expect(lineVisible({ ...MAIN_LINE, gaugeint0: 1435, gaugeint1: 1000 }, narrow)).toBe(true);
    expect(lineVisible(MAIN_LINE, standard)).toBe(true);
    const strict = settingsWith((settings) => {
      settings.gauge = 'standard';
      settings.includeUnknown = false;
    });
    expect(lineVisible(MAIN_LINE, strict)).toBe(false);
  });

  it('filters by traffic mode, counting mixed traffic for both', () => {
    const passenger = settingsWith((settings) => {
      settings.traffic = 'passenger';
      settings.includeUnknown = false;
    });
    const freight = settingsWith((settings) => {
      settings.traffic = 'freight';
      settings.includeUnknown = false;
    });
    expect(lineVisible({ ...MAIN_LINE, traffic_mode: 'passenger' }, passenger)).toBe(true);
    expect(lineVisible({ ...MAIN_LINE, traffic_mode: 'mixed' }, passenger)).toBe(true);
    expect(lineVisible({ ...MAIN_LINE, traffic_mode: 'freight' }, passenger)).toBe(false);
    expect(lineVisible({ ...MAIN_LINE, traffic_mode: 'freight' }, freight)).toBe(true);
    expect(lineVisible(MAIN_LINE, freight)).toBe(false);
    expect(
      lineVisible(
        MAIN_LINE,
        settingsWith((settings) => (settings.traffic = 'freight')),
      ),
    ).toBe(true);
  });

  it('filters by operator substring, case-insensitively, across multiple operators', () => {
    const db = settingsWith((settings) => (settings.operator = 'DB Netz'));
    expect(lineVisible({ ...MAIN_LINE, operator: 'DB Netz AG' }, db)).toBe(true);
    expect(lineVisible({ ...MAIN_LINE, operator: 'db netz ag' }, db)).toBe(true);
    expect(lineVisible({ ...MAIN_LINE, operator: 'SBB\u001eDB Netz AG' }, db)).toBe(true);
    expect(lineVisible({ ...MAIN_LINE, operator: 'SNCF Réseau' }, db)).toBe(false);
    expect(lineVisible(MAIN_LINE, db)).toBe(false);
  });

  it('filters by electrification', () => {
    const electrified = settingsWith((settings) => (settings.electrification = 'electrified'));
    const notElectrified = settingsWith((settings) => (settings.electrification = 'not-electrified'));
    expect(lineVisible(MAIN_LINE, electrified)).toBe(true);
    expect(lineVisible({ ...MAIN_LINE, electrification_state: 'no' }, electrified)).toBe(false);
    expect(lineVisible({ ...MAIN_LINE, electrification_state: 'no' }, notElectrified)).toBe(true);
    expect(lineVisible({ feature: 'rail', usage: 'main' }, notElectrified)).toBe(true);
    expect(lineVisible(MAIN_LINE, notElectrified)).toBe(false);
  });
});

describe('railway station filter expression', () => {
  const RAIL_STATION = { feature: 'station', station: 'train' };
  const SUBWAY_STATION = { feature: 'station', station: 'subway' };
  const TRAM_STOP = { feature: 'tram_stop', station: 'tram' };
  const YARD = { feature: 'yard', station: 'train' };

  it('shows every station with default settings', () => {
    for (const properties of [RAIL_STATION, SUBWAY_STATION, TRAM_STOP, YARD, { type: 'subway' }, { type: 'train' }]) {
      expect(stationVisible(properties)).toBe(true);
    }
  });

  it('hides urban stops, entrances and stop positions with urban transit', () => {
    const noUrban = settingsWith((settings) => (settings.categories.urban = false));
    expect(stationVisible(SUBWAY_STATION, noUrban)).toBe(false);
    expect(stationVisible(TRAM_STOP, noUrban)).toBe(false);
    expect(stationVisible({ type: 'subway' }, noUrban)).toBe(false);
    expect(stationVisible(RAIL_STATION, noUrban)).toBe(true);
    expect(stationVisible({ type: 'train' }, noUrban)).toBe(true);
  });

  it('ties yards and junctions to service tracks', () => {
    const noService = settingsWith((settings) => (settings.categories.service = false));
    expect(stationVisible(YARD, noService)).toBe(false);
    expect(stationVisible({ feature: 'junction', station: 'train' }, noService)).toBe(false);
    expect(stationVisible(RAIL_STATION, noService)).toBe(true);
  });

  it('keeps rail stations while any rail line category is shown', () => {
    expect(stationVisible(RAIL_STATION, onlyCategories('branch'))).toBe(true);
    expect(stationVisible(RAIL_STATION, onlyCategories('urban', 'service'))).toBe(false);
    expect(stationVisible(SUBWAY_STATION, onlyCategories('urban'))).toBe(true);
    expect(stationVisible({ feature: 'station', station: 'miniature' }, onlyCategories('tourism'))).toBe(true);
    expect(stationVisible({ feature: 'station', station: 'miniature' }, onlyCategories('main'))).toBe(false);
  });

  it('ignores speed and electrification', () => {
    const strict = settingsWith((settings) => {
      settings.minSpeed = 250;
      settings.includeUnknown = false;
      settings.electrification = 'electrified';
      settings.gauge = 'narrow';
      settings.traffic = 'freight';
      settings.operator = 'nobody';
    });
    expect(stationVisible(RAIL_STATION, strict)).toBe(true);
  });
});

describe('railway station area filter expression', () => {
  const URBAN_AREA = { feature: 'station_area_group', has_urban_station: true, has_rail_station: false };
  const MIXED_AREA = { feature: 'station_area_group', has_urban_station: true, has_rail_station: true };
  const RAIL_AREA = { feature: 'station_area_group', has_urban_station: false, has_rail_station: true };

  it('keeps an outline while any of its station kinds is shown', () => {
    const noUrban = settingsWith((settings) => (settings.categories.urban = false));
    expect(stationAreaVisible(URBAN_AREA)).toBe(true);
    expect(stationAreaVisible(URBAN_AREA, noUrban)).toBe(false);
    expect(stationAreaVisible(MIXED_AREA, noUrban)).toBe(true);
    expect(stationAreaVisible(RAIL_AREA, noUrban)).toBe(true);
    expect(stationAreaVisible(MIXED_AREA, onlyCategories('urban'))).toBe(true);
    expect(stationAreaVisible(RAIL_AREA, onlyCategories('urban'))).toBe(false);
  });

  it('falls back to hiding untagged outlines only when every category is off', () => {
    const untagged = { feature: 'station_area_group' };
    expect(stationAreaVisible(untagged, onlyCategories('service'))).toBe(true);
    expect(stationAreaVisible(untagged, onlyCategories())).toBe(false);
  });
});

describe('applyRailwayFilterToStyle', () => {
  const ormStyle = JSON.parse(ormStyleText) as StyleSpecification;
  const railwaySources = Object.entries(ormStyle.sources)
    .filter(([, source]) => source.type === 'vector' && typeof source.url === 'string' && source.url.startsWith('/'))
    .map(([name]) => name);

  it('produces a valid style from the generated ORM style', () => {
    const styled = applyRailwayFilterToStyle(ormStyle, railwaySources, defaultRailwayFilterSettings());
    expect(validateStyleMin(styled)).toEqual([]);
  });

  it('adds line and station filters and the overlay switch to railway layers only', () => {
    const styled = applyRailwayFilterToStyle(ormStyle, railwaySources, defaultRailwayFilterSettings());
    const original = new Map(ormStyle.layers.map((layer) => [layer.id, layer]));
    let lineLayers = 0;
    let stationLayers = 0;
    for (const layer of styled.layers) {
      const before = original.get(layer.id);
      if (!('source' in layer) || !railwaySources.includes(layer.source)) {
        expect(layer).toEqual(withTunnelAndBridgeMarks(before));
        continue;
      }
      expect(JSON.stringify(layer.layout?.visibility)).toContain('railwayOverlay');
      const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : undefined;
      if (sourceLayer === 'railway_line_high' || sourceLayer === 'standard_railway_line_low') {
        lineLayers += 1;
        expect(layer.filter).toEqual(['all', 'filter' in before ? before.filter : undefined, RAILWAY_LINE_FILTER]);
      } else if (RAILWAY_STATION_SOURCE_LAYERS.includes(sourceLayer)) {
        stationLayers += 1;
        const beforeFilter = 'filter' in before ? before.filter : undefined;
        expect(layer.filter).toEqual(
          beforeFilter ? ['all', beforeFilter, RAILWAY_STATION_FILTER] : RAILWAY_STATION_FILTER,
        );
      } else if (sourceLayer === RAILWAY_STATION_AREA_SOURCE_LAYER) {
        stationLayers += 1;
        const beforeFilter = 'filter' in before ? before.filter : undefined;
        expect(layer.filter).toEqual(
          beforeFilter ? ['all', beforeFilter, RAILWAY_STATION_AREA_FILTER] : RAILWAY_STATION_AREA_FILTER,
        );
      } else {
        expect(layer.filter).toEqual('filter' in before ? before.filter : undefined);
      }
    }
    expect(lineLayers).toBeGreaterThan(300);
    expect(stationLayers).toBeGreaterThan(5);
  });

  it('switches the tunnel and bridge marks of current and historical lines only', () => {
    const styled = applyRailwayFilterToStyle(ormStyle, railwaySources, defaultRailwayFilterSettings());
    const switched = styled.layers.filter((layer) =>
      JSON.stringify('layout' in layer ? layer.layout?.visibility : null).includes('railwayTunnelsAndBridges'),
    );
    const ids = switched.map(({ id }) => id);
    expect(ids.every((id) => /_(tunnel_cover|bridge_railing)$/.test(id))).toBe(true);
    expect(ids).toContain('railway_line_light_rail_tunnel_cover');
    expect(ids).toContain('railway_line_main_high_bridge_railing');
    expect(ids).toContain('railway_line_historical_light_rail_tunnel_cover');
    expect(ids).not.toContain('railway_line_main_high_bridge_casing');
    expect(ids.length).toBeGreaterThan(60);

    const cover = switched.find(({ id }) => id === 'railway_line_light_rail_tunnel_cover');
    const visibility = (shown: boolean) => {
      const state = { date: 2026, railwayOverlay: true, railwayTunnelsAndBridges: shown };
      const parsed = createExpression(cover.layout.visibility, latest.layout_line.visibility as never, state);
      expect(parsed.result).toBe('success');
      return (parsed.value as { evaluate(globals: object): unknown }).evaluate({ zoom: 12 });
    };
    expect(visibility(false)).toBe('none');
    expect(visibility(true)).toBe('visible');
  });

  it('seeds the global state defaults from the settings', () => {
    const settings = settingsWith((next) => {
      next.overlay = false;
      next.minSpeed = 160;
      next.statuses.showAbandonedInfrastructure = true;
      next.colorBy = 'electrification';
      next.tunnelsAndBridges = true;
    });
    const styled = applyRailwayFilterToStyle(ormStyle, railwaySources, settings);
    expect(styled.state.railwayOverlay.default).toBe(false);
    expect(styled.state.railwayColorBy.default).toBe('electrification');
    expect(styled.state.railwayTunnelsAndBridges.default).toBe(true);
    expect(styled.state.railwayMinSpeed.default).toBe(160);
    expect(styled.state.showAbandonedInfrastructure.default).toBe(true);
  });
});

describe('railway filter settings', () => {
  it('normalizes unknown or invalid stored values back to defaults', () => {
    expect(normalizeRailwayFilterSettings(null)).toEqual(defaultRailwayFilterSettings());
    const normalized = normalizeRailwayFilterSettings({
      overlay: 'no',
      colorBy: 'rainbow',
      tunnelsAndBridges: 'yes',
      categories: { main: false, bogus: false },
      minSpeed: 123,
      electrification: 'electrified',
      gauge: 'metric',
      traffic: 'freight',
      operator: '  DB Netz  ',
    });
    expect(normalized.overlay).toBe(true);
    expect(normalized.colorBy).toBe('default');
    expect(normalizeRailwayFilterSettings({ colorBy: 'gauge' }).colorBy).toBe('gauge');
    expect(normalized.tunnelsAndBridges).toBe(false);
    expect(normalizeRailwayFilterSettings({ tunnelsAndBridges: true }).tunnelsAndBridges).toBe(true);
    expect(normalized.categories.main).toBe(false);
    expect(normalized.minSpeed).toBe(0);
    expect(normalized.electrification).toBe('electrified');
    expect(normalized.gauge).toBe('any');
    expect(normalized.traffic).toBe('freight');
    expect(normalized.operator).toBe('DB Netz');
  });

  it('round-trips through storage and survives broken storage', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const settings = settingsWith((next) => (next.minSpeed = 250));
    saveRailwayFilterSettings(settings, storage);
    expect(values.has(RAILWAY_FILTER_STORAGE_KEY)).toBe(true);
    expect(loadRailwayFilterSettings(storage)).toEqual(settings);

    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadRailwayFilterSettings(throwing)).toEqual(defaultRailwayFilterSettings());
    expect(() => saveRailwayFilterSettings(settings, throwing)).not.toThrow();
  });

  it('counts filters that differ from the defaults', () => {
    expect(countActiveRailwayFilters(defaultRailwayFilterSettings())).toBe(0);
    const settings = settingsWith((next) => {
      next.categories.service = false;
      next.minSpeed = 120;
      next.electrification = 'electrified';
      next.statuses.showProposedInfrastructure = false;
      next.gauge = 'broad';
      next.traffic = 'passenger';
      next.operator = 'SNCF';
      next.colorBy = 'speed';
    });
    expect(countActiveRailwayFilters(settings)).toBe(7);
  });
});
