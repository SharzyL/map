# Sharzy's Map

An opinionated MapLibre-based online map, with vector tiles, railway data from OpenRailwayMap and many
else. Based on https://openrailwaymap.app and https://github.com/Enter-tainer/atlas-realm.

## Deployment Notes

The site is one Cloudflare Worker (`wrangler.toml`): it serves the built app as static assets, the
railway vector tiles from a PMTiles archive in R2, and the API the map reads (`/api/v1`: timetables,
trains, routes and lines) from a D1 database and a Durable Object. The tiles and the database are
filled by a data build that runs on GitHub Actions and also deploys the Worker.

### Prerequisites

- Node 22 and pnpm (`pnpm install`).
- A Cloudflare account with an R2 bucket for the tiles and a D1 database for the API's data.
- Wrangler logged in (`pnpm exec wrangler login`), or `CLOUDFLARE_API_TOKEN` set. An API token needs
  Workers Scripts edit, D1 edit, R2 edit, and for the custom domain Workers Routes and DNS edit on the
  zone. `pnpm dev` with remote bindings also needs Workers Scripts edit to open its remote preview
  session.
- The GitHub CLI (`gh`), logged in, to set repository secrets and run the build.

### 1. Configure `wrangler.toml`

Edit `wrangler.toml` for your account before building or deploying anything:

- `name`: the worker name.
- `routes`: replace `map.shz.al` with your own hostname. The zone must be on the same Cloudflare
  account; the custom domain and its DNS record are created on the first deploy. To serve from
  `<name>.<subdomain>.workers.dev` instead, remove `routes` and set `workers_dev = true`.
- `[[r2_buckets]]` `bucket_name`: your bucket. The build uploads the tiles to a bucket named `orm` and
  keeps its state under `build/` there (`s3://orm/` in `scripts/build/steps.toml`,
  `.github/workflows/build.yml` and `cleanup-r2-test-files.yml`), so name it `orm` or change those too.
- `[[d1_databases]]` `database_id`: create the database with `pnpm exec wrangler d1 create cr` and put
  the id it prints here. The build's imports and the Worker's binding `CR_DB` both read this entry.

### 2. Give the build its secrets

The Build workflow (`.github/workflows/build.yml`) makes everything the Worker serves besides the app
itself and deploys it. It needs five repository secrets:

- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`: an R2 API token with Object Read & Write
  on the bucket, for the tile archive and the build's state. Export its keys as `AWS_ACCESS_KEY_ID`
  and `AWS_SECRET_ACCESS_KEY` and the account ID as `R2_ACCOUNT_ID`, then run
  `./scripts/tiles/set-r2-secrets.sh <owner>/<repo>` to store them.
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`: an API token with Workers Scripts edit and D1 edit
  (and Workers Routes and DNS edit on the zone for the custom domain), for the D1 imports and the
  Worker's deploy: `gh secret set CLOUDFLARE_API_TOKEN -R <owner>/<repo>`.

### 3. Run the build

Push to `main`, or start the workflow by hand. The first run builds everything: the railway tile
archive (`openrailwaymap.pmtiles` in the bucket; until it exists, every tile request fails), the
timetables, relations and train routes for D1, and the Worker with the app. Pushes and scheduled runs
only deploy once the repository variable `BUILD_DEPLOY` is `true`
(`gh variable set BUILD_DEPLOY -b true -R <owner>/<repo>`); until then they build and list what they
would deploy, so a first run can be looked at before anything goes live. A run started by hand deploys
unless given `-f deploy=false`.

```bash
REPO=<owner>/<repo>
gh workflow run build.yml -R "$REPO"                          # whatever is not up to date
gh workflow run build.yml -R "$REPO" -f refresh=all           # probe every data source again
gh workflow run build.yml -R "$REPO" -f plan_only=true        # only print what would run, and why
gh run list -R "$REPO" -w build.yml -L 1                      # the new run's ID (may take a few seconds)
gh run watch <run-id> -R "$REPO" --interval 60 --exit-status
```

A first run takes about two hours, most of it a pass over OpenStreetMap's planet file (about 25
minutes; it comes back with every new weekly planet) and the tile export (about 40 minutes). After that the workflow runs by itself:

`/build-dashboard` on the deployed site shows the build as it stands: the graph of sources and steps,
when each data source last changed, how long each step took, and the recent runs. It reads the state
the build keeps in the bucket, so it follows a run while it is under way.

