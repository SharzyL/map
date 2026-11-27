"""The tables the tile export adds to the OpenRailwayMap import database, and the SQL
expressions through which the layer queries (layers.py) read them.

Each build_* function makes its tables from scratch. A missing optional input leaves its
tables empty, so the expressions reading them work either way.
"""

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


# ── Line relations ──────────────────────────────────────

# Railway line relations (route=railway, e.g. a national line number such as
# DB 6100 or 京沪线) list every way of a line, bridges and tunnels included.
# The import database leaves them out, so they come from a separate planet
# extract and are joined to segments through the way id. The same extract
# holds the number of tracks and opening dates of railway ways (tracks,
# start_date, opening_date), which the import database does not keep either.
def build_line_relations(db, opl, out_dir):
    db.run("""
DROP TABLE IF EXISTS line_relation_members, line_relations, line_way_tags;
CREATE TABLE line_relations (osm_id int8 PRIMARY KEY, name text, ref text, color text, operator text);
CREATE TABLE line_relation_members (relation_id int8 NOT NULL, way_id int8 NOT NULL);
CREATE TABLE line_way_tags (way_id int8 PRIMARY KEY, tracks text, start_date text, opening_date text);
""")
    if opl:
        print(f'--- Loading line relations from {opl} ---')
        csv_dir = Path(out_dir) / 'line-relations'
        subprocess.run([sys.executable, '-I', HERE / 'line-relations.py', opl, csv_dir], check=True)
        db.copy('line_relations', csv_dir / 'line_relations.csv')
        db.copy('line_relation_members', csv_dir / 'line_relation_members.csv')
        db.copy('line_way_tags', csv_dir / 'line_way_tags.csv')
    db.run("""
CREATE INDEX ON line_relation_members (way_id);
ANALYZE line_relations, line_relation_members, line_way_tags;
""")


# A segment's line relations, in the same id/color/label layout as line_routes,
# plus the line's ref.
RELATION_LIST = r"""(SELECT nullif(array_to_string(array_agg(
    r.osm_id::text || U&'\001E' ||
    coalesce(r.color, '') || U&'\001E' ||
    coalesce(r.name, r.ref, '') || U&'\001E' ||
    coalesce(r.ref, '')
    ORDER BY r.osm_id
  ), U&'\001D'), '')
  FROM line_relation_members m
  JOIN line_relations r ON r.osm_id = m.relation_id
  WHERE m.way_id = lv.osm_id)"""


# ── Official lines ──────────────────────────────────────

# Japan's official lines (line-groups.sh). OSM has no route=railway relation
# for about a quarter of Japan's mainline track (外房線, 武蔵野線, 京成本線…)
# and names ways inconsistently (JR外房線 and 外房線, JR山陰線 for 山陰本線),
# so there a way's line is the official line of MLIT's railway data (N02) it
# follows, named from OSM. A way on shared track is on several (rank 0 is the
# one it follows). Only N02 lines are kept: the script's other groups are what
# relations and names already give.
def build_official_lines(db, line_groups_dir):
    db.run("""
DROP TABLE IF EXISTS line_group_ways, line_groups;
CREATE TABLE line_groups (
  group_id int PRIMARY KEY, line_id text, source text, operator text, legal_name text, name text, aliases text
);
CREATE TABLE line_group_ways (group_id int NOT NULL, way_id int8 NOT NULL, rank int NOT NULL);
""")
    if line_groups_dir:
        print(f'--- Loading official lines from {line_groups_dir} ---')
        db.copy('line_groups', Path(line_groups_dir) / 'line_groups.csv', header=True)
        db.copy('line_group_ways', Path(line_groups_dir) / 'line_group_ways.csv', header=True)
    db.run("""
DELETE FROM line_group_ways w USING line_groups g WHERE g.group_id = w.group_id AND g.source <> 'n02';
DELETE FROM line_groups WHERE source <> 'n02';
CREATE INDEX ON line_group_ways (way_id);
ANALYZE line_groups, line_group_ways;
""")
    db.report("SELECT '  ' || count(*) || ' official lines' FROM line_groups")
    print()


