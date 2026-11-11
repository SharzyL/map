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
   the archive (about 40 minutes) and uploads it to `orm/openrailwaymap.pmtiles`:

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

### Local development

```bash
pnpm dev   # Vite + the worker; tiles come from the real R2 bucket
CLOUDFLARE_VITE_REMOTE_BINDINGS=0 pnpm dev   # fully local; tiles come from a local R2 bucket
pnpm exec wrangler r2 object put orm/openrailwaymap.pmtiles --file <small.pmtiles> --local
```

A small regional archive for local work can be cut from a full one with
`pmtiles extract <in.pmtiles> <out.pmtiles> --bbox=<west>,<south>,<east>,<north>`.

Checks (also run by CI): `pnpm fmt:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`.

## License

Code: [Apache License 2.0](LICENSE). Map data © OpenStreetMap contributors (ODbL), railway style
from OpenRailwayMap; base map by OpenFreeMap / OpenMapTiles, terrain by Mapterhorn.
