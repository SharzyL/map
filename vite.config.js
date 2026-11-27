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

// The data the Worker bundles, as `build-data/<file>`: the station files
// (src/worker/api/osm-stations.ts) and the search's indexes of trains and
// stations (search.ts, station-search.ts). They are build outputs: the
// build's own (data_builder/steps.toml) when it ran here, or where the
// variable says; else a few stations' and trains' worth from the test
// fixtures, so the app still starts.
const BUILD_DATA = [
  ['jp-station-codes.csv', 'JP_STATION_CODES', 'jp-station-codes'],
  ['station-coords.csv', 'STATION_COORDS', 'station-coords'],
  ['cr-search.json', 'CR_SEARCH', 'cr-search'],
  ['search-stations.json', 'SEARCH_STATIONS', 'station-index'],
];

function buildDataFile(name, variable, step) {
  const candidates = [
    process.env[variable],
    `.build/out/${step}/${name}`,
    `src/worker/api/fixtures/build-data/${name}`,
  ];
  return resolve(candidates.find((path) => path && existsSync(path)));
}

// The API doc's page (/api/v1/doc), which the data build renders from
// public/api/v1/doc.md (data_builder/api-doc/render.py): the build's own, or
// where API_DOC_HTML says, as the static asset api/v1/doc.html, which the
// Worker's assets serve at /api/v1/doc. Without one the Worker sends that path
// to the Markdown.
function apiDocPage() {
  const file = [process.env.API_DOC_HTML, '.build/out/api-doc/doc.html'].find((path) => path && existsSync(path));
  return [
    {
      name: 'api-doc-page',
      applyToEnvironment: (environment) => environment.name === 'client',
      generateBundle() {
        if (file) this.emitFile({ type: 'asset', fileName: 'api/v1/doc.html', source: readFileSync(file) });
      },
    },
    // Apart: a plugin of one environment gets no server hooks
    {
      name: 'api-doc-page-dev',
      apply: 'serve',
      configureServer(server) {
        if (!file) return;
        server.middlewares.use((req, res, next) => {
          if (req.url?.split('?')[0] !== '/api/v1/doc') return next();
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(readFileSync(file));
        });
      },
    },
  ];
}

export default defineConfig({
  resolve: {
    // Patterns: an alias by name does not match an import with a ?raw query
    alias: BUILD_DATA.map(([name, variable, step]) => ({
      find: new RegExp(`^build-data/${name.replace(/\./g, '\\.')}`),
      replacement: buildDataFile(name, variable, step),
    })),
  },
  plugins: [
    mapResourceHints(),
    apiDocPage(),
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
