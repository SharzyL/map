# Sharzy's Map

An opinionated MapLibre-based online map, with vector tiles, railway data from OpenRailwayMap and many
else. Based on https://openrailwaymap.app and https://github.com/Enter-tainer/atlas-realm.

## Deployment Notes

The site is one Cloudflare Worker (`wrangler.toml`): it serves the built app as static assets and the
railway vector tiles from a PMTiles archive in R2. It needs no database and no secrets.

### Prerequisites

- Node 22 and pnpm (`pnpm install`).
- A Cloudflare account with an R2 bucket for the tiles.
- Wrangler logged in (`pnpm exec wrangler login`), or `CLOUDFLARE_API_TOKEN` set. An API token needs
  Workers Scripts edit, R2 edit, and for the custom domain Workers Routes and DNS edit on the zone.
  `pnpm dev` with remote bindings also needs Workers Scripts edit to open its remote preview session.
- The GitHub CLI (`gh`), logged in, to set repository secrets and run the tile export.

### 1. Configure `wrangler.toml`

Edit `wrangler.toml` for your account before building or deploying anything:

- `name`: the worker name.
- `routes`: replace `map.shz.al` with your own hostname. The zone must be on the same Cloudflare
  account; the custom domain and its DNS record are created on the first deploy. To serve from
  `<name>.<subdomain>.workers.dev` instead, remove `routes` and set `workers_dev = true`.
- `[[r2_buckets]]` `bucket_name`: your bucket. The tile workflows upload to a bucket named `orm`
  (`s3://orm/` in `.github/workflows/export-pmtiles.yml` and `cleanup-r2-test-files.yml`), so name it
  `orm` or change those too.

### 2. Build and upload the railway tiles

The railway overlay reads `openrailwaymap.pmtiles` from the bucket, so upload it before the first deploy;
until it exists, every tile request fails. The archive (several GB, worldwide, zoom 0-15) is built by
`scripts/tiles/export-tippecanoe.sh` from the OpenRailwayMap import database image
(`ghcr.io/hiddewie/openrailwaymap-import-db`), normally on GitHub Actions:

1. Once: create an R2 API token with Object Read & Write on the bucket, export its keys as
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and the account ID as `R2_ACCOUNT_ID`, then run
   `./scripts/tiles/set-r2-secrets.sh <owner>/<repo>` to store them as repository secrets.
2. Run the "Export PMTiles" workflow (`.github/workflows/export-pmtiles.yml`, manual only). It builds
   the archive (about 40 minutes) and uploads it to `orm/openrailwaymap.pmtiles`. Railway line
   relations (`route=railway`) and the track counts and opening dates of railway ways are not in the
   database, so the workflow also streams the planet file through osmium to collect them and updates
   them with hourly diffs (`scripts/tiles/fetch-line-relations.sh`; input `line_relations_pbf`, `none`
   skips them):

   ```bash
   REPO=<owner>/<repo>
   gh workflow run export-pmtiles.yml -R "$REPO"                 # worldwide, zoom 0-15
   gh run list -R "$REPO" -w export-pmtiles.yml -L 1             # the new run's ID (may take a few seconds)
   gh run watch <run-id> -R "$REPO" --interval 60 --exit-status
   ```

   Inputs are passed with `-f`: `max_zoom` (default 15) and `bbox` (`minlon,minlat,maxlon,maxlat`).
   A run with a `bbox`, for example `-f bbox=5.8,47.2,15.1,55.1 -f max_zoom=12`, uploads a test
   archive `openrailwaymap-test-<run-id>.pmtiles` instead of replacing the real one; open it with
   `?tileset=openrailwaymap-test-<run-id>`, and remove all test archives with
   `gh workflow run cleanup-r2-test-files.yml -R "$REPO"`.

