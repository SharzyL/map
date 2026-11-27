// The API's response types (types.ts, which the doc shows after each
// endpoint's example, doc.md's `<!-- types: … -->` lines) against what the API
// answers: each endpoint's answer to the fixtures, and the doc's own examples,
// compiled as literals of their type, so a field the type lacks, or one it has
// that the answer lacks, fails to compile.

import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { ApiError, DataUnavailable, errorResponse, type Fetcher, type Query } from './core.js';
import { dispatchCr } from './cr.js';
import basicHtml from './fixtures/basic.html?raw';
import baseSql from './fixtures/cr-20261114.sql?raw';
import routesSql from './fixtures/cr-routes-20261114.sql?raw';
import trainsetJson from './fixtures/cr_trainset_G2705.json?raw';
import linesHtml from './fixtures/lines.html?raw';
import statusLinesHtml from './fixtures/status-lines.html?raw';
import statusTimetableHtml from './fixtures/status-timetable.html?raw';
import suggestJson from './fixtures/suggest.json?raw';
import timetableHtml from './fixtures/timetable.html?raw';
import trainHtml from './fixtures/train.html?raw';
import { handleApi } from './index.js';
import { dispatchSearch } from './search.js';
import DOC from './doc.md?raw';
import TYPES from './types.ts?raw';

const NOW = new Date('2026-11-15T23:30:00Z');

// types.ts's sections: name -> the types it declares, the response's first
function typeSections(): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] = [];
  for (const line of TYPES.split('\n')) {
    const mark = /^\/\/ @doc ([\w-]+)$/.exec(line);
    if (mark) sections.set(mark[1], (current = []));
    const declared = /^export (?:interface|type) (\w+)/.exec(line);
    if (declared) current.push(declared[1]);
  }
  return sections;
}

// Diagnostics of a module made of the types and the given declarations
function compile(declarations: string[]): string[] {
  const name = '/doc-types.ts';
  const source = `${TYPES}\n${declarations.join('\n')}\n`;
  const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, types: [] };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile;
  host.getSourceFile = (file, ...rest) =>
    file === name ? ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true) : read.call(host, file, ...rest);
  const program = ts.createProgram([name], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const at = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
    const line = at ? source.split('\n')[at - 1].trim().slice(0, 80) : '';
    return `${ts.flattenDiagnosticMessageText(d.messageText, '\n')} (at: ${line})`;
  });
}

const literal = (name: string, type: string, json: string) => `const ${name}: ${type} = ${json};`;

describe('the API doc’s types', () => {
  it('describe what each endpoint answers', async () => {
    const yahoo =
      (html: string): Fetcher =>
      async () => ({ status: 200, text: html });
    const api = async (path: string, html = '') =>
      (await handleApi('GET', `https://map.test${path}`, { fetch: yahoo(html), now: NOW })).body;
    const db = new DatabaseSync(':memory:');
    db.exec(baseSql);
    db.exec(routesSql);
    const query: Query = async (sql, params) => {
      try {
        return db.prepare(sql).all(...params);
      } catch (e) {
        throw new DataUnavailable(String(e));
      }
    };
    const cr = async (path: string) => {
      const url = new URL(path, 'https://map.test');
      try {
        return (await dispatchCr(url.pathname, url.searchParams, query, yahoo(trainsetJson), NOW)).body;
      } catch (e) {
        return errorResponse(e as ApiError).body;
      }
    };
    const answers: Array<[string, string]> = [
      ['ApiIndex', await api('/api/v1')],
      ['ErrorResponse', await api('/api/v1/nowhere')],
      ['RoutesResponse', await api('/api/v1/norikae/routes?from=渋谷&to=東京', basicHtml)],
      ['StationsResponse', await api('/api/v1/norikae/stations?q=渋谷', suggestJson)],
      ['LinesResponse', await api('/api/v1/norikae/stations/22715/timetables', linesHtml)],
      ['TimetableResponse', await api('/api/v1/norikae/stations/22715/timetables/1051', timetableHtml)],
      ['TrainResponse', await api('/api/v1/norikae/stations/22715/timetables/1051/trains/33471', trainHtml)],
      ['StationStatusResponse', await api('/api/v1/norikae/stations/21338/status', statusLinesHtml)],
      [
        'DirectionStatusResponse',
        await api('/api/v1/norikae/stations/21338/timetables/510/status', statusTimetableHtml),
      ],
      ['CrStationsResponse', await cr('/api/v1/cr/stations?q=bj')],
      ['CrTimetableResponse', await cr('/api/v1/cr/stations/天津南/timetable?date=2026-11-16')],
      ['CrTrainResponse', await cr('/api/v1/cr/trains/Z1?date=2026-11-15')],
      ['CrTrainRouteResponse', await cr('/api/v1/cr/trains/G1/route?date=2026-11-16')],
      ['CrTrainsetResponse', await cr('/api/v1/cr/trainsets/G2705?date=2026-11-14')],
      ['SearchResponse', dispatchSearch('/api/v1/search', new URLSearchParams('q=G1')).body],
      ['SearchResponse', dispatchSearch('/api/v1/search', new URLSearchParams('q=北京')).body],
    ];
    for (const [type, body] of answers)
      expect(JSON.parse(body), type).not.toHaveProperty('error.code', 'internal_error');
    expect(compile(answers.map(([type, body], i) => literal(`answer${i}`, type, body)))).toEqual([]);
  });

  it('describe the doc’s own examples', () => {
    // Each section's examples, of the first type its types declare
    const types = typeSections();
    const examples: string[] = [];
    const sections = DOC.split(/^(?=#{2,3} )/m);
    for (const section of sections) {
      const name = /^<!-- types: ([\w-]+) -->$/m.exec(section)?.[1];
      const type = name && types.get(name)?.[0];
      if (!type) continue;
      for (const [, json] of section.matchAll(/^```jsonc?\n([\s\S]*?)^```/gm)) {
        examples.push(literal(`example${examples.length}`, type, json));
      }
    }
    expect(examples.length).toBeGreaterThan(14);
    expect(compile(examples)).toEqual([]);
  });

  it('has a type after every endpoint', () => {
    const types = typeSections();
    for (const [, endpoint, body] of DOC.matchAll(/^### `GET ([^`]+)`\n([\s\S]*?)(?=^##)/gm)) {
      if (endpoint === '/api/v1/anitabi/{file}') continue; // anitabi's own files, passed on
      const name = /^<!-- types: ([\w-]+) -->$/m.exec(body)?.[1];
      expect(name && types.get(name)?.length, endpoint).toBeTruthy();
    }
  });
});