# ── Operators ───────────────────────────────────────────

# Many ways carry no operator tag because mappers put it on the line instead:
# most of China's railway bureaus tag only their line relations, and Shanghai
# Metro tags only its route relations. Segments without an operator take the
# operators of their line relations, or else of their urban rail routes, so
# the railway filter and the info box see them. Train routes are left out:
# their operator runs the trains (SNCF Voyageurs, Amtrak), not the track.
# line_operators holds that fallback per way.
def build_line_operators(db):
    print('--- Building line operator fallback ---')
    db.run("""
DROP TABLE IF EXISTS line_operators;
CREATE TABLE line_operators AS
WITH relation_operators AS (
  SELECT m.way_id, array_agg(DISTINCT trim(o) ORDER BY trim(o)) AS operator
  FROM line_relation_members m
  JOIN line_relations r ON r.osm_id = m.relation_id
  CROSS JOIN unnest(string_to_array(r.operator, ';')) AS o
  WHERE trim(o) <> ''
  GROUP BY m.way_id
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
""")
    print()


OPERATOR = r"""nullif(array_to_string(
    CASE WHEN cardinality(lv.operator) > 0 THEN lv.operator ELSE lo.fallback_operator END,
    U&'\001E'), '')"""

# Operator color as the view computes it (a known brand color, else a hue
# hashed from the primary operator), also for operators filled in above. The
# view hashes name::bytea, which fails on names with a backslash; convert_to
# gives the same bytes for every other name.
OPERATOR_NAME = 'coalesce(lv.primary_operator, lo.fallback_operator[1])'
OPERATOR_COLOR = f"""CASE WHEN {OPERATOR_NAME} IS NOT NULL THEN coalesce(oc.known_color,
    'hsl(' || get_byte(sha256(convert_to({OPERATOR_NAME}, 'UTF8')), 0) || ', 100%, 30%)') END"""


# ── Line colors ─────────────────────────────────────────

# One route color per line, so parallel tracks of a line (local and express,
# up and down) look alike: segments group by name and operator, and a group
# takes the color of its routes by length-weighted majority, each segment
# counting each color once. Picking a segment's color from its own routes let
# whichever route came first win, often a through service of another operator
# (東京地下鉄の直通運転 on JR and Seibu tracks).
#
# Official lines vote the same way, over the track each one follows itself
# (rank 0: not 北総線's routes for 京成成田空港線, which runs on its track).
# That color is only the line's in its info box list: segments keep the color
# of their name, since an official line can hold services of different
# colors (東海道本線 holds 京浜東北線 and 横須賀線 track, and the 山手線
# trains' track east of the loop is officially 東北本線 and 東海道本線).
# A color needs routes along a quarter of the line: 外房線's routes have none,
# and the few metres of 総武緩行線 track at 千葉 must not color it.
def build_line_colors(db):
    print('--- Building line colors ---')
    db.run("""
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

DROP TABLE IF EXISTS line_way_line, line_group_colors;
CREATE TABLE line_group_colors AS
WITH group_ways AS (
  SELECT w.group_id, lv.osm_id, coalesce(lv.way_length, 0) AS way_length
  FROM line_group_ways w
  JOIN railway_line_view lv ON lv.osm_id = w.way_id
  WHERE w.rank = 0 AND lv.state = 'present'
), segment_colors AS (
  SELECT DISTINCT gw.group_id, gw.osm_id, gw.way_length, lower(trim(r.color)) AS color
  FROM group_ways gw
  JOIN route_line rl ON rl.line_id = gw.osm_id
  JOIN routes r ON r.osm_id = rl.route_id
  WHERE nullif(trim(r.color), '') IS NOT NULL
)
SELECT DISTINCT ON (votes.group_id) votes.group_id, color
FROM (
  SELECT group_id, color, sum(way_length) AS weight, count(*) AS segments
  FROM segment_colors
  GROUP BY group_id, color
) votes
JOIN (SELECT group_id, sum(way_length) AS length FROM group_ways GROUP BY group_id) totals
  ON totals.group_id = votes.group_id
WHERE votes.weight >= totals.length / 4
ORDER BY votes.group_id, weight DESC, segments DESC, color;
CREATE UNIQUE INDEX ON line_group_colors (group_id);

-- Each way's official line, the one it follows.
CREATE TABLE line_way_line AS
SELECT w.way_id, g.line_id, g.name AS line_name
FROM line_group_ways w
JOIN line_groups g ON g.group_id = w.group_id
WHERE w.rank = 0;
CREATE UNIQUE INDEX ON line_way_line (way_id);
ANALYZE line_group_colors, line_way_line;
""")
    db.report("SELECT '  ' || count(*) || ' lines colored by their routes' FROM line_colors")
    db.report("SELECT '  ' || count(*) || ' official lines colored by their routes' FROM line_group_colors")
    print()