To build locally instead, start the database image (`docker run -p 5432:5432
-e POSTGRES_HOST_AUTH_METHOD=trust -e PGDATA=/data/postgresql --shm-size=2g
ghcr.io/hiddewie/openrailwaymap-import-db:latest`; podman rejects the image's empty `ENV` entries) and
run the script with `DATABASE_URL`, `MAX_ZOOM` and optionally `BBOX` set; it needs GDAL (`ogr2ogr`) and
tippecanoe and writes to `output/`. Upload large archives with an S3 client against
`https://<account-id>.r2.cloudflarestorage.com`; `wrangler r2 object put` stops at 300 MiB.

The export's layer names, attributes and per-layer zoom filters are what the map style, the railway
filter, the route highlight and the info boxes read, so change them together.

### 3. Deploy the site

```bash
pnpm run deploy   # vite build, then wrangler deploy (`pnpm deploy` is a different, built-in command)
```

When you replace the archive later, bump `TILE_VERSION` in `src/main.ts` and deploy again. The version
is part of every tile URL, so this is what makes browsers and the edge cache stop serving tiles from
the previous archive.

## Development Guide

### Running locally

```bash
pnpm install
pnpm dev       # Vite + the worker; tiles come from the real R2 bucket (needs wrangler auth)
pnpm preview   # production build served by `wrangler dev`
```

To work without Cloudflare access, run fully local and put a small archive in the local R2 bucket:

```bash
pmtiles extract <in.pmtiles> <small.pmtiles> --bbox=<west>,<south>,<east>,<north>
pnpm exec wrangler r2 object put orm/openrailwaymap.pmtiles --file <small.pmtiles> --local
CLOUDFLARE_VITE_REMOTE_BINDINGS=0 pnpm dev
```

`?tileset=<archive name>` loads another archive from the bucket, e.g. a test export.

### Project layout

- `src/main.ts` builds the map: it merges the OpenFreeMap base style with the OpenRailwayMap style,
  adds terrain, contours and satellite imagery, and installs the feature modules.
- `src/worker/` is the Cloudflare Worker: static assets plus `/tiles/*` served from PMTiles in R2.
- Panels: `map-layers-panel.ts` (Layers: base map, labels, terrain), `railway-filter-panel.ts`
  (Railways: filter, tunnel and bridge marks, and line colors by route, usage, speed, electrification or gauge from `railway-colors.ts`), `annotation-tools.ts` (Annotations: drawing tools, with the layer list and
  GPX/GeoJSON import from `layer-manager.ts` mounted inside), the weather picker, and Locate
  (`cursor-position.ts`: coordinates and elevation under the pointer).
- `popup.ts` renders info boxes; `route-highlight.ts` and `route-trace.ts` highlight a whole route or
  railway line picked from one.
- `layer-store.ts` keeps imported layers and annotations in browser memory; they are lost on reload
  unless exported.
- `scripts/styles/` generates the railway style, `scripts/tiles/` builds the tile archive.

Display settings (base map, railway filter and line colors, highlight) are applied by rewriting the style once at load
and then flipping MapLibre `global-state`, not by editing layers one by one.

### Map style

`public/orm/style/standard.json` and the `standard*` sprites are generated. Edit the fragments in
`scripts/styles/` and run `pnpm generate:style`, which writes the style and cuts the sprites down to the
icons it can draw (`scripts/styles/sprite-subset.mjs`). The full sprites stay as a fallback for icons
the subset misses. Commit the regenerated files; a unit test fails when they are out of date.

### Tiles

The tile export and the frontend share layer names and attributes: the style, the railway filter and
line colors, the info boxes and the highlight read what `scripts/tiles/export-tippecanoe.sh` writes, and its per-layer
zoom filters mirror the zooms the style draws each layer at. Change them together, test with a `bbox`
export (see above), and bump `TILE_VERSION` once the new archive is live.

Chinese stations are sized by China Railway's timetable rather than by mapped train routes, which OSM
rarely has for China. `data/cr-station-trains.csv` holds trains per day for each matched OSM station;
the export sizes those stations from it (large from 120 trains a day, normal from 24) and picks the
zoomed-out stations by it. To refresh it from a new timetable export (a lulutong CSV export, kept out
of git), run:

```bash
python3 scripts/tiles/cr-station-trains.py lulutong-timetable-csv-<date>
```

It matches the stations to OSM through Overpass and reports any it could not match.

Stations in Japan open a timetable from Yahoo! 乗換案内 through the
[norikae API](https://norikae.shz.al/v1/doc.md). `data/jp-station-codes.csv` maps OSM stations to
Yahoo's station codes, which the export writes to the station layers as `yahoo_codes`; stations
without codes are looked up by name when the timetable opens. To refresh it (it queries Overpass and
then the API's station search, caching searches under `output/`, so reruns only search new names):

```bash
python3 scripts/tiles/jp-station-codes.py
```

### Tests and checks

```bash
pnpm fmt:check && pnpm lint && pnpm typecheck   # oxfmt, oxlint, tsc over src/
pnpm test                                       # Vitest: src/**/*.test.ts, scripts/**/*.test.mjs
pnpm test:e2e                                   # Playwright, chromium and a Pixel 7 profile
pnpm vitest run --config vitest.config.js src/gpx.test.ts -t 'name substring'
pnpm exec playwright test e2e/annotations.spec.ts --project chromium
```

CI runs all of them in that order. Unit tests named `*.dom.test.ts` run in happy-dom; end-to-end specs
named `*.mobile.spec.ts` run only on the mobile profile. Playwright starts its own offline dev server
with screenshot fixtures; set `PLAYWRIGHT_BASE_URL` to test a server that is already running.

The fixtures are deterministic demo scenes at `?screenshot=overview|layers|annotations` (enabled by
`SCREENSHOT_FIXTURES=1`); `pnpm screenshots` renders `docs/screenshots/` from them.

## License

Code: [Apache License 2.0](LICENSE). Map data © OpenStreetMap contributors (ODbL), railway style
from OpenRailwayMap; base map by OpenFreeMap / OpenMapTiles, terrain by Mapterhorn.
