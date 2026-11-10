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
pnpm test                # unit tests: src/**/*.test.ts
pnpm test:e2e            # Playwright (starts its own server, see below)
pnpm generate:style      # regenerate public/orm/style/standard.json from scripts/styles/
```

CI (`.github/workflows/test.yml`) runs, in order: `fmt:check`, `lint`, `typecheck`, `test`, `test:e2e`.

Running a single test:

```bash
pnpm vitest run --config vitest.config.js src/gpx.test.ts -t 'name substring'
pnpm exec playwright test e2e/routing.spec.ts --project chromium
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

The browser requests `/tiles/openrailwaymap/{z}/{x}/{y}.mvt?v=<TILE_VERSION>`, served from the R2 object `openrailwaymap.pmtiles`. `TILE_ARCHIVE` and `TILE_VERSION` are constants in `src/main.ts`, and `?tileset=` overrides the archive name. Bump `TILE_VERSION` after replacing the archive, because the version in the URL is what busts browser and edge caches. The archive is built by the export pipeline in the OpenRailwayMap-vector fork (`scripts/export-tippecanoe.sh`). It is several GB, so upload it with an S3 client against the R2 endpoint, since `wrangler r2 object put` caps at 300 MiB.

### Browser app (`src/main.ts`)

`main.ts` creates the MapLibre map (OpenRailwayMap style, PMTiles, contours, terrain and satellite toggles) and wires feature modules, each exposed as an `install*` function: GPX/GeoJSON import (`gpx.ts`), popups, Photon search, OSRM routing, weather picker, layer manager UI, and annotation renderer and tools. `LayerStore` (`src/layer-store.ts`) is the in-browser state for layers and features. Use `src/style-ready.ts` helpers when touching the map style, because imports can arrive before the style has loaded.

Leftovers from the collaboration era still shape some modules: `layer-sync.ts` and `file-layer-sync.ts` hold layer ordering and file-layer content helpers used by the layer store and manager, and `collaboration-permissions.ts` gates editing on a `data-collaboration-can-edit` attribute that nothing sets any more, so editing is always enabled.

`src/screenshot-fixture*.ts` is a deterministic demo scene (`?screenshot=overview|layers|annotations`) enabled by the `__SCREENSHOT_FIXTURES__` build flag. E2E tests and `pnpm screenshots` (README images in `docs/screenshots/`) depend on it.

### Layer and annotation model

See `docs/layer-stack-design.md` (its storage and sync sections describe the removed room backend). Key rules that still hold in the browser:

- Ordering is only `sortKey` on layer rows (fractional keys from `src/layer-model.ts`).
- Each annotation feature is its own record with a `layerId`. Never store feature arrays on a layer or the whole drawing as one JSON blob.

### Map style

`public/orm/style/standard.json` is generated output. Edit the fragments under `scripts/styles/` and run `pnpm generate:style` instead of editing the JSON. `public/orm/**` is excluded from lint and format.