# A segment's line_relations: its official lines (same layout as relations,
# ids jp-…, colored by their routes), else its line relations.
LINE_RELATIONS = rf"""coalesce(
    (SELECT array_to_string(array_agg(
      g.line_id || U&'\001E' || coalesce(gc.color, '') || U&'\001E' || g.name || U&'\001E'
      ORDER BY w.rank, g.line_id
    ), U&'\001D')
    FROM line_group_ways w
    JOIN line_groups g ON g.group_id = w.group_id
    LEFT JOIN line_group_colors gc ON gc.group_id = w.group_id
    WHERE w.way_id = lv.osm_id),
    {RELATION_LIST}
  )"""

# A segment's own line color: its line's vote, else, for segments the vote
# leaves out (unnamed station tracks and connecting curves, lines whose routes
# have no color), the first color set among its first four routes in
# line_routes order. The style used to work that fallback out from line_routes
# itself; as a data-driven expression it went into every tile MapLibre sends
# from its workers, so it is done here.
OWN_LINE_COLOR = 'coalesce(lc.color, rc.color)'

# Line queries join railway_line_view lv to the fallback operators, the
# operator colors, the way tags, the line colors, the official lines (the
# zoomed-out layer names its sections after them) and the first route color
# (rc, for OWN_LINE_COLOR).
OWN_LINE_JOINS = """LEFT JOIN line_operators lo ON lo.way_id = lv.osm_id
LEFT JOIN (SELECT name AS known_operator, color AS known_color FROM railway_operator) oc
  ON oc.known_operator = coalesce(lv.primary_operator, lo.fallback_operator[1])
LEFT JOIN line_way_tags wt ON wt.way_id = lv.osm_id
LEFT JOIN line_colors lc
  ON lc.line_name = lv.name AND lc.line_operator = coalesce(lv.primary_operator, lo.fallback_operator[1], '')
LEFT JOIN line_way_line ll ON ll.way_id = lv.osm_id
LEFT JOIN LATERAL (
  SELECT first_routes.color
  FROM (
    SELECT route_item -> 'color' AS color, route_item -> 'route_id' AS route_id
    FROM unnest(lv.line_routes) AS route_items(route_item)
    ORDER BY route_item -> 'route_id'
    LIMIT 4
  ) first_routes
  WHERE first_routes.color <> ''
  ORDER BY first_routes.route_id
  LIMIT 1
) rc ON true"""

# Track still without a color takes that of the track it joins which carries
# exactly the same routes, when all such track agrees: a tunnel or bridge
# named after itself (島田トンネル on 中央本線) is outvoted with no line of its
# own, and its routes there may have no color (しなの, JR中央西線), so it came
# out in the usage color between two colored stretches. Same routes keep the
# color from leaking onto branches or track with other services. A few passes
# carry it through a run of such ways, a tunnel in several pieces.
NEIGHBOR_COLOR_PASSES = 4


