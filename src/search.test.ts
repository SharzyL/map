import { describe, expect, it } from 'vitest';
import { crTrainHitDate } from './norikae.js';
import { servicePeriodNote, stationTimetableRequest } from './search.js';

describe('a found station’s timetable', () => {
  const hit = {
    type: 'station' as const,
    region: [] as string[],
    osm: [] as string[],
    lat: null as number | null,
    lon: null as number | null,
  };

  it('is Yahoo’s by its codes in Japan, China Railway’s by its name in China', () => {
    expect(stationTimetableRequest({ ...hit, country: 'jp', name: '新宿', codes: ['22741', '29342'] })).toEqual({
      name: '新宿',
      codes: ['22741', '29342'],
    });
    expect(stationTimetableRequest({ ...hit, country: 'cn', name: '北京西', telecode: 'BXP' })).toEqual({
      name: '北京西',
      cr: ['北京西'],
    });
  });

  it('is none for a Japanese station without a Yahoo code', () => {
    expect(stationTimetableRequest({ ...hit, country: 'jp', name: '名無し', codes: [] })).toBeNull();
  });
});

describe('a found train’s day', () => {
  const current = { service: { from: '2026-01-27', to: null as string | null } };
  const next = { service: { from: '2026-11-25', to: null as string | null } };
  const ended = { service: { from: '2024-04-02', to: '2026-11-24' } };

  it('is today while it runs, else the nearest day of its service', () => {
    expect(crTrainHitDate(current, '2026-11-15')).toBe('2026-11-15');
    expect(crTrainHitDate(next, '2026-11-15')).toBe('2026-11-25');
    expect(crTrainHitDate(ended, '2026-11-30')).toBe('2026-11-24');
  });

  it('is noted in its result when today is outside its service', () => {
    expect(servicePeriodNote(current, '2026-11-15')).toBe('');
    expect(servicePeriodNote(next, '2026-11-15')).toBe('Runs from 2026-11-25');
    expect(servicePeriodNote(ended, '2026-11-30')).toBe('Ran until 2026-11-24');
  });
});
