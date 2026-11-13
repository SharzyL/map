# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-user fork of Atlas Realm: a MapLibre map with an OpenRailwayMap overlay, built with Vite and served by one Cloudflare Worker. Upstream's collaboration stack (Durable Object rooms, D1 accounts, GitHub OAuth, the agent CLI and its skills) has been removed. The worker only serves static assets and vector tiles. Layers (imported GPX/GeoJSON) and annotations (markers, text, lines, areas, routes, weather cards) live in browser memory only and are lost on reload unless exported.

Node 22, pnpm, TypeScript (`strict: false` but `noImplicitAny: true`). Formatting is oxfmt (single quotes, semicolons, 120 cols; `scripts/styles/**` uses no semicolons). Linting is oxlint.

## Commands

```bash
pnpm dev                 # Vite dev server with the Cloudflare plugin (worker runs locally)
pnpm build               # vite build -> dist/
pnpm preview             # build + wrangler dev
pnpm run deploy          # build + wrangler deploy (`pnpm deploy` is a different, built-in pnpm command)
pnpm typecheck           # tsc --noEmit (covers src/ only)
pnpm lint / lint:fix     # oxlint
pnpm fmt / fmt:check     # oxfmt
pnpm test                # unit tests: src/**/*.test.ts and scripts/**/*.test.mjs
pnpm test:e2e            # Playwright (starts its own server, see below)
pnpm generate:style      # regenerate public/orm/style/standard.json from scripts/styles/
```

CI (`.github/workflows/test.yml`) runs, in order: `fmt:check`, `lint`, `typecheck`, `test`, `test:e2e`.

Running a single test:

```bash
pnpm vitest run --config vitest.config.js src/gpx.test.ts -t 'name substring'
pnpm exec playwright test e2e/annotations.spec.ts --project chromium
```

Test conventions:

- `*.dom.test.ts` files opt into happy-dom with a `// @vitest-environment happy-dom` header; other unit tests run in Node.
- `*.mobile.spec.ts` only run in the `mobile-chromium` Playwright project (Pixel 7); other specs run in `chromium`.
- Playwright's web server starts Vite with `SCREENSHOT_FIXTURES=1` and `CLOUDFLARE_VITE_REMOTE_BINDINGS=0`. Set `PLAYWRIGHT_BASE_URL` to test an already running server instead. `e2e/support/` holds the shared fixtures (map fixture with mocked external services, map interaction helpers, UI invariant audit).

Local dev environment notes:

- The R2 bucket binding is `remote: true`, so `pnpm dev` uses remote Cloudflare bindings by default (needs wrangler auth). Set `CLOUDFLARE_VITE_REMOTE_BINDINGS=0` to run fully offline (tiles will not load).

## Architecture

### Worker (`src/worker.ts` -> `src/worker/`)

`src/worker.ts` only re-exports `src/worker/entry.ts`, which handles CORS preflight, serves `/tiles/*` from PMTiles archives in R2 (`src/worker/tiles.ts`, range reads plus the Workers cache; versioned tile URLs, empty ones included, are `immutable` for a year so browsers reuse them without invoking the Worker, which is why `TILE_VERSION` must change with every archive), and falls back to static assets from `dist/` with SPA fallback. The only bindings are `ORM_BUCKET` (R2) and `ASSETS`.

### Tiles