def build_neighbor_colors(db):
    print('--- Building line colors from joining track ---')
    neighbor_pass = """
UPDATE line_neighbor_ways w SET color = n.color
FROM (
  SELECT u.way_id, min(c.color) AS color
  FROM line_neighbor_ways u
  JOIN line_neighbor_ways c
    ON c.routes = u.routes AND c.way_id <> u.way_id AND c.color IS NOT NULL AND ST_Touches(u.way, c.way)
  WHERE u.color IS NULL
  GROUP BY u.way_id
  HAVING count(DISTINCT c.color) = 1
) n
WHERE w.way_id = n.way_id;
"""
    db.run(f"""
DROP TABLE IF EXISTS line_neighbor_ways, line_neighbor_colors;
CREATE TABLE line_neighbor_ways AS
SELECT DISTINCT ON (lv.osm_id)
  lv.osm_id AS way_id,
  lv.way,
  (SELECT string_agg(route_item -> 'route_id', ',' ORDER BY route_item -> 'route_id')
    FROM unnest(lv.line_routes) AS route_items(route_item)) AS routes,
  {OWN_LINE_COLOR} AS own_color
FROM railway_line_view lv
{OWN_LINE_JOINS}
WHERE lv.state = 'present' AND cardinality(lv.line_routes) > 0
ORDER BY lv.osm_id;
ALTER TABLE line_neighbor_ways ADD COLUMN color text;
UPDATE line_neighbor_ways SET color = own_color;
CREATE INDEX ON line_neighbor_ways USING gist (way);
CREATE INDEX ON line_neighbor_ways (routes);
ANALYZE line_neighbor_ways;
{neighbor_pass * NEIGHBOR_COLOR_PASSES}
CREATE TABLE line_neighbor_colors AS
SELECT way_id, color FROM line_neighbor_ways WHERE own_color IS NULL AND color IS NOT NULL;
CREATE UNIQUE INDEX ON line_neighbor_colors (way_id);
ANALYZE line_neighbor_colors;
DROP TABLE line_neighbor_ways;
""")
    db.report("SELECT '  ' || count(*) || ' segments colored by the track they join' FROM line_neighbor_colors")
    print()


# A segment's line_color, and the joins of the line queries that read it.
LINE_COLOR = 'coalesce(lc.color, rc.color, nc.color)'
LINE_JOINS = f"""{OWN_LINE_JOINS}
LEFT JOIN line_neighbor_colors nc ON nc.way_id = lv.osm_id"""


# ── Station sizes ───────────────────────────────────────

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
CR_NORMAL_TRAINS = 24
CR_LARGE_TRAINS = 120


def build_station_overrides(db, cr_station_trains):
    print('--- Building station overrides ---')
    db.run("""
DROP TABLE IF EXISTS station_overrides, timetable_stations, station_candidates, cr_station_trains;
CREATE TABLE cr_station_trains (osm_type text, osm_id int8, cr_name text, trains_per_day real);
""")
    if cr_station_trains and Path(cr_station_trains).is_file():
        db.copy('cr_station_trains', cr_station_trains, header=True)
    else:
        print(f'  no CR_STATION_TRAINS file ({cr_station_trains or "not set"}); station sizes stay as mapped')
    db.run(f"""
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
    ELSE 9 * power(m.trains / {CR_NORMAL_TRAINS}.0, ln(21 / 9.0) / ln({CR_LARGE_TRAINS}.0 / {CR_NORMAL_TRAINS}))
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
    WHEN c.trains >= {CR_LARGE_TRAINS} THEN 'large'
    WHEN c.trains >= {CR_NORMAL_TRAINS} THEN 'normal'
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
""")
    db.report(
        "SELECT '  ' || count(*) FILTER (WHERE cr_size IS NOT NULL) || ' stations sized by timetable ('"
        " || count(*) FILTER (WHERE cr_size = 'large') || ' large, '"
        " || count(*) FILTER (WHERE cr_size = 'normal') || ' normal), '"
        " || count(*) FILTER (WHERE cr_size IS NULL) || ' others closer to one' FROM station_overrides"
    )


# A station's size, isolation and importance: the timetable's where it has them.
STATION_SIZE = 'coalesce(so.cr_size, s.station_size)'
STATION_DISCR_ISO = 'coalesce(so.cr_discr_iso, s.discr_iso)'
STATION_IMPORTANCE = 'coalesce(so.cr_importance, s.importance)'


# ── Station codes ───────────────────────────────────────

