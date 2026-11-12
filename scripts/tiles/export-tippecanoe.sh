#!/usr/bin/env bash
# Export ORM vector tiles using ogr2ogr (FlatGeobuf) + tippecanoe → PMTiles
# This replaces the slow martin-cp approach with a much faster pipeline.
#
# Usage: ./scripts/tiles/export-tippecanoe.sh
#
# Environment variables:
#   DATABASE_URL  - PostgreSQL connection string (default: postgresql://osm:osm@localhost:5432/osm)
#   OUTPUT_DIR    - Output directory (default: ./output)
#   MAX_ZOOM      - Maximum zoom level (default: 15)
#   LAYERS        - Which style layers to export: "standard" (default) or "all"
#   CONCURRENCY   - parallel PostGIS exports in Phase 1 (default: nproc)
#   PROGRESS_INTERVAL - seconds between tippecanoe progress updates (default: 60;
#                   each update becomes a log line in CI)
#   LINE_RELATIONS_OPL - optional OPL file of route=railway relations (see
#                   line-relations.py); adds line_relations to railway_line_high
#   CR_STATION_TRAINS - China Railway trains per day by OSM station (default:
#                   data/cr-station-trains.csv, see cr-station-trains.py); sizes
#                   those stations by timetable instead of mapped routes
#   JP_STATION_CODES - Yahoo! 乗換案内 station codes by OSM station in Japan
#                   (default: data/jp-station-codes.csv, see jp-station-codes.py);
#                   become the stations' yahoo_codes, which open their timetable

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgresql://osm:osm@localhost:5432/osm}"
OUTPUT_DIR="${OUTPUT_DIR:-./output}"
MAX_ZOOM="${MAX_ZOOM:-15}"
CONCURRENCY="${CONCURRENCY:-$(nproc)}"
BBOX="${BBOX:-}"
LAYERS="${LAYERS:-standard}"
PROGRESS_INTERVAL="${PROGRESS_INTERVAL:-60}"
LINE_RELATIONS_OPL="${LINE_RELATIONS_OPL:-}"
CR_STATION_TRAINS="${CR_STATION_TRAINS:-$(dirname "$0")/../../data/cr-station-trains.csv}"
JP_STATION_CODES="${JP_STATION_CODES:-$(dirname "$0")/../../data/jp-station-codes.csv}"
FGB_DIR="${OUTPUT_DIR}/fgb"

mkdir -p "${FGB_DIR}"

echo "=== ORM PMTiles Export (tippecanoe) ==="
echo "Database: ${DATABASE_URL}"
echo "Output: ${OUTPUT_DIR}"
echo "Max zoom: ${MAX_ZOOM}"
echo "Layers: ${LAYERS}"
echo "Concurrency: ${CONCURRENCY}"
if [ -n "${BBOX}" ]; then
  echo "BBOX filter: ${BBOX}"
  # Convert BBOX from EPSG:4326 to EPSG:3857 for -spat (since -spat_srs is incompatible with -sql)
  IFS=',' read -r minlon minlat maxlon maxlat <<< "${BBOX}"
  SPAT_3857=$(python3 -c "
import math
def to_3857(lon, lat):
    x = lon * 20037508.342789244 / 180.0
    y = math.log(math.tan((90 + lat) * math.pi / 360.0)) / (math.pi / 180.0)
    y = y * 20037508.342789244 / 180.0
    return x, y
x1, y1 = to_3857($minlon, $minlat)
x2, y2 = to_3857($maxlon, $maxlat)
print(f'{x1} {y1} {x2} {y2}')
")
  echo "BBOX (EPSG:3857): ${SPAT_3857}"
fi
echo ""

# Helper: export a SQL query to FlatGeobuf
export_layer_now() {
  local layer_name="$1"
  local sql="$2"
  local geom_col="${3:-way}"

  local outfile="${FGB_DIR}/${layer_name}.fgb"
  if [ -f "${outfile}" ]; then
    echo "  [skip] ${layer_name} (already exists)"
    return 0
  fi

  echo "  [export] ${layer_name}..."
  local start_time=$(date +%s)

  # Build ogr2ogr command
  local ogr_args=(
    -f FlatGeobuf
    "${outfile}"
    PG:"${DATABASE_URL}"
    -sql "${sql}"
    -nln "${layer_name}"
    -lco SPATIAL_INDEX=NO
    -t_srs EPSG:4326
    --config PG_USE_COPY YES
  )

  # Add spatial filter if BBOX is set (minlon,minlat,maxlon,maxlat)
  # Note: -spat_srs is not compatible with -sql, so we convert bbox to EPSG:3857
  if [ -n "${BBOX}" ]; then
    ogr_args+=(-spat ${SPAT_3857})
  fi

  if ! ogr2ogr "${ogr_args[@]}" 2>&1 | tail -5; then
    echo "  [ERROR] ${layer_name} export failed" >&2
    rm -f "${outfile}"
    return 1
  fi

  local end_time=$(date +%s)
  local duration=$((end_time - start_time))
  local size=$(du -sh "${outfile}" 2>/dev/null | cut -f1)
  echo "  [done] ${layer_name}: ${size} in ${duration}s"
}

# Run exports in the background, at most CONCURRENCY at a time. The queries
# are independent, and the slow ones are database-bound, so overlapping them
# shortens Phase 1 considerably. A failed export leaves a marker file that is
# checked once all exports have finished.
export_layer() {
  while (( $(jobs -rp | wc -l) >= CONCURRENCY )); do
    wait -n || true
  done
  local layer_name="$1"
  ( export_layer_now "$@" || touch "${FGB_DIR}/.failed-${layer_name}" ) &
}

rm -f "${FGB_DIR}"/.failed-*

# Railway line relations (route=railway, e.g. a national line number such as
# DB 6100 or 京沪线) list every way of a line, bridges and tunnels included.
# The import database leaves them out, so they come from a separate planet
# extract and are joined to segments through the way id.
LINE_RELATIONS_SQL=""
if [ -n "${LINE_RELATIONS_OPL}" ]; then
  echo "--- Loading line relations from ${LINE_RELATIONS_OPL} ---"
  python3 -I "$(dirname "$0")/line-relations.py" "${LINE_RELATIONS_OPL}" "${OUTPUT_DIR}/line-relations"
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q <<SQL
SET client_min_messages = warning;
DROP TABLE IF EXISTS line_relation_members, line_relations;
CREATE TABLE line_relations (osm_id int8 PRIMARY KEY, name text, ref text, color text, operator text);
CREATE TABLE line_relation_members (relation_id int8 NOT NULL, way_id int8 NOT NULL);
\copy line_relations FROM '${OUTPUT_DIR}/line-relations/line_relations.csv' WITH (FORMAT csv)
\copy line_relation_members FROM '${OUTPUT_DIR}/line-relations/line_relation_members.csv' WITH (FORMAT csv)
CREATE INDEX ON line_relation_members (way_id);
ANALYZE line_relations, line_relation_members;
SQL
  # Same id/color/label layout as line_routes, plus the line's ref.
  LINE_RELATIONS_SQL=",
  (SELECT nullif(array_to_string(array_agg(
    r.osm_id::text || U&'\001E' ||
    coalesce(r.color, '') || U&'\001E' ||
    coalesce(r.name, r.ref, '') || U&'\001E' ||
    coalesce(r.ref, '')
    ORDER BY r.osm_id
  ), U&'\001D'), '')
  FROM line_relation_members m
  JOIN line_relations r ON r.osm_id = m.relation_id
  WHERE m.way_id = lv.osm_id) as line_relations"
  echo ""
fi

# Number of tracks and opening dates of railway ways (tracks, start_date,
# opening_date), which the import database does not keep either; same planet
# extract, joined through the way id. Empty without it.
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q <<SQL
SET client_min_messages = warning;
DROP TABLE IF EXISTS line_way_tags;
CREATE TABLE line_way_tags (way_id int8 PRIMARY KEY, tracks text, start_date text, opening_date text);
SQL
if [ -n "${LINE_RELATIONS_OPL}" ]; then
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q \
    -c "\\copy line_way_tags FROM '${OUTPUT_DIR}/line-relations/line_way_tags.csv' WITH (FORMAT csv)" \
    -c "ANALYZE line_way_tags"
fi

# Many ways carry no operator tag because mappers put it on the line instead:
# most of China's railway bureaus tag only their line relations, and Shanghai
# Metro tags only its route relations. Segments without an operator take the
# operators of their line relations, or else of their urban rail routes, so
# the railway filter and the info box see them. Train routes are left out:
# their operator runs the trains (SNCF Voyageurs, Amtrak), not the track.
# line_operators holds that fallback per way.
if [ -n "${LINE_RELATIONS_OPL}" ]; then
  RELATION_OPERATORS_SQL="
  SELECT m.way_id, r.operator
  FROM line_relation_members m
  JOIN line_relations r ON r.osm_id = m.relation_id
  WHERE r.operator <> ''"
else
  RELATION_OPERATORS_SQL="SELECT NULL::int8 AS way_id, NULL::text AS operator WHERE false"
fi
echo "--- Building line operator fallback ---"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q <<SQL
SET client_min_messages = warning;
DROP TABLE IF EXISTS line_operators;
CREATE TABLE line_operators AS
WITH relation_operators AS (
  SELECT way_id, array_agg(DISTINCT trim(o) ORDER BY trim(o)) AS operator
  FROM (${RELATION_OPERATORS_SQL}) lr
  CROSS JOIN unnest(string_to_array(lr.operator, ';')) AS o
  WHERE trim(o) <> ''
  GROUP BY way_id
), route_operators AS (
  SELECT rl.line_id AS way_id, array_agg(DISTINCT trim(o) ORDER BY trim(o)) AS operator
  FROM route_line rl
  JOIN routes r ON r.osm_id = rl.route_id
  CROSS JOIN unnest(string_to_array(r.operator, ';')) AS o
  WHERE r.type IN ('subway', 'light_rail', 'tram', 'monorail', 'funicular') AND trim(o) <> ''
  GROUP BY rl.line_id
)
SELECT
  coalesce(lo.way_id, ro.way_id) AS way_id,
  coalesce(lo.operator, ro.operator) AS fallback_operator
FROM relation_operators lo
FULL JOIN route_operators ro ON ro.way_id = lo.way_id;
CREATE UNIQUE INDEX ON line_operators (way_id);
ANALYZE line_operators;
SQL
echo ""

# One route color per line, so parallel tracks of a line (local and express,
# up and down) look alike: segments group by name and operator, and a group
# takes the color of its routes by length-weighted majority, each segment
# counting each color once. Picking a segment's color from its own routes let
# whichever route came first win, often a through service of another operator
# (東京地下鉄の直通運転 on JR and Seibu tracks).
echo "--- Building line colors ---"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q <<SQL
SET client_min_messages = warning;
DROP TABLE IF EXISTS line_colors;
CREATE TABLE line_colors AS
WITH segment_colors AS (
  SELECT DISTINCT
    lv.osm_id,
    lv.name,
    coalesce(lv.primary_operator, lo.fallback_operator[1], '') AS operator,
    coalesce(lv.way_length, 0) AS way_length,
    lower(trim(r.color)) AS color
  FROM railway_line_view lv
  JOIN route_line rl ON rl.line_id = lv.osm_id
  JOIN routes r ON r.osm_id = rl.route_id
  LEFT JOIN line_operators lo ON lo.way_id = lv.osm_id
  WHERE lv.name IS NOT NULL AND lv.state = 'present' AND nullif(trim(r.color), '') IS NOT NULL
)
SELECT DISTINCT ON (name, operator) name AS line_name, operator AS line_operator, color
FROM (
  SELECT name, operator, color, sum(way_length) AS weight, count(*) AS segments
  FROM segment_colors
  GROUP BY name, operator, color
) votes
ORDER BY name, operator, weight DESC, segments DESC, color;
CREATE UNIQUE INDEX ON line_colors (line_name, line_operator);
ANALYZE line_colors;
SQL
psql "${DATABASE_URL}" -At -c "SELECT '  ' || count(*) || ' lines colored by their routes' FROM line_colors"
echo ""
# Line queries join railway_line_view lv to the fallback operators, the
# operator colors, the way tags and the line colors.
LINE_JOINS="LEFT JOIN line_operators lo ON lo.way_id = lv.osm_id
LEFT JOIN (SELECT name AS known_operator, color AS known_color FROM railway_operator) oc
  ON oc.known_operator = coalesce(lv.primary_operator, lo.fallback_operator[1])
LEFT JOIN line_way_tags wt ON wt.way_id = lv.osm_id
LEFT JOIN line_colors lc
  ON lc.line_name = lv.name AND lc.line_operator = coalesce(lv.primary_operator, lo.fallback_operator[1], '')"
OPERATOR_SQL="nullif(array_to_string(
    CASE WHEN cardinality(lv.operator) > 0 THEN lv.operator ELSE lo.fallback_operator END,
    U&'\001E'), '')"