- on every push to `main`, with the data sources as they were last pinned, so only the steps the commit
  touched run again (a change to the app alone is its checks, a build and a deploy);
- every three days, probing the sources again: 路路通's timetable, OpenStreetMap's planet and hourly
  diffs, and the OpenRailwayMap database image.

Run by hand, it takes these inputs with `-f`: `refresh` (sources to probe again: `all`, or names such
as `lltskb`, `planet`, `osm-diffs`, `orm-db`, `yahoo-stations`), `force` (steps to run even if up to
date), `targets` (steps to bring up to date instead of all), `deploy` (`false` builds without
publishing) and `plan_only`. Yahoo's station codes have no version to watch, so
`-f refresh=yahoo-stations` is the only thing that searches every station name again; other runs only
search names they have not seen.

Each run's summary lists what every step did and why, and its `build-outputs` artifact holds the
station files and the review of Japan's official lines. See [The data build](#the-data-build) for the
steps.

### Deploying the site by hand

```bash
pnpm run deploy   # vite build, then wrangler deploy (`pnpm deploy` is a different, built-in command)
```

This still works, for instance before the first build has finished. The Worker bundles two station
files the build makes (Japanese stations' OSM features and positions, which the API adds to its
answers). `vite.config.js` takes them from `JP_STATION_CODES` and `STATION_COORDS` if set, else from a
build run in this checkout (`.build/out/`), else from the few stations in the test fixtures, so a
deploy by hand without either answers most Japanese stations without their OSM features. The next
Build run deploys the Worker with the full files again when they or the code changed since its last
deploy.

A new tile archive needs no deploy: the Worker tells the archive's version (`/tiles/<archive>/version`,
from its R2 ETag), and the map puts it in every tile URL, which is what makes browsers and the edge
cache stop serving tiles from the previous archive.

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

