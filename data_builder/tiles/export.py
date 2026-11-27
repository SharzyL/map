#!/usr/bin/env python3
"""Exports the railway vector tiles from an OpenRailwayMap import database: adds the tables
the tiles read from the build's other outputs (tables.py), writes each layer's query to
FlatGeobuf with ogr2ogr (layers.py), then makes one PMTiles archive of them with tippecanoe.

Usage: data_builder/tiles/export.py

Environment variables:
  DATABASE_URL       PostgreSQL connection string (default: postgresql://osm:osm@localhost:5432/osm)
  OUTPUT_DIR         output directory (default: ./output); the archive is openrailwaymap.pmtiles there
  MAX_ZOOM           the archive's last zoom (default: 15)
  LAYERS             the style layers to export: "standard" (default) or "all"
  BBOX               only what lies in minlon,minlat,maxlon,maxlat
  CONCURRENCY        layer queries run at a time (default: the number of CPUs)
  PROGRESS_INTERVAL  seconds between tippecanoe's progress lines (default: 60; each update is a log line in CI)
  LINE_RELATIONS_OPL optional OPL file of route=railway relations and railway ways (see line-relations.py);
                     adds line_relations to railway_line_high and the ways' tracks and dates
  LINE_GROUPS_DIR    optional output of data_builder/official-lines/line-groups.sh: Japan's official lines, which replace
                     the line relations of the ways on them
  CR_STATION_TRAINS  optional China Railway trains per day by OSM station (data_builder/stations/cr-station-trains.py);
                     sizes those stations by timetable instead of mapped routes
  JP_STATION_CODES   optional Yahoo! 乗換案内 station codes by OSM station in Japan
                     (data_builder/stations/jp-station-codes.py); the stations' yahoo_codes, which open their timetable
  JP_READINGS        optional readings in katakana by OSM station in Japan (data_builder/stations/station-index.py
                     --readings); the stations' yomi, shown after their name in their info box

Needs psql, ogr2ogr and tippecanoe.
"""

import json
import math
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import tables
from layers import layers


@dataclass
class Config:
    database_url: str
    output_dir: Path
    max_zoom: int
    all_styles: bool
    bbox: str
    concurrency: int
    progress_interval: int
    line_relations_opl: str
    line_groups_dir: str
    cr_station_trains: str
    jp_station_codes: str
    jp_readings: str

    @classmethod
    def from_env(cls):
        env = os.environ.get
        return cls(
            database_url=env('DATABASE_URL', 'postgresql://osm:osm@localhost:5432/osm'),
            output_dir=Path(env('OUTPUT_DIR', './output')),
            max_zoom=int(env('MAX_ZOOM', '15')),
            all_styles=env('LAYERS', 'standard') == 'all',
            bbox=env('BBOX', ''),
            concurrency=int(env('CONCURRENCY') or len(os.sched_getaffinity(0))),
            progress_interval=int(env('PROGRESS_INTERVAL', '60')),
            line_relations_opl=env('LINE_RELATIONS_OPL', ''),
            line_groups_dir=env('LINE_GROUPS_DIR', ''),
            cr_station_trains=env('CR_STATION_TRAINS', ''),
            jp_station_codes=env('JP_STATION_CODES', ''),
            jp_readings=env('JP_READINGS', ''),
        )


class Database:
    """The import database, through psql."""

    def __init__(self, url):
        self.psql = ['psql', url, '-v', 'ON_ERROR_STOP=1', '-q']

    def run(self, sql):
        subprocess.run(self.psql, input='SET client_min_messages = warning;\n' + sql, text=True, check=True)

    def copy(self, table, path, header=False):
        """Loads a CSV file into a table."""
        options = 'FORMAT csv, HEADER true' if header else 'FORMAT csv'
        with open(path, 'rb') as rows:
            subprocess.run([*self.psql, '-c', f'COPY {table} FROM STDIN WITH ({options})'], stdin=rows, check=True)

    def report(self, sql):
        """Prints what a query answers."""
        subprocess.run([*self.psql, '-At', '-c', sql], check=True)


def web_mercator(lon, lat):
    x = lon * 20037508.342789244 / 180.0
    y = math.log(math.tan((90 + lat) * math.pi / 360.0)) / (math.pi / 180.0)
    return x, y * 20037508.342789244 / 180.0


def size(path):
    total = sum(p.stat().st_size for p in path.rglob('*')) if path.is_dir() else path.stat().st_size
    return f'{total / 1e6:.1f} MB'


# ── Phase 1: each layer's query to FlatGeobuf ───────────


def log(text):
    """Prints a line in one write, so lines of exports running side by side do not mix."""
    sys.stdout.write(text + '\n')


def export_layer(config, layer, fgb_dir, spatial_filter):
    """Writes one layer's query to its file, unless an earlier run did. True when it succeeded."""
    out = fgb_dir / f'{layer.name}.fgb'
    if out.exists():
        log(f'  [skip] {layer.name} (already exists)')
        return True
    log(f'  [export] {layer.name}...')
    start = time.monotonic()
    partial = fgb_dir / f'{layer.name}.partial.fgb'  # left by an interrupted run
    partial.unlink(missing_ok=True)
    command = [
        'ogr2ogr',
        '-f', 'FlatGeobuf',
        partial,
        f'PG:{config.database_url}',
        '-sql', layer.sql,
        '-nln', layer.name,
        '-lco', 'SPATIAL_INDEX=NO',
        '-t_srs', 'EPSG:4326',
        '--config', 'PG_USE_COPY', 'YES',
        *spatial_filter,
    ]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in result.stdout.splitlines()[-5:]:
        log(f'    {layer.name}: {line}')
    if result.returncode != 0:
        log(f'  [ERROR] {layer.name} export failed')
        partial.unlink(missing_ok=True)
        return False
    partial.rename(out)
    log(f'  [done] {layer.name}: {size(out)} in {time.monotonic() - start:.0f}s')
    return True