# Operator color as the view computes it (a known brand color, else a hue
# hashed from the primary operator), also for operators filled in above. The
# view hashes name::bytea, which fails on names with a backslash; convert_to
# gives the same bytes for every other name.
OPERATOR_NAME_SQL="coalesce(lv.primary_operator, lo.fallback_operator[1])"
OPERATOR_COLOR_SQL="CASE WHEN ${OPERATOR_NAME_SQL} IS NOT NULL THEN coalesce(oc.known_color,
    'hsl(' || get_byte(sha256(convert_to(${OPERATOR_NAME_SQL}, 'UTF8')), 0) || ', 100%, 30%)') END"

# Station sizes from China Railway's timetable. OpenRailwayMap sizes stations
# by the route relations stopping there (9 make it normal, 21 large), and
# Chinese train routes are rarely mapped, so major Chinese stations came out
# small and missed the zoomed-out map. Stations in CR_STATION_TRAINS are sized
# by trains per day instead (CR_NORMAL_TRAINS and CR_LARGE_TRAINS), and their
# importance is mapped onto the route scale so those thresholds meet 9 and 21.
# Their isolation (discr_iso, which picks the zoomed-out stations) becomes the
# distance to the nearest mainline station of higher importance, counting
# only stations the zoomed-out layers can show, so metro stations do not hide
# them. Other stations keep their values, except that a sized station of
# higher importance closer than their old neighbour lowers their isolation.
CR_NORMAL_TRAINS=24
CR_LARGE_TRAINS=120
echo "--- Building station overrides ---"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q <<SQL
SET client_min_messages = warning;
DROP TABLE IF EXISTS station_overrides, timetable_stations, station_candidates, cr_station_trains;
CREATE TABLE cr_station_trains (osm_type text, osm_id int8, cr_name text, trains_per_day real);
SQL
if [ -f "${CR_STATION_TRAINS}" ]; then
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q \
    -c "\\copy cr_station_trains FROM '$(realpath "${CR_STATION_TRAINS}")' WITH (FORMAT csv, HEADER true)"
else
  echo "  ${CR_STATION_TRAINS} not found; station sizes stay as mapped"
fi
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q <<SQL
SET client_min_messages = warning;
CREATE TABLE station_candidates AS
WITH matched AS (
  SELECT gs.id, max(c.trains_per_day) AS trains
  FROM grouped_stations_with_importance gs
  CROSS JOIN LATERAL unnest(gs.osm_ids, gs.osm_types) AS member(osm_id, osm_type)
  JOIN cr_station_trains c ON c.osm_id = member.osm_id AND c.osm_type = member.osm_type
  GROUP BY gs.id
)
SELECT
  gs.id,
  gs.center,
  gs.discr_iso,
  m.trains,
  CASE WHEN m.trains IS NULL THEN gs.importance
    ELSE 9 * power(m.trains / ${CR_NORMAL_TRAINS}.0, ln(21 / 9.0) / ln(${CR_LARGE_TRAINS}.0 / ${CR_NORMAL_TRAINS}))
  END AS importance