# Yahoo! 乗換案内 station codes for stations in Japan, the ids the timetable
# (src/timetable.ts) asks the API for. A station grouped from several
# OSM features gets the codes of all of them.
# Japanese stations' readings in katakana (station-index.py's): a station
# grouped from several OSM features takes the most common of theirs.
def build_station_readings(db, jp_readings):
    db.run("""
DROP TABLE IF EXISTS station_readings, jp_readings;
CREATE TABLE jp_readings (osm_type text, osm_id int8, yomi text);
""")
    if jp_readings and Path(jp_readings).is_file():
        db.copy('jp_readings', jp_readings, header=True)
    else:
        print(f'  no JP_READINGS file ({jp_readings or "not set"}); stations have no reading')
    db.run("""
CREATE TABLE station_readings AS
SELECT DISTINCT ON (gs.id) gs.id, j.yomi
FROM grouped_stations_with_importance gs
CROSS JOIN LATERAL unnest(gs.osm_ids, gs.osm_types) AS member(osm_id, osm_type)
JOIN jp_readings j ON j.osm_id = member.osm_id AND j.osm_type = member.osm_type
GROUP BY gs.id, j.yomi
ORDER BY gs.id, count(*) DESC, j.yomi;
CREATE UNIQUE INDEX ON station_readings (id);
ANALYZE station_readings;
""")
    db.report("SELECT '  ' || count(*) || ' stations with a reading' FROM station_readings")
    print()


def build_station_yahoo_codes(db, jp_station_codes):
    db.run("""
DROP TABLE IF EXISTS station_yahoo_codes, jp_station_codes;
CREATE TABLE jp_station_codes (osm_type text, osm_id int8, name text, codes text, status text);
""")
    if jp_station_codes and Path(jp_station_codes).is_file():
        db.copy('jp_station_codes', jp_station_codes, header=True)
    else:
        print(f'  no JP_STATION_CODES file ({jp_station_codes or "not set"}); timetables look stations up by name')
    db.run("""
CREATE TABLE station_yahoo_codes AS
SELECT gs.id, string_agg(DISTINCT code, ';' ORDER BY code) AS yahoo_codes
FROM grouped_stations_with_importance gs
CROSS JOIN LATERAL unnest(gs.osm_ids, gs.osm_types) AS member(osm_id, osm_type)
JOIN jp_station_codes j ON j.osm_id = member.osm_id AND j.osm_type = member.osm_type
CROSS JOIN LATERAL unnest(string_to_array(j.codes, ';')) AS code
GROUP BY gs.id;
CREATE UNIQUE INDEX ON station_yahoo_codes (id);
ANALYZE station_yahoo_codes;
""")
    db.report("SELECT '  ' || count(*) || ' stations with Yahoo station codes' FROM station_yahoo_codes")
    print()


# ── Station colors ──────────────────────────────────────

