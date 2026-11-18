import { defineConfig } from 'vite';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { cloudflare } from '@cloudflare/vite-plugin';

function fileHash(path) {
  try {
    return createHash('md5').update(readFileSync(path)).digest('hex').slice(0, 8);
  } catch {
    return Date.now().toString(36);
  }
}

const STYLE_HASH = fileHash('public/orm/style/standard.json');

// Starts the first map requests while the app's JavaScript is still loading:
// connections to the tile hosts, and the two styles and the tile archive's
// version main.ts fetches before it can create the map. The style URL must match main.ts's STYLE_URL exactly,
// including the hash, and the crossorigin mode must match fetch()'s default,
// or the browser downloads it twice.
function mapResourceHints() {
  return {
    name: 'map-resource-hints',
    transformIndexHtml(_html, context) {
      // For the map's page only, not the build dashboard's
      if (context.path !== '/index.html') return [];
      const link = (attrs) => ({ tag: 'link', attrs, injectTo: 'head-prepend' });
      return [
        link({ rel: 'preconnect', href: 'https://tiles.openfreemap.org', crossorigin: '' }),
        link({ rel: 'preconnect', href: 'https://tiles.mapterhorn.com', crossorigin: '' }),
        link({ rel: 'preload', href: `/orm/style/standard.json?v=${STYLE_HASH}`, as: 'fetch', crossorigin: '' }),
        link({ rel: 'preload', href: 'https://tiles.openfreemap.org/styles/liberty', as: 'fetch', crossorigin: '' }),
        link({ rel: 'preload', href: '/tiles/openrailwaymap/version', as: 'fetch', crossorigin: '' }),
      ];
    },
  };
}

// The station files the Worker bundles (src/worker/api/osm-stations.ts) are
// build outputs: the build's own (scripts/build/steps.toml) when it ran here,
// or where JP_STATION_CODES and STATION_COORDS say; else a few stations' worth
// from the test fixtures, so the app still starts.
function stationFile(name, variable, step) {
  const candidates = [process.env[variable], `.build/out/${step}/${name}`, `src/worker/api/fixtures/stations/${name}`];
  return resolve(candidates.find((path) => path && existsSync(path)));
}

export default defineConfig({
  resolve: {
    // Patterns: an alias by name does not match an import with a ?raw query
    alias: [
      {
        find: /^station-data\/jp-station-codes\.csv/,
        replacement: stationFile('jp-station-codes.csv', 'JP_STATION_CODES', 'jp-station-codes'),
      },
      {
        find: /^station-data\/station-coords\.csv/,
        replacement: stationFile('station-coords.csv', 'STATION_COORDS', 'station-coords'),
      },
    ],
  },
  plugins: [
    mapResourceHints(),
    cloudflare({
      remoteBindings: process.env.CLOUDFLARE_VITE_REMOTE_BINDINGS !== '0',
    }),
  ],
  // Two pages: the map, and the build dashboard (/build-dashboard). For the
  // browser's build only; the Worker's has its own entry.
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: { main: 'index.html', 'build-dashboard': 'build-dashboard/index.html' },
        },
      },
    },
  },
  define: {
    __STYLE_HASH__: JSON.stringify(STYLE_HASH),
    __SCREENSHOT_FIXTURES__: JSON.stringify(process.env.SCREENSHOT_FIXTURES === '1'),
  },
  server: {
    host: true,
  },
});