The browser requests `/tiles/openrailwaymap/{z}/{x}/{y}.mvt?v=<TILE_VERSION>`, served from the R2 object `openrailwaymap.pmtiles`. `TILE_ARCHIVE` and `TILE_VERSION` are constants in `src/main.ts`, and `?tileset=` overrides the archive name. Bump `TILE_VERSION` after replacing the archive, because the version in the URL is what busts browser and edge caches. The worker serves tiles gzip-compressed as stored (`Content-Encoding: gzip`); the Cloudflare Vite plugin's dev proxy decompresses them, so `pnpm dev` transfers raw tiles. The archive is built by `scripts/tiles/export-tippecanoe.sh` from the OpenRailwayMap import database image (`ghcr.io/hiddewie/openrailwaymap-import-db`), normally through the manual "Export PMTiles" workflow (`.github/workflows/export-pmtiles.yml`), which uploads it to R2 with the `R2_*` repository secrets (`scripts/tiles/set-r2-secrets.sh` sets them from the environment). Railway line relations (`route=railway`), which that database lacks, come from the planet file: `scripts/tiles/fetch-line-relations.sh` streams it twice (the objects `scripts/tiles/railway-extract.filter` selects, then the nodes they use, so the result is a self-contained railway extract with coordinates) and brings the result up to date with hourly diffs (`update-line-relations.sh`, so it matches the nightly database; the composite action `.github/actions/line-relations` caches the filtered planet extract by the planet's md5 and the fetch script's hash, so only the diffs rerun until a new weekly planet is out, and the manual "Fetch line relations" workflow runs that pass alone and uploads `lines.osm.pbf` as an artifact for local work), and the export script loads it (`LINE_RELATIONS_OPL`, parsed by `scripts/tiles/line-relations.py`) to add `line_relations` to `railway_line_high`. The same pass keeps railway ways, so railway ways' `tracks`, `start_date` and `opening_date` (also missing from the database) reach `railway_line_high` through the `line_way_tags` table. Both line layers also carry `operator_color` (the view's brand color or hashed hue, computed the same way for filled-in operators), and the zoomed-out layer carries `voltage` and `frequency` for the electrification color mode. Station sizes in China come from China Railway's timetable: `data/cr-station-trains.csv` (built by `scripts/tiles/cr-station-trains.py` from a lulutong timetable export, which is never committed) gives trains per day per matched OSM station, and the export's `station_overrides` table turns that into size, importance and the zoomed-out isolation (`discr_iso`) for those stations. Stations in Japan carry `yahoo_codes`, their Yahoo! 乗換案内 station codes from `data/jp-station-codes.csv` (built by `scripts/tiles/jp-station-codes.py` through the norikae API's station search), which the Timetable button in their info box (`src/timetable.ts`, client in `src/norikae.ts`) opens; a Japanese station without codes gets no button. Mainline stations with a Chinese name inside China get the same button for China Railway's timetable from the same API (`/v1/cr-*`), which finds the station by the OSM elements in the feature's `osm_id`/`osm_type`, else by its name without 站. In Japan, where OSM has no line relation for about a quarter of the mainline track and names ways inconsistently (`JR外房線` and `外房線`), a way's lines are instead the official lines of MLIT's railway data (国土数値情報 N02, CC BY 4.0, credited in the Credits panel, `credits.ts`) it follows: `scripts/tiles/line-groups.sh` downloads N02 and runs `line-groups.py`, which matches ways to N02 lines by geometry with names breaking ties, adds lines drawn on shared track, extends lines along connected track of the same name, and names them from OSM (`山陰本線`, `京成本線`, `つくばエクスプレス`); the export (`LINE_GROUPS_DIR`) lists them in those ways' `line_relations` (ids `jp-…`, replacing their relations) and names the zoomed-out layer's sections after them, while `line_color` stays voted by way name, since an official line holds services of different colors (東海道本線 holds 京浜東北線 track). Line segments without an `operator` tag take the operators of their line relations, or else of their subway/tram/light rail routes (`line_operators` in the export script), because China's railway bureaus and Shanghai Metro mostly tag the operator only on relations. The script only depends on that database's schema, not on OpenRailwayMap source files, but it is coupled to this repo: its layer names and attributes are what the style, the railway filter, the route highlight and the popups read, and its per-layer zoom filters mirror the zooms the style draws each layer at, so change them together. The archive is several GB, so upload it with an S3 client against the R2 endpoint, since `wrangler r2 object put` caps at 300 MiB.

### Browser app (`src/main.ts`)