# A station's dot color and kind, which the style draws as a dot in its line's
# color, a ringed white dot where lines of different colors stop, or a plain or
# light gray dot. Worked out here rather than by a style expression: MapLibre
# copies a layer's data-driven expressions into every tile it sends from its
# workers, and the one comparing a station's route colors came to over half a
# million nodes per tile, which the browser's main thread had to unpack. Same
# rules as that expression had: the color is the first set among the station's
# first 16 routes (ordered as in station_routes), and the station is an
# interchange when another of those colors differs from it by more than 48 in a
# channel. Colors parse like MapLibre's to-color (hex and CSS names, anything
# else black).
CSS_COLORS = '{"aliceblue":[240,248,255],"antiquewhite":[250,235,215],"aqua":[0,255,255],"aquamarine":[127,255,212],"azure":[240,255,255],"beige":[245,245,220],"bisque":[255,228,196],"black":[0,0,0],"blanchedalmond":[255,235,205],"blue":[0,0,255],"blueviolet":[138,43,226],"brown":[165,42,42],"burlywood":[222,184,135],"cadetblue":[95,158,160],"chartreuse":[127,255,0],"chocolate":[210,105,30],"coral":[255,127,80],"cornflowerblue":[100,149,237],"cornsilk":[255,248,220],"crimson":[220,20,60],"cyan":[0,255,255],"darkblue":[0,0,139],"darkcyan":[0,139,139],"darkgoldenrod":[184,134,11],"darkgray":[169,169,169],"darkgreen":[0,100,0],"darkgrey":[169,169,169],"darkkhaki":[189,183,107],"darkmagenta":[139,0,139],"darkolivegreen":[85,107,47],"darkorange":[255,140,0],"darkorchid":[153,50,204],"darkred":[139,0,0],"darksalmon":[233,150,122],"darkseagreen":[143,188,143],"darkslateblue":[72,61,139],"darkslategray":[47,79,79],"darkslategrey":[47,79,79],"darkturquoise":[0,206,209],"darkviolet":[148,0,211],"deeppink":[255,20,147],"deepskyblue":[0,191,255],"dimgray":[105,105,105],"dimgrey":[105,105,105],"dodgerblue":[30,144,255],"firebrick":[178,34,34],"floralwhite":[255,250,240],"forestgreen":[34,139,34],"fuchsia":[255,0,255],"gainsboro":[220,220,220],"ghostwhite":[248,248,255],"gold":[255,215,0],"goldenrod":[218,165,32],"gray":[128,128,128],"green":[0,128,0],"greenyellow":[173,255,47],"grey":[128,128,128],"honeydew":[240,255,240],"hotpink":[255,105,180],"indianred":[205,92,92],"indigo":[75,0,130],"ivory":[255,255,240],"khaki":[240,230,140],"lavender":[230,230,250],"lavenderblush":[255,240,245],"lawngreen":[124,252,0],"lemonchiffon":[255,250,205],"lightblue":[173,216,230],"lightcoral":[240,128,128],"lightcyan":[224,255,255],"lightgoldenrodyellow":[250,250,210],"lightgray":[211,211,211],"lightgreen":[144,238,144],"lightgrey":[211,211,211],"lightpink":[255,182,193],"lightsalmon":[255,160,122],"lightseagreen":[32,178,170],"lightskyblue":[135,206,250],"lightslategray":[119,136,153],"lightslategrey":[119,136,153],"lightsteelblue":[176,196,222],"lightyellow":[255,255,224],"lime":[0,255,0],"limegreen":[50,205,50],"linen":[250,240,230],"magenta":[255,0,255],"maroon":[128,0,0],"mediumaquamarine":[102,205,170],"mediumblue":[0,0,205],"mediumorchid":[186,85,211],"mediumpurple":[147,112,219],"mediumseagreen":[60,179,113],"mediumslateblue":[123,104,238],"mediumspringgreen":[0,250,154],"mediumturquoise":[72,209,204],"mediumvioletred":[199,21,133],"midnightblue":[25,25,112],"mintcream":[245,255,250],"mistyrose":[255,228,225],"moccasin":[255,228,181],"navajowhite":[255,222,173],"navy":[0,0,128],"oldlace":[253,245,230],"olive":[128,128,0],"olivedrab":[107,142,35],"orange":[255,165,0],"orangered":[255,69,0],"orchid":[218,112,214],"palegoldenrod":[238,232,170],"palegreen":[152,251,152],"paleturquoise":[175,238,238],"palevioletred":[219,112,147],"papayawhip":[255,239,213],"peachpuff":[255,218,185],"peru":[205,133,63],"pink":[255,192,203],"plum":[221,160,221],"powderblue":[176,224,230],"purple":[128,0,128],"rebeccapurple":[102,51,153],"red":[255,0,0],"rosybrown":[188,143,143],"royalblue":[65,105,225],"saddlebrown":[139,69,19],"salmon":[250,128,114],"sandybrown":[244,164,96],"seagreen":[46,139,87],"seashell":[255,245,238],"sienna":[160,82,45],"silver":[192,192,192],"skyblue":[135,206,235],"slateblue":[106,90,205],"slategray":[112,128,144],"slategrey":[112,128,144],"snow":[255,250,250],"springgreen":[0,255,127],"steelblue":[70,130,180],"tan":[210,180,140],"teal":[0,128,128],"thistle":[216,191,216],"tomato":[255,99,71],"turquoise":[64,224,208],"violet":[238,130,238],"wheat":[245,222,179],"white":[255,255,255],"whitesmoke":[245,245,245],"yellow":[255,255,0],"yellowgreen":[154,205,50]}'  # noqa: E501


