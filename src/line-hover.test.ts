import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { hoveredLineOf, lineFilter, type HoveredLine } from './line-hover.js';

const HIGH_SPEED = '3216458\u001e\u001e京广高速铁路\u001e';
const OTHER_LINE = '42\u001e\u001e京广线\u001e';
const ROUTE = '12231217\u001e#BBA786\u001e15号线：顾村公园 -> 紫竹高新区';

function inLine(properties: Record<string, unknown>, line: HoveredLine) {
  const filter = lineFilter(line);
  if (!filter) return false;
  return featureFilter(filter as never).filter({ zoom: 12 }, { type: 2, properties } as never);
}

describe('hoveredLineOf', () => {
  it('takes the railway line named like the segment, else the first line, else the first route', () => {
    expect(hoveredLineOf({ name: '京广高速铁路', line_relations: `${OTHER_LINE}\u001d${HIGH_SPEED}` })).toEqual({
      id: '3216458',
      name: '京广高速铁路',
    });
    expect(hoveredLineOf({ name: 'x', line_relations: `${OTHER_LINE}\u001d${HIGH_SPEED}` }).id).toBe('42');
    expect(hoveredLineOf({ name: '15号线', line_routes: ROUTE }).id).toBe('12231217');
    expect(hoveredLineOf({ name: 'Siding' })).toEqual({ id: '', name: 'Siding' });
  });
});

describe('lineFilter', () => {
  const line = { id: '3216458', name: '京广高速铁路' };

  it('matches the segments listing the line', () => {
    expect(inLine({ line_relations: HIGH_SPEED }, line)).toBe(true);
    expect(inLine({ line_relations: `${OTHER_LINE}\u001d${HIGH_SPEED}` }, line)).toBe(true);
    expect(inLine({ line_relations: OTHER_LINE, name: '京广高速铁路' }, line)).toBe(false);
    expect(inLine({ line_routes: '3216458\u001e\u001eA' }, line)).toBe(true);
  });

  it('matches segments without relation lists, such as zoomed-out ones, by name', () => {
    expect(inLine({ name: '京广高速铁路' }, line)).toBe(true);
    expect(inLine({ name: '京沪高速铁路' }, line)).toBe(false);
    expect(inLine({ name: 'Siding' }, { id: '', name: 'Siding' })).toBe(true);
  });

  it('matches nothing for no line', () => {
    expect(lineFilter({ id: '', name: '' })).toBeNull();
    expect(inLine({ name: '' }, { id: '', name: '' })).toBe(false);
  });
});