`main.ts` merges the OpenFreeMap base style with the OpenRailwayMap style, adds hillshade, contours and satellite imagery, sets the globe projection with a sky/atmosphere (space backdrop is CSS on `#map`), and wires feature modules, each exposed as an `install*`/`create*` function: GPX/GeoJSON import (`gpx.ts`), popups (`popup.ts`, structured sections for lines and stations; lines drawn below z7 come from a layer without route or line lists, so a click there looks them up in the z7 tile with `route-trace.ts` `lineListsNear`), Photon search, weather picker, the Locate readout (`cursor-position.ts`: coordinates and DEM elevation under the pointer, sampled from the contour lines' terrain tiles), the railway filter, the Layers panel (`map-layers-panel.ts`), and the annotation renderer and tools. The Annotations panel (`annotation-tools.ts`) also holds the layer list with GPX/GeoJSON import: `layer-manager.ts` has no panel of its own and is mounted there, active only while that panel is open. Selecting an annotation layer in the list picks where new annotations go. The Route annotation tool calls OSRM through `osrm.ts`. `LayerStore` (`src/layer-store.ts`) is the in-browser state for layers and features. Use `src/style-ready.ts` helpers when touching the map style, because imports can arrive before the style has loaded.

Display settings are applied by rewriting the style once at load and then flipping MapLibre `global-state`, never by editing layers one by one:

- `railway-filter.ts` adds filter clauses to railway line/station layers (heritage lines, `preserved`, count as tourism whatever their usage), an overlay visibility switch and a switch for the style's tunnel covers and bridge railings (off by default, matched by layer id so OpenHistoricalMap lines follow it too); `railway-filter-panel.ts` is its panel. The panel's year slider sets the style's `date` global state: the generated style hides today's railway layers whenever `date` is below its default (the year `pnpm generate:style` ran) and draws the OpenHistoricalMap layers (source `openhistoricalmap`) open in that year instead, so `main.ts` must not override the `date` default. The year is not stored, and the OpenHistoricalMap layers follow the overlay switch but not the filters or colors.
- `railway-colors.ts` recolors railway line fills by route color, operator, maximum speed, electrification, gauge or number of tracks instead of usage (the color mode and its legend live in the railway panel). The default mode reads a line's color from `line_color`, which the export sets on both line layers to the length-weighted majority color of the routes of every segment with the same name and operator (`line_colors` in the export script), so parallel tracks of one line look alike; tiles without it fall back to the first colored route in `line_routes`, and lines without either keep the usage color. Station icons follow the lines too (`withRailwayStationColors`, read from `station_routes`): a dot in the line's color in that mode (dark gray otherwise, or without a colored route), or a ringed white dot where routes of different colors stop. It picks layers by the ids `railwayLine()` in `scripts/styles/shared.mjs` generates, and each mode's legend table drives both the map colors and the panel legend.
- `map-layers.ts` handles base map / satellite / hybrid visibility, hybrid road and label styling, gray roads unless "Highlight roads" is on (outside hybrid mode), darker, slightly wider base map borders by admin level when "Highlight administrative divisions" is on, plus level 7 (municipalities) that the base style leaves out (OpenRailwayMap has no borders; they are the base map's `boundary_*` layers), base map saturation, label language and terrain layer switches; `map-layers-panel.ts` is its UI, the Layers panel.
- `map-panel.ts` holds the shared panel markup; `stored-settings.ts` persists settings in localStorage.

The attribution line (bottom right) only credits OpenStreetMap and, while imagery shows, Google (`withShortAttributions` in `main.ts` blanks every other source's attribution); its Credits button opens `credits.ts`, which lists every data source and service. Add new sources there. A chip at the top centre (`load-status.ts`) says while railway or base map tiles in view are still loading, with the number left (elevation is left out), and how many tiles in view failed, with a Retry that resets the failed sources' tile URLs, since MapLibre never refetches a failed tile; so an empty area only means no railway once the chip is gone. The counts read each source's tile manager (`map.style.tileManagers`), which MapLibre types but does not document; if that breaks in an upgrade, the chip logs a console error and falls back to `isSourceLoaded` and tile error events.

Zoom curves cannot be nested inside other expressions, so the rewrites map over a curve's stop outputs (`mapZoomOutputs`). Unit tests validate rewritten styles with `@maplibre/maplibre-gl-style-spec` and evaluate the expressions directly.

Leftovers from the collaboration era still shape some modules: `layer-sync.ts` and `file-layer-sync.ts` hold layer ordering and file-layer content helpers used by the layer store and manager, and `collaboration-permissions.ts` gates editing on a `data-collaboration-can-edit` attribute that nothing sets any more, so editing is always enabled.

`src/screenshot-fixture*.ts` is a deterministic demo scene (`?screenshot=overview|layers|annotations`) enabled by the `__SCREENSHOT_FIXTURES__` build flag. E2E tests and `pnpm screenshots` (images in `docs/screenshots/`) depend on it.

### Layer and annotation model

See `docs/layer-stack-design.md` (its storage and sync sections describe the removed room backend). Key rules that still hold in the browser:

- Ordering is only `sortKey` on layer rows (fractional keys from `src/layer-model.ts`).
- Each annotation feature is its own record with a `layerId`. Never store feature arrays on a layer or the whole drawing as one JSON blob.

### Map style

`public/orm/style/standard.json` is generated output. Edit the fragments under `scripts/styles/` and run `pnpm generate:style` instead of editing the JSON. `public/orm/**` is excluded from lint and format. `pnpm generate:style` also cuts the sprites down to the icons the style can draw (`scripts/styles/sprite-subset.mjs` writes `public/orm/{sprite,sdf_sprite}/standard*` and points the style at them); a unit test fails when the subset is out of date. The full `symbols*` sprites stay for the missing-icon fallback in `main.ts`.