def build_station_color_functions(db):
    db.run(r"""
CREATE OR REPLACE FUNCTION orm_color_rgb(color text) RETURNS int[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN c ~ '^#[0-9a-f]{3,4}$' THEN ARRAY[
      ('x' || repeat(substr(c, 2, 1), 2))::bit(8)::int,
      ('x' || repeat(substr(c, 3, 1), 2))::bit(8)::int,
      ('x' || repeat(substr(c, 4, 1), 2))::bit(8)::int]
    WHEN c ~ '^#([0-9a-f]{6}|[0-9a-f]{8})$' THEN ARRAY[
      ('x' || substr(c, 2, 2))::bit(8)::int,
      ('x' || substr(c, 4, 2))::bit(8)::int,
      ('x' || substr(c, 6, 2))::bit(8)::int]
    ELSE (SELECT array_agg(v::int ORDER BY i) FROM jsonb_array_elements_text(
      'CSS_COLORS'::jsonb -> c) WITH ORDINALITY AS e(v, i))
  END
  FROM (SELECT lower(trim(color)) AS c) input
$$;
CREATE OR REPLACE FUNCTION orm_station_colors(routes text, state text)
RETURNS TABLE (station_color text, station_kind text) LANGUAGE sql IMMUTABLE AS $$
  WITH colors AS (
    SELECT n, lower(split_part(route, U&'\001E', 2)) AS color
    FROM unnest(string_to_array(routes, U&'\001D')) WITH ORDINALITY AS r(route, n)
    WHERE n <= 16
  ), first AS (
    SELECT color, coalesce(orm_color_rgb(color), ARRAY[0, 0, 0]) AS rgb FROM colors WHERE color <> '' ORDER BY n LIMIT 1
  )
  SELECT
    (SELECT color FROM first),
    CASE
      WHEN coalesce(state, 'present') <> 'present' THEN 'inactive'
      WHEN NOT EXISTS (SELECT 1 FROM first) THEN 'plain'
      WHEN EXISTS (
        SELECT 1
        FROM colors c
        CROSS JOIN first f
        CROSS JOIN LATERAL (SELECT coalesce(orm_color_rgb(c.color), ARRAY[0, 0, 0]) AS rgb) o
        WHERE c.color <> ''
          AND greatest(abs(o.rgb[1] - f.rgb[1]), abs(o.rgb[2] - f.rgb[2]), abs(o.rgb[3] - f.rgb[3])) > 48
      ) THEN 'interchange'
      ELSE 'line'
    END
$$;
""".replace('CSS_COLORS', CSS_COLORS))


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
STATION_ROUTES = r"""(SELECT nullif(array_to_string(array_agg(
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
  ))"""

# Station label layers read railway_text_stations s through these: the
# timetable's sizes (so), the Yahoo codes (sy), the reading (sk), the station's
# routes, looked up once (sr), and the dot color and kind they give (sc).
STATION_JOINS = f"""LEFT JOIN station_overrides so ON so.id = s.id
LEFT JOIN station_yahoo_codes sy ON sy.id = s.id
LEFT JOIN station_readings sk ON sk.id = s.id
CROSS JOIN LATERAL (SELECT {STATION_ROUTES} AS station_routes) sr
CROSS JOIN LATERAL orm_station_colors(sr.station_routes, s.state) sc"""


def build(db, config):
    """All of the tables above, in the order they read each other."""
    build_line_relations(db, config.line_relations_opl, config.output_dir)
    build_official_lines(db, config.line_groups_dir)
    build_line_operators(db)
    build_line_colors(db)
    build_neighbor_colors(db)
    build_station_overrides(db, config.cr_station_trains)
    build_station_yahoo_codes(db, config.jp_station_codes)
    build_station_readings(db, config.jp_readings)
    build_station_color_functions(db)
