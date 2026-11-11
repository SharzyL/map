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

`src/worker.ts` only re-exports `src/worker/entry.ts`, which handles CORS preflight, serves `/tiles/*` from PMTiles archives in R2 (`src/worker/tiles.ts`, range reads plus a one-day edge cache), and falls back to static assets from `dist/` with SPA fallback. The only bindings are `ORM_BUCKET` (R2) and `ASSETS`.

### Tiles

The browser requests `/tiles/openrailwaymap/{z}/{x}/{y}.mvt?v=<TILE_VERSION>`, served from the R2 object `openrailwaymap.pmtiles`. `TILE_ARCHIVE` and `TILE_VERSION` are constants in `src/main.ts`, and `?tileset=` overrides the archive name. Bump `TILE_VERSION` after replacing the archive, because the version in the URL is what busts browser and edge caches. The worker serves tiles gzip-compressed as stored (`Content-Encoding: gzip`); the Cloudflare Vite plugin's dev proxy decompresses them, so `pnpm dev` transfers raw tiles. The archive is built by `scripts/tiles/export-tippecanoe.sh` from the OpenRailwayMap import database image (`ghcr.io/hiddewie/openrailwaymap-import-db`), normally through the manual "Export PMTiles" workflow (`.github/workflows/export-pmtiles.yml`), which uploads it to R2 with the `R2_*` repository secrets (`scripts/tiles/set-r2-secrets.sh` sets them from the environment). Railway line relations (`route=railway`), which that database lacks, come from the planet file: `scripts/tiles/fetch-line-relations.sh` streams it through `osmium tags-filter -R` and brings the result up to date with hourly diffs (`update-line-relations.sh`, so it matches the nightly database), and the export script loads it (`LINE_RELATIONS_OPL`, parsed by `scripts/tiles/line-relations.py`) to add `line_relations` to `railway_line_high`. Line segments without an `operator` tag take the operators of their line relations, or else of their subway/tram/light rail routes (`line_operators` in the export script), because China's railway bureaus and Shanghai Metro mostly tag the operator only on relations. The script only depends on that database's schema, not on OpenRailwayMap source files, but it is coupled to this repo: its layer names and attributes are what the style, the railway filter, the route highlight and the popups read, and its per-layer zoom filters mirror the zooms the style draws each layer at, so change them together. The archive is several GB, so upload it with an S3 client against the R2 endpoint, since `wrangler r2 object put` caps at 300 MiB.

### Browser app (`src/main.ts`)

`main.ts` merges the OpenFreeMap base style with the OpenRailwayMap style, adds hillshade, contours and satellite imagery, sets the globe projection with a sky/atmosphere (space backdrop is CSS on `#map`), and wires feature modules, each exposed as an `install*`/`create*` function: GPX/GeoJSON import (`gpx.ts`), popups (`popup.ts`, structured sections for lines and stations; lines drawn below z7 come from a layer without route or line lists, so a click there looks them up in the z7 tile with `route-trace.ts` `lineListsNear`), Photon search, weather picker, the Locate readout (`cursor-position.ts`: coordinates and DEM elevation under the pointer, sampled from the contour lines' terrain tiles), the railway filter, the Layers panel (`map-layers-panel.ts`), and the annotation renderer and tools. The Annotations panel (`annotation-tools.ts`) also holds the layer list with GPX/GeoJSON import: `layer-manager.ts` has no panel of its own and is mounted there, active only while that panel is open. Selecting an annotation layer in the list picks where new annotations go. The Route annotation tool calls OSRM through `osrm.ts`. `LayerStore` (`src/layer-store.ts`) is the in-browser state for layers and features. Use `src/style-ready.ts` helpers when touching the map style, because imports can arrive before the style has loaded.

Display settings are applied by rewriting the style once at load and then flipping MapLibre `global-state`, never by editing layers one by one:

- `railway-filter.ts` adds filter clauses to railway line/station layers, an overlay visibility switch and a switch for the style's tunnel covers and bridge railings (off by default, matched by layer id so OpenHistoricalMap lines follow it too); `railway-filter-panel.ts` is its panel.
- `railway-colors.ts` recolors railway line fills by route color, maximum speed, electrification or gauge instead of usage (the color mode and its legend live in the railway panel). The default mode reads a line's color from its first colored route in `line_routes` and keeps the usage color for lines without one. Station icons follow the lines too (`withRailwayStationColors`, read from `station_routes`): a dot in the line's color in that mode (dark gray otherwise, or without a colored route), or a ringed white dot where routes of different colors stop. It picks layers by the ids `railwayLine()` in `scripts/styles/shared.mjs` generates, and each mode's legend table drives both the map colors and the panel legend.
- `map-layers.ts` handles base map / satellite / hybrid visibility, hybrid road and label styling, gray roads (on by default, outside hybrid mode), base map saturation, label language and terrain layer switches; `map-layers-panel.ts` is its UI, the Layers panel.
- `map-panel.ts` holds the shared panel markup; `stored-settings.ts` persists settings in localStorage.

Zoom curves cannot be nested inside other expressions, so the rewrites map over a curve's stop outputs (`mapZoomOutputs`). Unit tests validate rewritten styles with `@maplibre/maplibre-gl-style-spec` and evaluate the expressions directly.

Leftovers from the collaboration era still shape some modules: `layer-sync.ts` and `file-layer-sync.ts` hold layer ordering and file-layer content helpers used by the layer store and manager, and `collaboration-permissions.ts` gates editing on a `data-collaboration-can-edit` attribute that nothing sets any more, so editing is always enabled.

`src/screenshot-fixture*.ts` is a deterministic demo scene (`?screenshot=overview|layers|annotations`) enabled by the `__SCREENSHOT_FIXTURES__` build flag. E2E tests and `pnpm screenshots` (images in `docs/screenshots/`) depend on it.

### Layer and annotation model

See `docs/layer-stack-design.md` (its storage and sync sections describe the removed room backend). Key rules that still hold in the browser:

- Ordering is only `sortKey` on layer rows (fractional keys from `src/layer-model.ts`).
- Each annotation feature is its own record with a `layerId`. Never store feature arrays on a layer or the whole drawing as one JSON blob.

### Map style

`public/orm/style/standard.json` is generated output. Edit the fragments under `scripts/styles/` and run `pnpm generate:style` instead of editing the JSON. `public/orm/**` is excluded from lint and format. `pnpm generate:style` also cuts the sprites down to the icons the style can draw (`scripts/styles/sprite-subset.mjs` writes `public/orm/{sprite,sdf_sprite}/standard*` and points the style at them); a unit test fails when the subset is out of date. The full `symbols*` sprites stay for the missing-icon fallback in `main.ts`.