FROM grouped_stations_with_importance gs
LEFT JOIN matched m ON m.id = gs.id
WHERE gs.feature = 'station' AND gs.state = 'present'
  AND (gs.station IS NULL OR gs.station NOT IN ('light_rail', 'monorail', 'subway'));
CREATE INDEX ON station_candidates USING gist (center);
CREATE TABLE timetable_stations AS SELECT * FROM station_candidates WHERE trains IS NOT NULL;
CREATE INDEX ON timetable_stations USING gist (center);
CREATE TABLE station_overrides AS
SELECT
  c.id,
  CASE WHEN c.trains IS NOT NULL THEN c.importance END AS cr_importance,
  CASE
    WHEN c.trains IS NULL THEN NULL
    WHEN c.trains >= ${CR_LARGE_TRAINS} THEN 'large'
    WHEN c.trains >= ${CR_NORMAL_TRAINS} THEN 'normal'
    ELSE 'small'
  END AS cr_size,
  CASE WHEN c.trains IS NOT NULL THEN coalesce(higher.distance, 1e9) ELSE higher_timetable.distance END AS cr_discr_iso
FROM station_candidates c
LEFT JOIN LATERAL (
  SELECT ST_Distance(c.center, o.center) AS distance
  FROM station_candidates o
  WHERE c.trains IS NOT NULL AND o.importance > c.importance
  ORDER BY o.center <-> c.center
  LIMIT 1
) higher ON true
LEFT JOIN LATERAL (
  SELECT ST_Distance(c.center, o.center) AS distance
  FROM timetable_stations o
  WHERE c.trains IS NULL AND o.importance > c.importance
  ORDER BY o.center <-> c.center
  LIMIT 1
) higher_timetable ON true
WHERE c.trains IS NOT NULL OR higher_timetable.distance < c.discr_iso;
CREATE UNIQUE INDEX ON station_overrides (id);
ANALYZE station_overrides;
SQL
psql "${DATABASE_URL}" -At -c "SELECT '  ' || count(*) FILTER (WHERE cr_size IS NOT NULL) || ' stations sized by timetable (' || count(*) FILTER (WHERE cr_size = 'large') || ' large, ' || count(*) FILTER (WHERE cr_size = 'normal') || ' normal), ' || count(*) FILTER (WHERE cr_size IS NULL) || ' others closer to one' FROM station_overrides"

# Yahoo! 乗換案内 station codes for stations in Japan, the ids the timetable
# (src/timetable.ts) asks the norikae API for. A station grouped from several
# OSM features gets the codes of all of them.
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q <<SQL
SET client_min_messages = warning;
DROP TABLE IF EXISTS station_yahoo_codes, jp_station_codes;
CREATE TABLE jp_station_codes (osm_type text, osm_id int8, name text, codes text, status text);
SQL
if [ -f "${JP_STATION_CODES}" ]; then
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q \
    -c "\\copy jp_station_codes FROM '$(realpath "${JP_STATION_CODES}")' WITH (FORMAT csv, HEADER true)"
else
  echo "  ${JP_STATION_CODES} not found; timetables look stations up by name"
fi
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q <<SQL
SET client_min_messages = warning;
CREATE TABLE station_yahoo_codes AS
SELECT gs.id, string_agg(DISTINCT code, ';' ORDER BY code) AS yahoo_codes
FROM grouped_stations_with_importance gs
CROSS JOIN LATERAL unnest(gs.osm_ids, gs.osm_types) AS member(osm_id, osm_type)
JOIN jp_station_codes j ON j.osm_id = member.osm_id AND j.osm_type = member.osm_type
CROSS JOIN LATERAL unnest(string_to_array(j.codes, ';')) AS code
GROUP BY gs.id;
CREATE UNIQUE INDEX ON station_yahoo_codes (id);
ANALYZE station_yahoo_codes;
SQL
psql "${DATABASE_URL}" -At -c "SELECT '  ' || count(*) || ' stations with Yahoo station codes' FROM station_yahoo_codes"
echo ""
# Station label layers read railway_text_stations s through these.
STATION_JOIN="LEFT JOIN station_overrides so ON so.id = s.id LEFT JOIN station_yahoo_codes sy ON sy.id = s.id"
STATION_SIZE_SQL="coalesce(so.cr_size, s.station_size)"
STATION_DISCR_ISO_SQL="coalesce(so.cr_discr_iso, s.discr_iso)"
STATION_IMPORTANCE_SQL="coalesce(so.cr_importance, s.importance)"

echo "--- Phase 1: Export layers from PostGIS to FlatGeobuf ---"
echo ""

# ============================================================
# Shared layers (used by all styles)
# ============================================================

echo "[Shared layers]"

# railway_line_high (z7+)
#
# Keep this as a single tippecanoe input. Multiple input files with the same
# output layer name are merged by tippecanoe before high-zoom tiles are emitted,
# so zoom-split FGBs would stack duplicate railway_line_high features in z12+.
# That is especially visible for tunnel layers because the semitransparent
# tunnel cover is drawn repeatedly.
# Only attributes something reads are kept: the style, the client-side railway
# filter, the route highlight or the popup. Left out as unused or redundant:
# id (osm_id plus a segment suffix; hover uses tippecanoe's generated ids),
# rank (only orders features here), osm_type (always W for lines),
# gauge0-2 (text copies of gaugeint0-2 and gauges) and route_count (the
# length of line_routes). way_length only gates tunnel and bridge decorations
# while zoomed out, so other segments go without it and it is rounded to
# metres; as a unique decimal per segment it was the largest attribute.
export_railway_line_high() {
  local layer_name="$1"
  local where_clause="$2"
  local include_popup_fields="${3:-false}"
  local popup_columns=""

  if [ "${include_popup_fields}" = "true" ]; then
    popup_columns=",
  osm_id,
  track_class,
  nullif(array_to_string(reporting_marks, U&'\001E'), '') as reporting_marks,
  maxspeed,
  speed_label,
  train_protection_rank,
  train_protection[1] as train_protection0,
  train_protection[2] as train_protection1,
  train_protection[3] as train_protection2,
  train_protection_construction_rank,
  train_protection_construction,
  electrification_state,
  voltage,
  frequency,
  maximum_current,
  future_voltage,
  future_frequency,
  future_maximum_current,
  gaugeint0,
  gaugeint1,
  gaugeint2,
  array_to_string(gauges, ', ') as gauges,
  loading_gauge,
  ${OPERATOR_SQL} as operator,
  ${OPERATOR_COLOR_SQL} as operator_color,
  lc.color as line_color,
  primary_operator,
  owner,
  CASE WHEN lv.preserved THEN true END as preserved,
  rack,
  CASE WHEN wt.tracks ~ '^[0-9]+\$' THEN wt.tracks::int END as tracks,
  wt.start_date,
  wt.opening_date,
  traffic_mode,
  radio,
  (SELECT nullif(array_to_string(array_agg(
    (route_item -> 'route_id') || U&'\001E' ||
    coalesce(route_item -> 'color', '') || U&'\001E' ||
    coalesce(route_item -> 'label', '')
    ORDER BY route_item -> 'route_id'
  ), U&'\001D'), '') FROM unnest(lv.line_routes) AS route_items(route_item)) as line_routes${LINE_RELATIONS_SQL},
  wikidata,
  wikimedia_commons,
  wikimedia_commons_file,
  image,
  mapillary,
  wikipedia,
  note,
  description"
  fi

  export_layer "${layer_name}" "
SELECT
  way,
  CASE WHEN tunnel OR bridge THEN round(way_length) END AS way_length,
  feature,
  state,
  usage,
  service,
  highspeed,
  tunnel,
  bridge,
  name,
  ref,
  track_ref,
  preferred_direction${popup_columns}
FROM railway_line_view lv
${LINE_JOINS}
WHERE ${where_clause}
ORDER BY
  layer,
  rank NULLS LAST,
  maxspeed NULLS FIRST
"
}

