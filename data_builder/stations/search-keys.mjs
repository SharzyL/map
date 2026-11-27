// Adds to station-index.py's stations the keys the station search matches
// them by (src/worker/api/search-keys.ts, the Worker's own folding, so the
// index and the queries fold alike), and writes the index the Worker bundles:
// {"version": ..., "stations": [...]}, a station a line, the version the start
// of their hash.
//
// Usage: node data_builder/stations/search-keys.mjs <stations.json> <search-stations.json>
//
// Needs Node 22.18 or later, which runs the TypeScript module as it is.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hanFolder, stationKeys } from '../../src/worker/api/search-keys.ts';

const HAN_FOLD = new URL('../../src/worker/api/han-fold.json', import.meta.url);

export function buildIndex(stations, pairs = JSON.parse(readFileSync(HAN_FOLD, 'utf8'))) {
  const fold = hanFolder(pairs);
  const lines = stations.map((station) => JSON.stringify({ ...station, ...stationKeys(station, fold) }));
  const version = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12);
  return { version, text: `{"version":"${version}","stations":[\n${lines.join(',\n')}\n]}\n` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('Usage: node data_builder/stations/search-keys.mjs <stations.json> <search-stations.json>');
    process.exit(1);
  }
  const stations = JSON.parse(readFileSync(input, 'utf8'));
  const { version, text } = buildIndex(stations);
  writeFileSync(output, text);
  console.log(
    `${output}: version ${version}, ${stations.length} stations, ${(text.length / 1e6).toFixed(1)}M characters`,
  );
}