`?tileset=<archive name>` loads another archive from the bucket, e.g. a test export. Without a build
in this checkout the local Worker knows only the test fixtures' Japanese stations (see
[Deploying the site by hand](#deploying-the-site-by-hand)); download a Build run's station files to
get them all: `gh run download <run-id> -n build-outputs -D .build/out`.

### Project layout

- `src/main.ts` builds the map: it merges the OpenFreeMap base style with the OpenRailwayMap style,
  adds terrain, contours and satellite imagery, and installs the feature modules.
- `src/worker/` is the Cloudflare Worker: static assets, `/tiles/*` served from PMTiles in R2, and the
  API under `/api/v1` (`src/worker/api/`, documented in [`public/api/v1/doc.md`](public/api/v1/doc.md)).
- Panels: `map-layers-panel.ts` (Layers: base map, labels, terrain), `railway-filter-panel.ts`
  (Railways: filter, tunnel and bridge marks, and line colors by route, usage, speed, electrification or gauge from `railway-colors.ts`), `annotation-tools.ts` (Annotations: drawing tools, with the layer list and
  GPX/GeoJSON import from `layer-manager.ts` mounted inside), the weather picker, and Locate
  (`cursor-position.ts`: coordinates and elevation under the pointer).
- `popup.ts` renders info boxes; `route-highlight.ts` and `route-trace.ts` highlight a whole route or
  railway line picked from one, which a panel beside the map then describes.
- `layer-store.ts` keeps imported layers and annotations in browser memory; they are lost on reload
  unless exported.
- `scripts/styles/` generates the railway style, `scripts/tiles/` builds the tile archive, and the other
  `scripts/` directories build the data behind it and the API (the railway extract, 路路通 timetables,
  stations, Japan's official lines, relations, train routes); `scripts/build/` runs them all (see
  [The data build](#the-data-build)).

Display settings (base map, railway filter and line colors, highlight) are applied by rewriting the style once at load
and then flipping MapLibre `global-state`, not by editing layers one by one.

### Map style

`public/orm/style/standard.json` and the `standard*` sprites are generated. Edit the fragments in
`scripts/styles/` and run `pnpm generate:style`, which writes the style and cuts the sprites down to the
icons it can draw (`scripts/styles/sprite-subset.mjs`). The full sprites stay as a fallback for icons
the subset misses. Commit the regenerated files; a unit test fails when they are out of date.

### The data build

`scripts/build/build.py` runs the steps declared in `scripts/build/steps.toml`. A step is a command
with everything it reads named: files of this repository, data sources from outside, and other steps'
outputs. It runs again only when the content of one of those changed, and a step that writes the same
output as before leaves the steps reading it alone. A source's version is pinned (`--refresh` probes
it again), so a build after a commit rebuilds what the commit touched, and the scheduled build what
changed outside.

```bash
python3 scripts/build/build.py plan                    # what would run, and why
python3 scripts/build/build.py run relations           # bring a step and what it needs up to date
python3 scripts/build/build.py run --refresh lltskb    # probe a source again first
```

Outputs go to `.build/out/<step>/` (git-ignored). The steps need `osmium` and the Python packages in
`scripts/requirements.txt` (`nix-shell scripts/routing/shell.nix` has both); the tile export also
needs docker, GDAL, tippecanoe and pmtiles. Steps that publish (`deploy-*`) only run with `--deploy`,
which is the workflow's business: on CI the state of the build (what was built from what, when, and
how long it took) lives in the bucket under `build/`, and locally in `.build/state.json`, so a local
run never knows what is deployed.

| Step                                                    | Makes                                                                                                                    | From                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `lltskb`                                                | China Railway's timetable, unpacked and as CSV                                                                           | 路路通's `an.db` (`scripts/lltskb/`)                                                                      |
| `planet-extract`                                        | the railway objects of the weekly planet: worldwide without coordinates, and with them in the box around China and Japan | OpenStreetMap's planet, streamed once (`scripts/extract/`)                                                |
| `railway-extract`                                       | that brought up to date: line relations and way tags for the tiles                                                       | `planet-extract`, the hourly diffs                                                                        |
| `box-extract`                                           | the box brought up to date and cut to China, Japan and what lies between                                                 | `planet-extract`, the hourly diffs                                                                        |
| `n02`, `line-groups`                                    | Japan's railway ways grouped into their official lines                                                                   | MLIT's 国土数値情報 N02, `box-extract` (`scripts/lines/`)                                                 |
| `osm-stations`                                          | the extract's stations in China and in Japan                                                                             | `box-extract` (`scripts/stations/`)                                                                       |
| `cr-station-trains`                                     | China Railway's stations matched to OSM, with trains per day                                                             | `lltskb`, `osm-stations`                                                                                  |
| `jp-station-codes`                                      | Japan's OSM stations matched to Yahoo! 乗換案内 station codes                                                            | `osm-stations`, the API's station search                                                                  |
| `station-coords`                                        | the position of every matched station                                                                                    | the two station files, `osm-stations`                                                                     |
| `cr-timetable`                                          | station timetables and trains, as SQL for D1                                                                             | `lltskb`, `cr-station-trains`                                                                             |
| `relations`                                             | routes, lines and Japan's official lines, as SQL for D1                                                                  | `box-extract`, `line-groups`, `n02` (`scripts/relations/`)                                                |
| `routing-graph`, `cr-routes`, `jp-hops`                 | trains' routes on OSM track, as SQL for D1                                                                               | `box-extract`, `lltskb`, the station files (`scripts/routing/`)                                           |
| `tiles`                                                 | the railway tile archive                                                                                                 | the OpenRailwayMap database image, `railway-extract`, `line-groups`, the station files (`scripts/tiles/`) |
| `deploy-timetable`, `deploy-relations`, `deploy-routes` | the D1 database `cr`                                                                                                     | the SQL above                                                                                             |
| `deploy-tiles`                                          | `openrailwaymap.pmtiles` in the bucket                                                                                   | `tiles`                                                                                                   |
| `deploy-worker`                                         | the Worker and the app, last                                                                                             | `src/`, `public/`, the Japanese station files                                                             |

Things to know:

- 路路通's timetable is third-party data: it is never committed or published. The build keeps each
  version's `an.db` in its store in the bucket, and no output holding the timetable stays in the CI
  cache.
- All OpenStreetMap data, stations included, comes from the one railway extract. The hourly diffs do
  not remove what was deleted from OSM, so a deleted station can linger until the next weekly planet.
- The station files (`cr-station-trains.csv`, `jp-station-codes.csv`, `station-coords.csv`) are build
  outputs, not files in git. `scripts/stations/check-stations.py` stops the build when a match looks
  broken.
- `scripts/stations/jp-station-exceptions.csv` settles the Japanese stations the name and position
  rules get wrong, and `scripts/routing/jp-rules.csv` the trains whose route OSM's service routes do
  not give.

#### The tile export

`scripts/tiles/export-from-image.sh` starts the OpenRailwayMap import database from its image
(`ghcr.io/hiddewie/openrailwaymap-import-db`) and runs `scripts/tiles/export-tippecanoe.sh` against it,
which writes the archive (several GB, worldwide, zoom 0-15). Railway line relations (`route=railway`)
and the track counts and opening dates of railway ways are not in that database, so they come from
the railway extract (`LINE_RELATIONS_OPL`); in Japan, where OSM lacks line relations for much of the
track, the ways' lines are the official lines of `line-groups` (`LINE_GROUPS_DIR`).

To run it by hand, for instance on a small area, start the database yourself (`docker run -p 5432:5432
-e POSTGRES_HOST_AUTH_METHOD=trust -e PGDATA=/data/postgresql --shm-size=2g
ghcr.io/hiddewie/openrailwaymap-import-db:latest`; podman rejects the image's empty `ENV` entries) and
run `export-tippecanoe.sh` with `DATABASE_URL`, `MAX_ZOOM` and optionally `BBOX`
(`minlon,minlat,maxlon,maxlat`) set; it needs GDAL (`ogr2ogr`) and tippecanoe and writes to `output/`.
Upload the result under another name with an S3 client against
`https://<account-id>.r2.cloudflarestorage.com` (`wrangler r2 object put` stops at 300 MiB), open it
with `?tileset=<archive name>`, and remove archives named `openrailwaymap-test-*` with
`gh workflow run cleanup-r2-test-files.yml`.

The tile export and the frontend share layer names and attributes: the style, the railway filter and
line colors, the info boxes and the highlight read what `export-tippecanoe.sh` writes, and its
per-layer zoom filters mirror the zooms the style draws each layer at. Change them together and test
with a `BBOX` export. A commit that changes both reaches the map in order: the build uploads the new
archive before it deploys the Worker.

Chinese stations are sized by China Railway's timetable rather than by mapped train routes, which OSM
rarely has for China: the export sizes the stations in `cr-station-trains.csv` by their trains per day
(large from 120, normal from 24) and picks the zoomed-out stations by it. Stations in Japan open a
timetable from Yahoo! 乗換案内 through the map's own API ([`/api/v1/doc.md`](public/api/v1/doc.md)):
the export writes the codes in `jp-station-codes.csv` to the station layers as `yahoo_codes`, and a
Japanese station without codes gets no Timetable button. China Railway stations open one from China
Railway's timetable through the same API, which finds them by their OSM elements.

### Tests and checks

```bash
pnpm fmt:check && pnpm lint && pnpm typecheck   # oxfmt, oxlint, tsc over src/
pnpm test                                       # Vitest: src/**/*.test.ts, scripts/**/*.test.mjs
./scripts/test-python.sh                        # the data scripts and the build runner (scripts/*/test_*.py)
pnpm test:e2e                                   # Playwright, chromium and a Pixel 7 profile
pnpm vitest run --config vitest.config.js src/gpx.test.ts -t 'name substring'
pnpm exec playwright test e2e/annotations.spec.ts --project chromium
```

They are also steps of the data build (`check-*` in `scripts/build/steps.toml`), so
`python3 scripts/build/build.py run --checks` runs the ones whose files changed since they last
passed, several at a time. CI runs all of them on pull requests, and on pushes to `main` the changed
ones inside the build, where a failing check holds back the deploys of what it tests. The Python tests of the
relations and routing scripts need the packages in `scripts/requirements.txt`
(`nix-shell scripts/routing/shell.nix --run ./scripts/test-python.sh`). Unit tests named `*.dom.test.ts` run in happy-dom; end-to-end specs
named `*.mobile.spec.ts` run only on the mobile profile. Playwright starts its own offline dev server
with screenshot fixtures; set `PLAYWRIGHT_BASE_URL` to test a server that is already running.

The fixtures are deterministic demo scenes at `?screenshot=overview|layers|annotations` (enabled by
`SCREENSHOT_FIXTURES=1`); `pnpm screenshots` renders `docs/screenshots/` from them.

## License

Code: [Apache License 2.0](LICENSE). Map data © OpenStreetMap contributors (ODbL), railway style
from OpenRailwayMap; base map by OpenFreeMap / OpenMapTiles, terrain by Mapterhorn.