def export_layers(config, archive_layers, fgb_dir):
    """Runs the queries several at a time: they are independent, and the slow ones are
    database-bound, so overlapping them shortens this phase considerably."""
    # -spat_srs does not work with -sql, so the box goes in the database's projection.
    spatial_filter = []
    if config.bbox:
        minlon, minlat, maxlon, maxlat = (float(v) for v in config.bbox.split(','))
        spatial_filter = ['-spat', *(str(v) for v in (*web_mercator(minlon, minlat), *web_mercator(maxlon, maxlat)))]
        print(f'BBOX (EPSG:3857): {" ".join(spatial_filter[1:])}')
    with ThreadPoolExecutor(config.concurrency) as pool:
        done = list(pool.map(lambda layer: export_layer(config, layer, fgb_dir, spatial_filter), archive_layers))
    failed = [layer.name for layer, ok in zip(archive_layers, done) if not ok]
    if failed:
        sys.exit(f'Phase 1 failed for: {" ".join(failed)}')


# ── Phase 2: the archive ────────────────────────────────

# tippecanoe's FlatGeobuf reader turns every numeric column into a string;
# these types turn them back.
ATTRIBUTE_TYPES = {
    'float': [
        'way_length', 'maxspeed', 'frequency', 'future_frequency', 'height', 'position_numeric', 'discr_iso',
        'way_area', 'azimuth', *(f'offset{i}' for i in range(6)),
    ],
    'int': [
        'tracks', 'rank', 'voltage', 'maximum_current', 'future_voltage', 'future_maximum_current',
        'train_protection_rank', 'train_protection_construction_rank', 'gaugeint0', 'gaugeint1', 'gaugeint2',
        'route_count', 'count', 'importance', 'pos_int', 'minzoom', 'zoom_part',
    ],
    'bool': ['direction_both', *(f'deactivated{i}' for i in range(6))],
}


def make_archive(config, archive_layers, fgb_dir, archive):
    command = [
        'tippecanoe',
        f'--output={archive}',
        '--force',
        f'--maximum-zoom={config.max_zoom}',
        '--minimum-zoom=0',
        '--no-tile-size-limit',
        '--no-feature-limit',
        '--generate-ids',
        f'--progress-interval={config.progress_interval}',
        '-r1',  # every feature at every zoom, no dropping by density
        '--name=OpenRailwayMap',
        '--description=OpenRailwayMap vector tiles',
        '--attribution=© OpenStreetMap contributors | Style: OpenRailwayMap',
    ]
    for kind, attributes in ATTRIBUTE_TYPES.items():
        for attribute in attributes:
            command += ['-T', f'{attribute}:{kind}']
    filters = {}
    for layer in archive_layers:
        file = fgb_dir / f'{layer.name}.fgb'
        tile_layer = layer.tile_layer or layer.name
        if file.stat().st_size == 0:
            print(f'  [skip] {layer.name} -> {tile_layer} (no data)')
            continue
        command += ['-L', json.dumps({'file': str(file), 'layer': tile_layer})]
        filters[tile_layer] = layer.filter
    command += ['-j', json.dumps(filters, separators=(',', ':'))]
    print(f'Running tippecanoe with {len(command) - 1} arguments...\n')
    subprocess.run(command, stderr=subprocess.STDOUT, check=True)


def main():
    sys.stdout.reconfigure(line_buffering=True)
    config = Config.from_env()
    fgb_dir = config.output_dir / 'fgb'
    fgb_dir.mkdir(parents=True, exist_ok=True)
    print('=== ORM PMTiles Export (tippecanoe) ===')
    print(f'Database: {config.database_url}')
    print(f'Output: {config.output_dir}')
    print(f'Max zoom: {config.max_zoom}')
    print(f'Layers: {"all" if config.all_styles else "standard"}')
    print(f'Concurrency: {config.concurrency}')
    if config.bbox:
        print(f'BBOX filter: {config.bbox}')
    print()

    tables.build(Database(config.database_url), config)

    archive_layers = []
    for layer in layers(config.max_zoom, config.all_styles):
        if layer.filter is None:
            print(f'  [skip] {layer.name} (no zoom up to {config.max_zoom})')
        else:
            archive_layers.append(layer)

    print('--- Phase 1: Export layers from PostGIS to FlatGeobuf ---\n')
    export_layers(config, archive_layers, fgb_dir)
    print(f'--- Phase 1 complete ---\n\nExported {len(archive_layers)} layers, total size: {size(fgb_dir)}\n')

    print('--- Phase 2: Generate PMTiles with tippecanoe ---\n')
    archive = config.output_dir / 'openrailwaymap.pmtiles'
    make_archive(config, archive_layers, fgb_dir, archive)
    print(f'\n--- Phase 2 complete ---\n\nOutput: {archive} ({size(archive)})\n\n=== Export complete ===')


if __name__ == '__main__':
    main()
