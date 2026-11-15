import { describe, expect, it } from 'vitest';
import { crTrainHitDate } from './norikae.js';
import { looksLikeTrainNumber, servicePeriodNote } from './search.js';

describe('looksLikeTrainNumber', () => {
  it('takes text that could start a train number, in any case or width', () => {
    for (const query of ['G1', 'g1', 'Z157', 'Ｇ１', 'G 1', '4401', '1'])
      expect(looksLikeTrainNumber(query)).toBe(true);
  });

  it('leaves place names to the place search', () => {
    for (const query of ['Gion', 'shanghai station', '北京南', 'GZ1']) expect(looksLikeTrainNumber(query)).toBe(false);
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