export_railway_line_high "railway_line_high" "true" true

# railway_text_km — kilometer markers
# Martin serves only zero markers at z10-12 and all markers at z13+. Export
# everything once; the Phase 2 feature filter applies the zoom rule.
export_layer "railway_text_km" "
SELECT
  osm_id,
  way,
  railway,
  position_text as pos,
  position_exact as pos_exact,
  zero,
  round(position_numeric) as pos_int,
  type,
  wikidata,
  wikimedia_commons,
  wikimedia_commons_file,
  image,
  mapillary,
  wikipedia,
  note,
  description
FROM railway_positions
ORDER BY zero
"

# ============================================================
# Standard style layers
# ============================================================
#
# Point and station layers leave out the view's synthetic id column: nothing
# in the style or the app reads it (hover state uses tippecanoe's generated
# ids, info boxes link to OpenStreetMap through osm_id).

# station_routes for railway_text_stations rows. The view's own station_routes
# column looks routes up with ARRAY[osm_id] <@ route_ids, which cannot use an
# index and scans every route per station (~15 min per query on a planet DB).
# Rebuild the same serialized value through the routes primary key instead;
# PostgreSQL skips the view's subquery when the column is not selected.
# The import links stations to routes only through stop positions with the
# station's name, nearby platforms or stop areas, so a route that lists the
# station node itself as a stop (common for mainline trains, e.g. JR lines in
# Japan) was missing. Those routes are added through route_stop's stop_id
# index; stop members carry no OSM type, so only node ids are matched.
STATION_ROUTES_SQL="(SELECT nullif(array_to_string(array_agg(
    r.osm_id::text || U&'\001E' ||
    coalesce(r.color, '') || U&'\001E' ||
    coalesce(r.name, '')
    ORDER BY r.osm_id::text
  ), U&'\001D'), '')
  FROM routes r
  WHERE r.osm_id IN (
    SELECT unnest(g.route_ids) FROM grouped_stations_with_importance g WHERE g.id = s.id
    UNION
    SELECT rs.route_id
    FROM unnest(s.osm_id, s.osm_type) AS member(osm_id, osm_type)
    JOIN route_stop rs ON rs.stop_id = member.osm_id
    WHERE member.osm_type = 'N'
  ))"

echo ""
echo "[Standard style layers]"

# standard_railway_line_low (z0-7) — main lines for the zoomed-out map.
# Only the attributes the low-zoom style and the client-side railway filter
# read; everything else (routes, links, ids, signalling...) lives in
# railway_line_high from z7. Tunnel and bridge flags are left out too: their
# decorations are invisible at these zooms, the main line layers draw lines
# without the flags as ordinary track, and they split lines more than anything
# else (way_length only gated those decorations, so it goes as well).
# Without per-segment values, adjacent segments with identical attributes are
# merged: ST_LineMerge joins them and ST_Dump splits the result into plain
# LineStrings (MULTILINESTRINGs crashed tippecanoe). This turns ~1.2M short
# segments into ~200k line sections, shrinking a z2 tile several times over.
export_layer "standard_railway_line_low" "
SELECT
  feature,
  state,
  usage,
  highspeed,
  name,
  maxspeed,
  electrification_state,
  voltage,
  frequency,
  gaugeint0,
  gaugeint1,
  traffic_mode,
  operator,
  operator_color,
  line_color,
  way
FROM (
  SELECT
    feature,
    state,
    usage,
    highspeed,
    name,
    maxspeed,
    electrification_state,
    voltage,
    frequency,
    gaugeint0,
    gaugeint1,
    traffic_mode,
    ${OPERATOR_SQL} as operator,
    ${OPERATOR_COLOR_SQL} as operator_color,
    lc.color as line_color,
    max(rank) as rank,
    (ST_Dump(ST_LineMerge(ST_Collect(way)))).geom AS way
  FROM railway_line_view lv
  ${LINE_JOINS}
  WHERE state = 'present'
    AND feature IN ('rail', 'ferry')
    AND usage = 'main'
    AND service IS NULL
  GROUP BY
    feature, state, usage, highspeed, name, maxspeed, electrification_state, voltage, frequency,
    gaugeint0, gaugeint1, traffic_mode, ${OPERATOR_SQL}, ${OPERATOR_COLOR_SQL}, lc.color
) merged
ORDER BY rank NULLS LAST
"

# Station text layers — all from railway_text_stations view
# We export the full view and use it for all station zoom levels
# The style handles zoom filtering via minzoom/maxzoom
export_layer "standard_railway_text_stations" "
SELECT
  center AS way,
  nullif(array_to_string(s.osm_id, U&'\001E'), '') as osm_id,
  nullif(array_to_string(s.osm_type, U&'\001E'), '') as osm_type,
  feature,
  state,
  station,
  ${STATION_SIZE_SQL} as station_size,
  map_reference as label,
  name,
  name as localized_name,
  count,
  (SELECT nullif(array_to_string(array_agg(e.k || U&'\001E' || e.v ORDER BY e.k), U&'\001D'), '') FROM each(s.\"references\") AS e(k, v)) as references,
  nullif(array_to_string(operator, U&'\001E'), '') as operator,
  nullif(array_to_string(network, U&'\001E'), '') as network,
  nullif(array_to_string(position, U&'\001E'), '') as position,
  nullif(array_to_string(wikidata, U&'\001E'), '') as wikidata,
  nullif(array_to_string(wikimedia_commons, U&'\001E'), '') as wikimedia_commons,
  nullif(array_to_string(wikimedia_commons_file, U&'\001E'), '') as wikimedia_commons_file,
  nullif(array_to_string(image, U&'\001E'), '') as image,
  nullif(array_to_string(mapillary, U&'\001E'), '') as mapillary,
  nullif(array_to_string(wikipedia, U&'\001E'), '') as wikipedia,
  nullif(array_to_string(note, U&'\001E'), '') as note,
  nullif(array_to_string(description, U&'\001E'), '') as description,
  nullif(array_to_string(yard_purpose, U&'\001E'), '') as yard_purpose,
  yard_hump,
  ${STATION_ROUTES_SQL} as station_routes,
  sy.yahoo_codes,
  ${STATION_DISCR_ISO_SQL} as discr_iso
FROM railway_text_stations s
${STATION_JOIN}
WHERE name IS NOT NULL
ORDER BY
  rank DESC NULLS LAST,
  ${STATION_IMPORTANCE_SQL} DESC NULLS LAST
"

# Station low-zoom layers. Martin applies a z-dependent discr_iso threshold
# (213000 * exp(-0.33 * z) - 18000 < discr_iso). The threshold loosens as z
# grows, so export once at the highest zoom of each range; the Phase 2 feature
# filter tightens it per zoom using the discr_iso attribute.
STATIONS_LOW_ZOOMS=(4 5 6 7)
STATIONS_MED_ZOOMS=(7 8)
station_discr_threshold() {
  awk -v z="$1" 'BEGIN { printf "%.3f", 213000 * exp(-0.33 * z) - 18000 }'
}

z="${STATIONS_LOW_ZOOMS[-1]}"
export_layer "standard_railway_text_stations_low" "
SELECT
  center AS way,
  nullif(array_to_string(s.osm_id, U&'\001E'), '') as osm_id,
  nullif(array_to_string(s.osm_type, U&'\001E'), '') as osm_type,
  feature, state, station,
  map_reference as label, name, name as localized_name,
  ${STATION_SIZE_SQL} as station_size,
  (SELECT nullif(array_to_string(array_agg(e.k || U&'\001E' || e.v ORDER BY e.k), U&'\001D'), '') FROM each(s.\"references\") AS e(k, v)) as references,
  nullif(array_to_string(operator, U&'\001E'), '') as operator,
  nullif(array_to_string(network, U&'\001E'), '') as network,
  nullif(array_to_string(position, U&'\001E'), '') as position,
  nullif(array_to_string(wikidata, U&'\001E'), '') as wikidata,
  nullif(array_to_string(wikimedia_commons, U&'\001E'), '') as wikimedia_commons,
  nullif(array_to_string(wikimedia_commons_file, U&'\001E'), '') as wikimedia_commons_file,
  nullif(array_to_string(image, U&'\001E'), '') as image,
  nullif(array_to_string(mapillary, U&'\001E'), '') as mapillary,
  nullif(array_to_string(wikipedia, U&'\001E'), '') as wikipedia,
  nullif(array_to_string(note, U&'\001E'), '') as note,
  nullif(array_to_string(description, U&'\001E'), '') as description,
  nullif(array_to_string(yard_purpose, U&'\001E'), '') as yard_purpose,
  yard_hump,
  ${STATION_ROUTES_SQL} as station_routes,
  sy.yahoo_codes,
  ${STATION_DISCR_ISO_SQL} as discr_iso
FROM railway_text_stations s
${STATION_JOIN}
WHERE feature = 'station' AND state = 'present'
  AND (station IS NULL OR station NOT IN ('light_rail', 'monorail', 'subway'))
  AND 213000 * exp(-0.33 * ${z}) - 18000 < ${STATION_DISCR_ISO_SQL}
  AND ${STATION_SIZE_SQL} IN ('large', 'normal')
ORDER BY ${STATION_IMPORTANCE_SQL} DESC NULLS LAST
"

# z7-8: all station types except light_rail/monorail/subway.
z="${STATIONS_MED_ZOOMS[-1]}"
export_layer "standard_railway_text_stations_med" "
SELECT
  center AS way,
  nullif(array_to_string(s.osm_id, U&'\001E'), '') as osm_id,
  nullif(array_to_string(s.osm_type, U&'\001E'), '') as osm_type,
  feature, state, station,
  map_reference as label, name, name as localized_name,
  ${STATION_SIZE_SQL} as station_size,
  (SELECT nullif(array_to_string(array_agg(e.k || U&'\001E' || e.v ORDER BY e.k), U&'\001D'), '') FROM each(s.\"references\") AS e(k, v)) as references,
  nullif(array_to_string(operator, U&'\001E'), '') as operator,
  nullif(array_to_string(network, U&'\001E'), '') as network,
  nullif(array_to_string(position, U&'\001E'), '') as position,
  nullif(array_to_string(wikidata, U&'\001E'), '') as wikidata,
  nullif(array_to_string(wikimedia_commons, U&'\001E'), '') as wikimedia_commons,
  nullif(array_to_string(wikimedia_commons_file, U&'\001E'), '') as wikimedia_commons_file,
  nullif(array_to_string(image, U&'\001E'), '') as image,
  nullif(array_to_string(mapillary, U&'\001E'), '') as mapillary,
  nullif(array_to_string(wikipedia, U&'\001E'), '') as wikipedia,
  nullif(array_to_string(note, U&'\001E'), '') as note,
  nullif(array_to_string(description, U&'\001E'), '') as description,
  nullif(array_to_string(yard_purpose, U&'\001E'), '') as yard_purpose,
  yard_hump,
  ${STATION_ROUTES_SQL} as station_routes,
  sy.yahoo_codes,
  ${STATION_DISCR_ISO_SQL} as discr_iso
FROM railway_text_stations s
${STATION_JOIN}
WHERE feature = 'station' AND state = 'present'
  AND (station IS NULL OR station NOT IN ('light_rail', 'monorail', 'subway'))
  AND 213000 * exp(-0.33 * ${z}) - 18000 < ${STATION_DISCR_ISO_SQL}
ORDER BY ${STATION_IMPORTANCE_SQL} DESC NULLS LAST
"

# standard_railway_turntables (z10+)
export_layer "standard_railway_turntables" "
SELECT osm_id, osm_type, way, replace(feature, 'general/', '') AS feature FROM pois
WHERE feature IN ('general/turntable', 'general/traverser')
  AND ST_GeometryType(way) IN ('ST_Polygon', 'ST_MultiPolygon')
"

# standard_station_entrances (z16+)
export_layer "standard_station_entrances" "
SELECT
  osm_id, osm_type, way, type, name, ref, label,
  wikidata, wikimedia_commons, wikimedia_commons_file,
  image, mapillary, wikipedia, note, description
FROM standard_station_entrances_view
"

# standard_railway_symbols — from poi_view, standard layer.
# Keep all symbols needed by the archive and let the style's
# "zoom >= minzoom" filter decide visibility. If the archive max zoom is below
# the official max, include the highest-detail POIs because the demo style caps
# those layers down to the archive max zoom.
symbols_effective_max_zoom="${MAX_ZOOM}"
if (( MAX_ZOOM < 17 )); then
  symbols_effective_max_zoom=17
fi
export_layer "standard_railway_symbols" "
SELECT
  osm_id, osm_type, center AS way, feature, ref, name, minzoom,
  nullif(array_to_string(position, U&'\001E'), '') as position,
  wikidata, wikimedia_commons, wikimedia_commons_file,
  image, mapillary, wikipedia, note, description
FROM pois
WHERE feature IN ('general/aei','general/buffer_stop','general/car-dumper','general/car-shuttle','general/carrier-truck-pit','general/coaling_facility','general/compressed_air_supply','general/container-terminal','general/crossing','general/defect_detector','general/derail','general/engine_shed','general/ferry-terminal','general/fuel','general/gauge-conversion','general/hirail_access','general/hump_yard','general/level-crossing','general/level-crossing-barrier','general/level-crossing-light','general/level-crossing-light-barrier','general/loading-rack','general/loading-ramp','general/loading-tower','general/loading_gauge','general/lubricator','general/museum','general/museum-rail-transport','general/phone','general/pit','general/preheating','general/radio-antenna','general/radio-mast','general/retarder','general/rolling_highway','general/sand_store','general/track-scale','general/unloading-hole','general/wash','general/waste_disposal','general/water_crane','general/water_tower','general/workshop')
  AND minzoom <= ${symbols_effective_max_zoom}
ORDER BY rank DESC
"

# standard_railway_platforms (z15+)
export_layer "standard_railway_platforms" "
SELECT
  osm_id, osm_type, way, feature, name,
  nullif(array_to_string(ref, U&'\001E'), '') as ref,
  height, surface, elevator, shelter, lit, bin, bench,
  wheelchair, departures_board, tactile_paving,
  (SELECT nullif(array_to_string(array_agg(
    (route_item -> 'route_id') || U&'\001E' ||
    coalesce(route_item -> 'color', '') || U&'\001E' ||
    coalesce(route_item -> 'label', '')
    ORDER BY route_item -> 'route_id'
  ), U&'\001D'), '') FROM unnest(p.platform_routes) AS route_items(route_item)) as platform_routes
FROM standard_railway_platforms_view p
"

# standard_railway_platform_edges (z17+)
export_layer "standard_railway_platform_edges" "
SELECT
  osm_id, osm_type, way, feature, ref, height, tactile_paving
FROM standard_railway_platform_edges_view
"

# standard_railway_stop_positions (z16+)
export_layer "standard_railway_stop_positions" "
SELECT
  osm_id, osm_type, way, name, type, ref, local_ref,
  (SELECT nullif(array_to_string(array_agg(
    (route_item -> 'route_id') || U&'\001E' ||
    coalesce(route_item -> 'color', '') || U&'\001E' ||
    coalesce(route_item -> 'label', '')
    ORDER BY route_item -> 'route_id'
  ), U&'\001D'), '') FROM unnest(sp.stop_position_routes) AS route_items(route_item)) as stop_position_routes
FROM standard_railway_stop_positions_view sp
"

# standard_railway_switch_ref (z17+)
export_layer "standard_railway_switch_ref" "
SELECT
  osm_id, osm_type, way, railway, ref, type,
  turnout_side, local_operated, resetting,
  nullif(array_to_string(position, U&'\001E'), '') as position,
  wikidata, wikimedia_commons, wikimedia_commons_file,
  image, mapillary, wikipedia, note, description
FROM standard_railway_switch_view
ORDER BY char_length(ref)
"

# standard_railway_grouped_stations (z13+) — clustered station areas
# Without station_routes: the station label layer carries the same lists, and
# that is where info boxes and the route highlight read them.
export_layer "standard_railway_grouped_stations" "
SELECT
  buffered as way,
  nullif(array_to_string(s.osm_id, U&'\001E'), '') as osm_id,
  nullif(array_to_string(s.osm_type, U&'\001E'), '') as osm_type,
  feature,
  state,
  station,
  map_reference as label,
  name,
  name as localized_name,
  (SELECT nullif(array_to_string(array_agg(e.k || U&'\001E' || e.v ORDER BY e.k), U&'\001D'), '') FROM each(s.\"references\") AS e(k, v)) as references,
  nullif(array_to_string(operator, U&'\001E'), '') as operator,
  nullif(array_to_string(network, U&'\001E'), '') as network,
  nullif(array_to_string(position, U&'\001E'), '') as position,
  nullif(array_to_string(wikidata, U&'\001E'), '') as wikidata,
  nullif(array_to_string(wikimedia_commons, U&'\001E'), '') as wikimedia_commons,
  nullif(array_to_string(wikimedia_commons_file, U&'\001E'), '') as wikimedia_commons_file,
  nullif(array_to_string(image, U&'\001E'), '') as image,
  nullif(array_to_string(mapillary, U&'\001E'), '') as mapillary,
  nullif(array_to_string(wikipedia, U&'\001E'), '') as wikipedia,
  nullif(array_to_string(note, U&'\001E'), '') as note,
  nullif(array_to_string(description, U&'\001E'), '') as description,
  nullif(array_to_string(yard_purpose, U&'\001E'), '') as yard_purpose,
  yard_hump
FROM railway_text_stations s
"

# standard_railway_grouped_station_areas (z13+)
# Station area outlines group several stops (an interchange). Flag which kinds
# of station they contain so clients can hide urban-only interchanges together
# with urban transit stations (same member path as stop_area_groups_buffered).
export_layer "standard_railway_grouped_station_areas" "
SELECT
  v.osm_id,
  v.osm_type,
  v.feature,
  v.way,
  coalesce(k.has_urban_station, false) as has_urban_station,
  coalesce(k.has_rail_station, true) as has_rail_station
FROM standard_railway_grouped_station_areas_view v
LEFT JOIN (
  SELECT
    sag.osm_id,
    bool_or(s.station IN ('subway', 'light_rail', 'monorail', 'funicular', 'tram')) as has_urban_station,
    bool_or(s.station IS NULL OR s.station NOT IN ('subway', 'light_rail', 'monorail', 'funicular', 'tram')) as has_rail_station
  FROM stop_area_groups sag
  JOIN stop_areas sa ON sa.osm_id = ANY(sag.stop_area_ref_ids)
  JOIN stations_stop_areas ssa ON ssa.stop_area_osm_id = sa.osm_id
  JOIN stations s ON ssa.station_id = s.id
  GROUP BY sag.osm_id
) k ON k.osm_id = v.osm_id
"

# ============================================================
# Speed style layers
# ============================================================

if [ "${LAYERS}" = "all" ]; then
echo ""
echo "[Speed style layers]"

# speed_railway_line_low (z0-7)
export_layer "speed_railway_line_low" "
SELECT
  id, osm_id, way, feature, state, usage,
  maxspeed, ref, speed_label, rank
FROM railway_line_low
"

# speed_railway_signals (z13+) — from speed_railway_signals_view (expanded
# feature0/1, deactivated0/1, offset0/1 columns; position stringified)
export_layer "speed_railway_signals" "
SELECT
  id, way, osm_id, osm_type, rank, railway, direction_both,
  ref, caption,
  nullif(array_to_string(position, U&'\001E'), '') as position,
  azimuth, type,
  feature0, feature1, feature2, feature3, feature4, feature5,
  deactivated0, deactivated1, deactivated2, deactivated3, deactivated4, deactivated5,
  offset0, offset1, offset2, offset3, offset4, offset5
FROM speed_railway_signals_view
"

# ============================================================
# Signals style layers
# ============================================================

echo ""
echo "[Signals style layers]"


# signals_railway_line_low (z0-7)
export_layer "signals_railway_line_low" "
SELECT
  id, osm_id, way, feature, state, usage, ref,
  train_protection_rank,
  train_protection[1] as train_protection0,
  train_protection[2] as train_protection1,
  train_protection[3] as train_protection2,
  train_protection_construction_rank, train_protection_construction,
  rank
FROM railway_line_low
"

# signals_signal_boxes (z8-14) — point at medium zoom, geometry at z14
export_layer "signals_signal_boxes_low" "
SELECT
  id,
  0 as zoom_part,
  center as way,
  feature,
  ref,
  name,
  operator_color,
  operator_bright
FROM signal_boxes_view
"

export_layer "signals_signal_boxes_high" "
SELECT
  id,
  1 as zoom_part,
  way,
  feature,
  ref,
  name,
  operator_color,
  operator_bright
FROM signal_boxes_view
"

# signals_railway_signals (z13+) — all signal features
# Upstream now stores multi-signal arrays; the *_signals_view expands them
# into feature0-5 / deactivated0-5 / offset0-5 columns (FlatGeobuf cannot
# hold StringList), matching what the style renders. position is a text[]
# column on the signals table, so it must be stringified here.
export_layer "signals_railway_signals" "
SELECT
  id, way, osm_id, osm_type, rank, railway, direction_both,
  ref, caption,
  nullif(array_to_string(position, U&'\001E'), '') as position,
  azimuth, type,
  feature0, feature1, feature2, feature3, feature4, feature5,
  deactivated0, deactivated1, deactivated2, deactivated3, deactivated4, deactivated5,
  offset0, offset1, offset2, offset3, offset4, offset5
FROM signals_railway_signals_view
"

# ============================================================
# Electrification style layers
# ============================================================

echo ""
echo "[Electrification style layers]"

# electrification_railway_line_low (z0-7)
export_layer "electrification_railway_line_low" "
SELECT
  id, osm_id, way, feature, state, usage, ref,
  electrification_state, voltage, frequency, maximum_current,
  rank
FROM railway_line_low
"

# electrification_signals (z13+) — from electrification_signals_view
# (expanded columns; position stringified)
export_layer "electrification_signals" "
SELECT
  id, way, osm_id, osm_type, rank, railway, direction_both,
  ref, caption,
  nullif(array_to_string(position, U&'\001E'), '') as position,
  azimuth, type,
  feature0, feature1, feature2, feature3, feature4, feature5,
  deactivated0, deactivated1, deactivated2, deactivated3, deactivated4, deactivated5,
  offset0, offset1, offset2, offset3, offset4, offset5
FROM electrification_signals_view
"

# electrification_railway_symbols (z13+) — from poi_view, electrification layer
export_layer "electrification_railway_symbols" "
SELECT
  id, way, feature, ref, minzoom
FROM poi_view
WHERE layer = 'electrification' AND minzoom <= 17
ORDER BY rank DESC
"

# electrification_catenary (z14+)
export_layer "electrification_catenary" "
SELECT
  id, way, feature, ref, transition
FROM electrification_catenary_view
"

# electrification_substation (z13+)
export_layer "electrification_substation" "
SELECT
  id, way, name
FROM electrification_substation_view
"

# ============================================================
# Track style layers
# ============================================================

echo ""
echo "[Track style layers]"

# track_railway_line_low (z0-7)
# Query railway_line_view directly (not railway_line_low) to get the gauges
# array, which the style uses for the gauge label. railway_line_low lacks it.
export_layer "track_railway_line_low" "
SELECT
  id, osm_id, way, feature, state, usage, ref,
  gaugeint0, gauge0,
  array_to_string(gauges, ', ') as gauges,
  track_class, loading_gauge, rank
FROM railway_line_view
WHERE state = 'present'
  AND feature IN ('rail', 'ferry')
  AND usage = 'main'
  AND service IS NULL
"

# ============================================================
# Operator style layers
# ============================================================

echo ""
echo "[Operator style layers]"

# operator_railway_line_low (z0-7)
export_layer "operator_railway_line_low" "
SELECT
  id, osm_id, way, feature, state, usage, ref,
  nullif(array_to_string(operator, U&'\001E'), '') as operator,
  operator_color, operator_bright, primary_operator, owner, rank
FROM railway_line_low
"

# operator_railway_symbols (z13+) — from poi_view, operator layer
export_layer "operator_railway_symbols" "
SELECT
  id, way, feature, ref, minzoom
FROM poi_view
WHERE layer = 'operator' AND minzoom <= 17
ORDER BY rank DESC
"

# ============================================================
# Route style layers
# ============================================================

echo ""
echo "[Route style layers]"

# route_railway_line_low (z0-7)
export_layer "route_railway_line_low" "
SELECT
  id, osm_id, way, feature, state, usage, highspeed,
  (select count(*) from route_line rl join routes r on rl.route_id = r.osm_id where rl.line_id = l.osm_id) as route_count,
  name, ref, rank
FROM railway_line_low l
"

fi  # end LAYERS=all

echo ""
wait
failed_exports=("${FGB_DIR}"/.failed-*)
if [ -e "${failed_exports[0]}" ]; then
  echo "Phase 1 failed for: ${failed_exports[*]##*/.failed-}" >&2
  exit 1
fi

echo "--- Phase 1 complete ---"
echo ""

# Count exported files
fgb_count=$(ls -1 "${FGB_DIR}"/*.fgb 2>/dev/null | wc -l)
total_size=$(du -sh "${FGB_DIR}" 2>/dev/null | cut -f1)
echo "Exported ${fgb_count} layers, total size: ${total_size}"
echo ""

# ============================================================
# Phase 2: Generate PMTiles with tippecanoe
# ============================================================

echo "--- Phase 2: Generate PMTiles with tippecanoe ---"
echo ""

PMTILES_FILE="${OUTPUT_DIR}/openrailwaymap.pmtiles"

# Build tippecanoe command with all layers and their zoom ranges
# Format: -L layer_name:minzoom:maxzoom:file.fgb
TIPPECANOE_ARGS=(
  --output="${PMTILES_FILE}"
  --force
  --maximum-zoom="${MAX_ZOOM}"
  --minimum-zoom=0

  # General settings
  --no-tile-size-limit
  --no-feature-limit
  --generate-ids
  --progress-interval="${PROGRESS_INTERVAL}"
  -r1  # Keep all features at all zoom levels (no density-based dropping)

  # Attribution
  --name="OpenRailwayMap"
  --description="OpenRailwayMap vector tiles"
  --attribution="© OpenStreetMap contributors | Style: OpenRailwayMap"

  # Numeric type coercion — tippecanoe's FlatGeobuf reader converts all
  # numeric columns to strings; -T forces them back to the correct types.
  # Float attributes
  -T way_length:float
  -T maxspeed:float
  -T tracks:int
  -T frequency:float
  -T future_frequency:float
  -T height:float
  -T position_numeric:float
  # Integer attributes
  -T rank:int
  -T voltage:int
  -T maximum_current:int
  -T future_voltage:int
  -T future_maximum_current:int
  -T train_protection_rank:int
  -T train_protection_construction_rank:int
  -T gaugeint0:int
  -T gaugeint1:int
  -T gaugeint2:int
  -T route_count:int
  -T count:int
  -T importance:int
  -T discr_iso:float
  -T pos_int:int
  -T minzoom:int
  -T zoom_part:int
  -T way_area:float
  # Signal feature columns (expanded from arrays by the *_signals_view)
  -T offset0:float
  -T offset1:float
  -T offset2:float
  -T offset3:float
  -T offset4:float
  -T offset5:float
  -T deactivated0:bool
  -T deactivated1:bool
  -T deactivated2:bool
  -T deactivated3:bool
  -T deactivated4:bool
  -T deactivated5:bool
  -T azimuth:float
  -T direction_both:bool
)

# Register each layer with the zoom range from the martin configuration.
#
# tippecanoe's -L accepts only file/layer/description/format, so zoom ranges
# cannot go there (they would be silently ignored and every layer would land
# in every zoom). Instead each output layer gets a feature filter (-j) that
# tests $zoom, plus any attribute rules Martin applies per zoom.
#
# Filter caveat: tippecanoe's ["==", attr, true] matches every feature, so
# boolean tests must be written as ["!=", attr, false].
declare -A LAYER_FILTERS=()

zoom_range_filter() {
  local minzoom="$1" maxzoom="$2"
  printf '["all",[">=","$zoom",%s],["<=","$zoom",%s]]' "${minzoom}" "${maxzoom}"
}

# Clamp a zoom range to MAX_ZOOM. Prints "min max", or nothing if empty.
clamp_zoom_range() {
  local minzoom="$1" maxzoom="$2"
  if (( minzoom > MAX_ZOOM )); then
    return 0
  fi
  if (( maxzoom > MAX_ZOOM )); then
    maxzoom="${MAX_ZOOM}"
  fi
  if (( maxzoom >= minzoom )); then
    echo "${minzoom} ${maxzoom}"
  fi
}

# Add an input file under an output layer name, with a full filter expression.
add_layer_filtered() {
  local file_name="$1"
  local layer_name="$2"
  local filter="$3"
  local file="${FGB_DIR}/${file_name}.fgb"

  if [ ! -s "${file}" ]; then
    echo "  [skip] ${file_name} -> ${layer_name} (no data)"
    return 0
  fi
  TIPPECANOE_ARGS+=("-L" "{\"file\":\"${file}\",\"layer\":\"${layer_name}\"}")
  if [ -n "${filter}" ]; then
    LAYER_FILTERS[${layer_name}]="${filter}"
  fi
}

# Add a layer whose features all share one zoom range.
add_layer() {
  local name="$1"
  local range
  range=$(clamp_zoom_range "$2" "$3")
  if [ -z "${range}" ]; then
    echo "  [skip] ${name} (zoom range $2-$3 outside 0-${MAX_ZOOM})"
    return 0
  fi
  add_layer_filtered "${name}" "${name}" "$(zoom_range_filter ${range})"
}

# Layers whose official minzoom is above MAX_ZOOM are still included at
# MAX_ZOOM, so clients can overzoom them.
add_layer_capped_to_max() {
  local name="$1" minzoom="$2" maxzoom="$3"
  if (( minzoom > MAX_ZOOM )); then
    minzoom="${MAX_ZOOM}"
  fi
  add_layer "${name}" "${minzoom}" "${maxzoom}"
}

# Layers carrying a per-feature minzoom attribute: from the layer's minzoom,
# keep a feature at zoom z only if minzoom <= z. At MAX_ZOOM keep everything,
# since clients overzoom that level.
add_layer_with_feature_minzoom() {
  local name="$1" layer_minzoom="$2"
  if (( layer_minzoom > MAX_ZOOM )); then
    layer_minzoom="${MAX_ZOOM}"
  fi
  local clauses=("[\">=\",\"\$zoom\",${MAX_ZOOM}]")
  local z
  for (( z = layer_minzoom; z < MAX_ZOOM; z++ )); do
    clauses+=("[\"all\",[\"==\",\"\$zoom\",${z}],[\"<=\",\"minzoom\",${z}]]")
  done
  local IFS=,
  add_layer_filtered "${name}" "${name}" "[\"all\",[\">=\",\"\$zoom\",${layer_minzoom}],[\"any\",${clauses[*]}]]"
}

# Station label layers: Martin's discr_iso threshold for each zoom.
add_station_layer() {
  local name="$1"
  shift
  local clauses=() z
  for z in "$@"; do
    if (( z <= MAX_ZOOM )); then
      clauses+=("[\"all\",[\"==\",\"\$zoom\",${z}],[\">\",\"discr_iso\",$(station_discr_threshold "${z}")]]")
    fi
  done
  if (( ${#clauses[@]} == 0 )); then
    echo "  [skip] ${name} (zooms $* outside 0-${MAX_ZOOM})"
    return 0
  fi
  local IFS=,
  add_layer_filtered "${name}" "${name}" "[\"any\",${clauses[*]}]"
}

# Shared
# railway_line_high: each segment only from the zoom the standard style first
# draws its kind at (public/orm/style/standard.json; the style's filters only
# test feature, usage and state). Below that zoom it is invisible, yet at z7-9
# it made up roughly half of each tile. Segments on a route are kept from z7
# because the route highlight draws routes from z7 tiles and traces them
# below z7. Keep these categories in step with the style.
railway_line_high_filter() {
  local z9=$(( MAX_ZOOM < 9 ? MAX_ZOOM : 9 ))
  local z10=$(( MAX_ZOOM < 10 ? MAX_ZOOM : 10 ))
  local z11=$(( MAX_ZOOM < 11 ? MAX_ZOOM : 11 ))
  local z12=$(( MAX_ZOOM < 12 ? MAX_ZOOM : 12 ))
  local active='["in","state","present","construction","proposed"]'
  # z7-8: main and branch lines, ferries.
  local from7="[\"all\",${active},[\"any\",[\"all\",[\"==\",\"feature\",\"rail\"],[\"in\",\"usage\",\"main\",\"branch\"]],[\"==\",\"feature\",\"ferry\"]]]"
  # z9: urban transit, test and military, tourism or preserved, industrial.
  local from9="[\"any\",[\"all\",${active},[\"in\",\"feature\",\"subway\",\"tram\",\"light_rail\",\"monorail\"]],[\"all\",${active},[\"==\",\"feature\",\"rail\"],[\"in\",\"usage\",\"test\",\"military\"]],[\"all\",[\"in\",\"state\",\"present\",\"construction\",\"proposed\",\"preserved\"],[\"any\",[\"==\",\"usage\",\"tourism\"],[\"==\",\"state\",\"preserved\"]]],[\"all\",${active},[\"==\",\"usage\",\"industrial\"],[\"in\",\"feature\",\"rail\",\"narrow_gauge\"]]]"
  # z10: narrow gauge, and rail without a usage (service tracks).
  local from10="[\"any\",[\"all\",${active},[\"==\",\"feature\",\"narrow_gauge\"],[\"any\",[\"!has\",\"usage\"],[\"!=\",\"usage\",\"industrial\"]]],[\"all\",${active},[\"==\",\"feature\",\"rail\"],[\"!has\",\"usage\"]]]"
  # z11: disused. Everything else (abandoned, razed, miniature, funicular,
  # kinds the style does not draw) from z12.
  local from11='["==","state","disused"]'
  printf '["all",%s,["any",[">=","$zoom",%s],["has","line_routes"],["all",[">=","$zoom",%s],%s],["all",[">=","$zoom",%s],%s],["all",[">=","$zoom",%s],%s],%s]]' \
    "$(zoom_range_filter 7 "${MAX_ZOOM}")" "${z12}" "${z11}" "${from11}" "${z10}" "${from10}" "${z9}" "${from9}" "${from7}"
}
add_layer_filtered "railway_line_high" "railway_line_high" "$(railway_line_high_filter)"
# railway_text_km: z10-12 zero markers only, z13+ all markers
add_layer_filtered "railway_text_km" "railway_text_km" \
  "[\"any\",[\">=\",\"\$zoom\",13],[\"all\",[\">=\",\"\$zoom\",10],[\"!=\",\"zero\",false]]]"

# Standard
add_layer "standard_railway_line_low"             0  7
add_station_layer "standard_railway_text_stations_low" "${STATIONS_LOW_ZOOMS[@]}"
add_station_layer "standard_railway_text_stations_med" "${STATIONS_MED_ZOOMS[@]}"
add_layer "standard_railway_text_stations"        8  "${MAX_ZOOM}"
add_layer "standard_railway_turntables"           10 "${MAX_ZOOM}"
add_layer_capped_to_max "standard_station_entrances"     16 "${MAX_ZOOM}"
add_layer_with_feature_minzoom "standard_railway_symbols" 12
add_layer "standard_railway_platforms"             15 "${MAX_ZOOM}"
add_layer_capped_to_max "standard_railway_platform_edges" 17 "${MAX_ZOOM}"
add_layer_capped_to_max "standard_railway_stop_positions" 16 "${MAX_ZOOM}"
add_layer_capped_to_max "standard_railway_switch_ref"     17 "${MAX_ZOOM}"
add_layer "standard_railway_grouped_stations"      13 "${MAX_ZOOM}"
add_layer "standard_railway_grouped_station_areas" 13 "${MAX_ZOOM}"

if [ "${LAYERS}" = "all" ]; then
# Speed
add_layer "speed_railway_line_low"                0  7
add_layer "speed_railway_signals"                 13 "${MAX_ZOOM}"

# Signals
add_layer "signals_railway_line_low"              0  7
# Signal boxes: points (zoom_part 0) at z8-13, full geometry (zoom_part 1) at z14
signal_boxes_filter="[\"any\",[\"all\",[\"==\",\"zoom_part\",0],$(zoom_range_filter 8 13)],[\"all\",[\"==\",\"zoom_part\",1],$(zoom_range_filter 14 14)]]"
add_layer_filtered "signals_signal_boxes_low" "signals_signal_boxes" "${signal_boxes_filter}"
add_layer_filtered "signals_signal_boxes_high" "signals_signal_boxes" "${signal_boxes_filter}"
add_layer "signals_railway_signals"               13 "${MAX_ZOOM}"

# Electrification
add_layer "electrification_railway_line_low"      0  7
add_layer "electrification_signals"               13 "${MAX_ZOOM}"
add_layer_with_feature_minzoom "electrification_railway_symbols" 13
add_layer "electrification_catenary"              14 "${MAX_ZOOM}"
add_layer "electrification_substation"            13 "${MAX_ZOOM}"

# Track
add_layer "track_railway_line_low"                0  7

# Operator
add_layer "operator_railway_line_low"             0  7
add_layer_with_feature_minzoom "operator_railway_symbols" 13

# Route
add_layer "route_railway_line_low"                0  7
fi  # end LAYERS=all

filter_json=""
for layer_name in "${!LAYER_FILTERS[@]}"; do
  filter_json+="${filter_json:+,}\"${layer_name}\":${LAYER_FILTERS[${layer_name}]}"
done
TIPPECANOE_ARGS+=(-j "{${filter_json}}")

echo ""
echo "Running tippecanoe with ${#TIPPECANOE_ARGS[@]} arguments..."
echo ""

tippecanoe "${TIPPECANOE_ARGS[@]}" 2>&1

echo ""
echo "--- Phase 2 complete ---"
echo ""

pmtiles_size=$(du -sh "${PMTILES_FILE}" 2>/dev/null | cut -f1)
echo "Output: ${PMTILES_FILE} (${pmtiles_size})"
echo ""
echo "=== Export complete ==="
