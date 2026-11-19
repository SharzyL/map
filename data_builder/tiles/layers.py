"""The layers of the tile archive: for each, the query export.py writes to FlatGeobuf and the
zooms tippecanoe keeps its features at.

The layer names and attributes are what the style, the railway filter, the route highlight
and the info boxes read, and the zooms mirror those the style draws each layer at, so change
them together. Most zoom ranges come from upstream's Martin configuration.
"""

import math
from dataclasses import dataclass

from tables import (
    LINE_COLOR,
    LINE_JOINS,
    LINE_RELATIONS,
    OPERATOR,
    OPERATOR_COLOR,
    STATION_DISCR_ISO,
    STATION_IMPORTANCE,
    STATION_JOINS,
    STATION_SIZE,
)


@dataclass
class Layer:
    name: str  # of the FlatGeobuf file, and of the layer in the tiles unless tile_layer says otherwise
    sql: str
    filter: list  # tippecanoe's feature filter; None leaves the layer out of the archive
    tile_layer: str = None


# ── SQL ─────────────────────────────────────────────────

# FlatGeobuf holds no lists, so lists become text: items apart by U+001D,
# the fields of an item by U+001E, which is what the app splits them on.
def joined(column, name=None):
    """An array column as one text."""
    return rf"nullif(array_to_string({column}, U&'\001E'), '') AS {name or column.split('.')[-1]}"


def route_list(column, name):
    """A column of routes as JSON items, as id, color and label of each, by id."""
    return rf"""(SELECT nullif(array_to_string(array_agg(
    (route_item -> 'route_id') || U&'\001E' ||
    coalesce(route_item -> 'color', '') || U&'\001E' ||
    coalesce(route_item -> 'label', '')
    ORDER BY route_item -> 'route_id'
  ), U&'\001D'), '') FROM unnest({column}) AS route_items(route_item)) AS {name}"""


def columns(*items):
    return ',\n  '.join(items)


INFO_COLUMNS = (
    'wikidata',
    'wikimedia_commons',
    'wikimedia_commons_file',
    'image',
    'mapillary',
    'wikipedia',
    'note',
    'description',
)

# The columns of railway_text_stations s every station layer carries.
STATION_COLUMNS = (
    joined('s.osm_id'),
    joined('s.osm_type'),
    'feature',
    'state',
    'station',
    'map_reference AS label',
    'name',
    'name AS localized_name',
    r"""(SELECT nullif(array_to_string(array_agg(e.k || U&'\001E' || e.v ORDER BY e.k), U&'\001D'), '')
    FROM each(s."references") AS e(k, v)) AS references""",
    joined('operator'),
    joined('network'),
    joined('position'),
    *(joined(column) for column in INFO_COLUMNS),
    joined('yard_purpose'),
    'yard_hump',
)

# And those of the station label layers, which draw a dot for each station
# (tables.py: STATION_JOINS).
STATION_LABEL_COLUMNS = (
    f'{STATION_SIZE} AS station_size',
    'sr.station_routes',
    'sc.station_color',
    'sc.station_kind',
    'sy.yahoo_codes',
    f'{STATION_DISCR_ISO} AS discr_iso',
)

# The zoomed-out station layers: mainline stations only, at these zooms.
LOW_STATION_ZOOMS = (4, 5, 6, 7)
MEDIUM_STATION_ZOOMS = (7, 8)
MAINLINE_STATIONS = """feature = 'station' AND state = 'present'
  AND (station IS NULL OR station NOT IN ('light_rail', 'monorail', 'subway'))"""

SIGNAL_COLUMNS = columns(
    'id',
    'way',
    'osm_id',
    'osm_type',
    'rank',
    'railway',
    'direction_both',
    'ref',
    'caption',
    joined('position'),
    'azimuth',
    'type',
    *(f'feature{i}' for i in range(6)),
    *(f'deactivated{i}' for i in range(6)),
    *(f'offset{i}' for i in range(6)),
)

# POIs of the standard style, drawn from their own minzoom.
STANDARD_SYMBOLS = (
    'aei', 'buffer_stop', 'car-dumper', 'car-shuttle', 'carrier-truck-pit', 'coaling_facility',
    'compressed_air_supply', 'container-terminal', 'crossing', 'defect_detector', 'derail', 'engine_shed',
    'ferry-terminal', 'fuel', 'gauge-conversion', 'hirail_access', 'hump_yard', 'level-crossing',
    'level-crossing-barrier', 'level-crossing-light', 'level-crossing-light-barrier', 'loading-rack',
    'loading-ramp', 'loading-tower', 'loading_gauge', 'lubricator', 'museum', 'museum-rail-transport', 'phone',
    'pit', 'preheating', 'radio-antenna', 'radio-mast', 'retarder', 'rolling_highway', 'sand_store',
    'track-scale', 'unloading-hole', 'wash', 'waste_disposal', 'water_crane', 'water_tower', 'workshop',
)


# ── Zooms ───────────────────────────────────────────────

# tippecanoe's -L takes no zoom range, so each layer's zooms are a feature
# filter (-j) testing $zoom, plus whatever attribute rules Martin applies per
# zoom. Caveat: tippecanoe's ["==", attr, true] matches every feature, so
# boolean tests must be written as ["!=", attr, false].
def between(minzoom, maxzoom):
    return ['all', ['>=', '$zoom', minzoom], ['<=', '$zoom', maxzoom]]


# A station shows at zoom z only when it is this far (discr_iso) from a more
# important one: Martin's threshold, which loosens as z grows. A layer for
# several zooms is exported with the threshold of its last, and tippecanoe
# tightens it for each zoom.
def station_threshold_sql(z):
    return f'213000 * exp(-0.33 * {z}) - 18000'


def station_threshold(z):
    return round(213000 * math.exp(-0.33 * z) - 18000, 3)


class Zooms:
    """Filters for an archive from zoom 0 to max_zoom; None for a layer it holds no zoom of."""

    def __init__(self, max_zoom):
        self.max = max_zoom

    def range(self, minzoom, maxzoom=None):
        """Every feature from minzoom to maxzoom, or to the archive's last zoom."""
        maxzoom = self.max if maxzoom is None else min(maxzoom, self.max)
        return between(minzoom, maxzoom) if minzoom <= maxzoom else None

    def overzoomed(self, minzoom):
        """Every feature from minzoom, and in the archive's last zoom even past it, for clients to overzoom."""
        return self.range(min(minzoom, self.max))

    def feature_minzoom(self, minzoom):
        """From minzoom, a feature at zoom z only if its minzoom attribute is at most z, and every
        feature at the archive's last zoom, since clients overzoom it."""
        minzoom = min(minzoom, self.max)
        at = [['all', ['==', '$zoom', z], ['<=', 'minzoom', z]] for z in range(minzoom, self.max)]
        return ['all', ['>=', '$zoom', minzoom], ['any', ['>=', '$zoom', self.max], *at]]

    def stations(self, zooms):
        """At each of zooms, the stations past its isolation threshold."""
        at = [['all', ['==', '$zoom', z], ['>', 'discr_iso', station_threshold(z)]] for z in zooms if z <= self.max]
        return ['any', *at] if at else None

    def railway_line_high(self):
        """Each segment only from the zoom the standard style first draws its kind at
        (public/orm/style/standard.json; the style's filters only test feature, usage and
        state). Below that zoom it is invisible, yet at z7-9 it made up roughly half of each
        tile. Segments on a route are kept from z7 because the route highlight draws routes
        from z7 tiles and traces them below z7. Keep these categories in step with the style."""
        active = ['in', 'state', 'present', 'construction', 'proposed']
        # z7-8: main and branch lines, ferries.
        from7 = [
            'all',
            active,
            ['any', ['all', ['==', 'feature', 'rail'], ['in', 'usage', 'main', 'branch']], ['==', 'feature', 'ferry']],
        ]
        # z9: urban transit, test and military, tourism or preserved, industrial.
        from9 = [
            'any',
            ['all', active, ['in', 'feature', 'subway', 'tram', 'light_rail', 'monorail']],
            ['all', active, ['==', 'feature', 'rail'], ['in', 'usage', 'test', 'military']],
            [
                'all',
                ['in', 'state', 'present', 'construction', 'proposed', 'preserved'],
                ['any', ['==', 'usage', 'tourism'], ['==', 'state', 'preserved']],
            ],
            ['all', active, ['==', 'usage', 'industrial'], ['in', 'feature', 'rail', 'narrow_gauge']],
        ]
        # z10: narrow gauge, and rail without a usage (service tracks).
        from10 = [
            'any',
            [
                'all',
                active,
                ['==', 'feature', 'narrow_gauge'],
                ['any', ['!has', 'usage'], ['!=', 'usage', 'industrial']],
            ],
            ['all', active, ['==', 'feature', 'rail'], ['!has', 'usage']],
        ]
        # z11: disused. Everything else (abandoned, razed, miniature, funicular,
        # kinds the style does not draw) from z12.
        from11 = ['==', 'state', 'disused']

        def since(z):
            return ['>=', '$zoom', min(z, self.max)]

        return [
            'all',
            between(7, self.max),
            [
                'any',
                since(12),
                ['has', 'line_routes'],
                ['all', since(11), from11],
                ['all', since(10), from10],
                ['all', since(9), from9],
                from7,
            ],
        ]


# ── Layers ──────────────────────────────────────────────


def layers(max_zoom, all_styles=False):
    """The standard style's layers, and with all_styles those of upstream's other styles."""
    zooms = Zooms(max_zoom)
    standard = [
        # railway_line_high (z7+). Only attributes something reads are kept:
        # the style, the client-side railway filter, the route highlight or
        # the popup. Left out as unused or redundant: id (osm_id plus a
        # segment suffix; hover uses tippecanoe's generated ids), rank (only
        # orders features here), osm_type (always W for lines), gauge0-2
        # (text copies of gaugeint0-2 and gauges) and route_count (the length
        # of line_routes). way_length only gates tunnel and bridge decorations
        # while zoomed out, so other segments go without it and it is rounded
        # to metres; as a unique decimal per segment it was the largest
        # attribute.
        Layer(
            'railway_line_high',
            f"""
SELECT
  {columns(
    'way',
    'CASE WHEN tunnel OR bridge THEN round(way_length) END AS way_length',
    'feature',
    'state',
    'usage',
    'service',
    'highspeed',
    'tunnel',
    'bridge',
    'name',
    'ref',
    'track_ref',
    'preferred_direction',
    'osm_id',
    'track_class',
    joined('reporting_marks'),
    'maxspeed',
    'speed_label',
    'train_protection_rank',
    *(f'train_protection[{i + 1}] AS train_protection{i}' for i in range(3)),
    'train_protection_construction_rank',
    'train_protection_construction',
    'electrification_state',
    'voltage',
    'frequency',
    'maximum_current',
    'future_voltage',
    'future_frequency',
    'future_maximum_current',
    'gaugeint0',
    'gaugeint1',
    'gaugeint2',
    "array_to_string(gauges, ', ') AS gauges",
    'loading_gauge',
    f'{OPERATOR} AS operator',
    f'{OPERATOR_COLOR} AS operator_color',
    f'{LINE_COLOR} AS line_color',
    'primary_operator',
    'owner',
    'CASE WHEN lv.preserved THEN true END AS preserved',
    'rack',
    "CASE WHEN wt.tracks ~ '^[0-9]+$' THEN wt.tracks::int END AS tracks",
    'wt.start_date',
    'wt.opening_date',
    'traffic_mode',
    'radio',
    route_list('lv.line_routes', 'line_routes'),
    f'{LINE_RELATIONS} AS line_relations',
    *INFO_COLUMNS,
  )}
FROM railway_line_view lv
{LINE_JOINS}
ORDER BY
  layer,
  rank NULLS LAST,
  maxspeed NULLS FIRST
""",
            zooms.railway_line_high(),
        ),
        # Kilometre markers: zero markers at z10-12, all of them from z13.
        Layer(
            'railway_text_km',
            f"""
SELECT
  {columns(
    'osm_id',
    'way',
    'railway',
    'position_text AS pos',
    'position_exact AS pos_exact',
    'zero',
    'round(position_numeric) AS pos_int',
    'type',
    *INFO_COLUMNS,
  )}
FROM railway_positions
ORDER BY zero
""",
            ['any', ['>=', '$zoom', 13], ['all', ['>=', '$zoom', 10], ['!=', 'zero', False]]],
        ),
        # Main lines for the zoomed-out map (z0-7). Only the attributes the
        # low-zoom style and the client-side railway filter read; everything
        # else (routes, links, ids, signalling...) lives in railway_line_high
        # from z7. Tunnel and bridge flags are left out too: their decorations
        # are invisible at these zooms, the main line layers draw lines
        # without the flags as ordinary track, and they split lines more than
        # anything else (way_length only gated those decorations, so it goes
        # as well). Without per-segment values, adjacent segments with
        # identical attributes are merged: ST_LineMerge joins them and ST_Dump
        # splits the result into plain LineStrings (MULTILINESTRINGs crashed
        # tippecanoe). This turns ~1.2M short segments into ~200k line
        # sections, shrinking a z2 tile several times over. Sections are
        # named after Japan's official lines where they have one.
        Layer(
            'standard_railway_line_low',
            f"""
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
    coalesce(ll.line_name, lv.name) AS name,
    maxspeed,
    electrification_state,
    voltage,
    frequency,
    gaugeint0,
    gaugeint1,
    traffic_mode,
    {OPERATOR} AS operator,
    {OPERATOR_COLOR} AS operator_color,
    {LINE_COLOR} AS line_color,
    max(rank) AS rank,
    (ST_Dump(ST_LineMerge(ST_Collect(way)))).geom AS way
  FROM railway_line_view lv
  {LINE_JOINS}
  WHERE state = 'present'
    AND feature IN ('rail', 'ferry')
    AND usage = 'main'
    AND service IS NULL
  GROUP BY
    feature, state, usage, highspeed, coalesce(ll.line_name, lv.name), maxspeed, electrification_state, voltage,
    frequency, gaugeint0, gaugeint1, traffic_mode, {OPERATOR}, {OPERATOR_COLOR}, {LINE_COLOR}
) merged
ORDER BY rank NULLS LAST
""",
            zooms.range(0, 7),
        ),
        # Station labels from z8. Point and station layers leave out the
        # view's synthetic id column: nothing in the style or the app reads it
        # (hover state uses tippecanoe's generated ids, info boxes link to
        # OpenStreetMap through osm_id).
        Layer(
            'standard_railway_text_stations',
            f"""
SELECT
  center AS way,
  {columns(*STATION_COLUMNS, 'count', *STATION_LABEL_COLUMNS)}
FROM railway_text_stations s
{STATION_JOINS}
WHERE name IS NOT NULL
ORDER BY
  rank DESC NULLS LAST,
  {STATION_IMPORTANCE} DESC NULLS LAST
""",
            zooms.range(8),
        ),
        # z4-7: large and normal mainline stations.
        Layer(
            'standard_railway_text_stations_low',
            f"""
SELECT
  center AS way,
  {columns(*STATION_COLUMNS, *STATION_LABEL_COLUMNS)}
FROM railway_text_stations s
{STATION_JOINS}
WHERE {MAINLINE_STATIONS}
  AND {station_threshold_sql(LOW_STATION_ZOOMS[-1])} < {STATION_DISCR_ISO}
  AND {STATION_SIZE} IN ('large', 'normal')
ORDER BY {STATION_IMPORTANCE} DESC NULLS LAST
""",
            zooms.stations(LOW_STATION_ZOOMS),
        ),
        # z7-8: all mainline stations.
        Layer(
            'standard_railway_text_stations_med',
            f"""
SELECT
  center AS way,
  {columns(*STATION_COLUMNS, *STATION_LABEL_COLUMNS)}
FROM railway_text_stations s
{STATION_JOINS}
WHERE {MAINLINE_STATIONS}
  AND {station_threshold_sql(MEDIUM_STATION_ZOOMS[-1])} < {STATION_DISCR_ISO}
ORDER BY {STATION_IMPORTANCE} DESC NULLS LAST
""",
            zooms.stations(MEDIUM_STATION_ZOOMS),
        ),
        Layer(
            'standard_railway_turntables',
            """
SELECT osm_id, osm_type, way, replace(feature, 'general/', '') AS feature FROM pois
WHERE feature IN ('general/turntable', 'general/traverser')
  AND ST_GeometryType(way) IN ('ST_Polygon', 'ST_MultiPolygon')
""",
            zooms.range(10),
        ),
        Layer(
            'standard_station_entrances',
            f"""
SELECT
  {columns('osm_id', 'osm_type', 'way', 'type', 'name', 'ref', 'label', *INFO_COLUMNS)}
FROM standard_station_entrances_view
""",
            zooms.overzoomed(16),
        ),
        # All symbols the archive needs, each from its own minzoom. An archive
        # ending below z17 still takes the highest-detail ones, since the demo
        # style caps those layers down to the archive's last zoom.
        Layer(
            'standard_railway_symbols',
            f"""
SELECT
  {columns('osm_id', 'osm_type', 'center AS way', 'feature', 'ref', 'name', 'minzoom', joined('position'), *INFO_COLUMNS)}
FROM pois
WHERE feature IN ({', '.join(f"'general/{symbol}'" for symbol in STANDARD_SYMBOLS)})
  AND minzoom <= {max(max_zoom, 17)}
ORDER BY rank DESC
""",
            zooms.feature_minzoom(12),
        ),
        Layer(
            'standard_railway_platforms',
            f"""
SELECT
  {columns(
    'osm_id',
    'osm_type',
    'way',
    'feature',
    'name',
    joined('ref'),
    'height',
    'surface',
    'elevator',
    'shelter',
    'lit',
    'bin',
    'bench',
    'wheelchair',
    'departures_board',
    'tactile_paving',
    route_list('p.platform_routes', 'platform_routes'),
  )}
FROM standard_railway_platforms_view p
""",
            zooms.range(15),
        ),
        Layer(
            'standard_railway_platform_edges',
            """
SELECT
  osm_id, osm_type, way, feature, ref, height, tactile_paving
FROM standard_railway_platform_edges_view
""",
            zooms.overzoomed(17),
        ),
        Layer(
            'standard_railway_stop_positions',
            f"""
SELECT
  {columns(
    'osm_id',
    'osm_type',
    'way',
    'name',
    'type',
    'ref',
    'local_ref',
    route_list('sp.stop_position_routes', 'stop_position_routes'),
  )}
FROM standard_railway_stop_positions_view sp
""",
            zooms.overzoomed(16),
        ),
        Layer(
            'standard_railway_switch_ref',
            f"""
SELECT
  {columns(
    'osm_id',
    'osm_type',
    'way',
    'railway',
    'ref',
    'type',
    'turnout_side',
    'local_operated',
    'resetting',
    joined('position'),
    *INFO_COLUMNS,
  )}
FROM standard_railway_switch_view
ORDER BY char_length(ref)
""",
            zooms.overzoomed(17),
        ),
        # Clustered station areas (z13+), without station_routes: the station
        # label layer carries the same lists, and that is where info boxes and
        # the route highlight read them.
        Layer(
            'standard_railway_grouped_stations',
            f"""
SELECT
  buffered AS way,
  {columns(*STATION_COLUMNS)}
FROM railway_text_stations s
""",
            zooms.range(13),
        ),
        # Station area outlines group several stops (an interchange). Flag
        # which kinds of station they contain so clients can hide urban-only
        # interchanges together with urban transit stations (same member path
        # as stop_area_groups_buffered).
        Layer(
            'standard_railway_grouped_station_areas',
            """
SELECT
  v.osm_id,
  v.osm_type,
  v.feature,
  v.way,
  coalesce(k.has_urban_station, false) AS has_urban_station,
  coalesce(k.has_rail_station, true) AS has_rail_station
FROM standard_railway_grouped_station_areas_view v
LEFT JOIN (
  SELECT
    sag.osm_id,
    bool_or(s.station IN ('subway', 'light_rail', 'monorail', 'funicular', 'tram')) AS has_urban_station,
    bool_or(s.station IS NULL OR s.station NOT IN ('subway', 'light_rail', 'monorail', 'funicular', 'tram'))
      AS has_rail_station
  FROM stop_area_groups sag
  JOIN stop_areas sa ON sa.osm_id = ANY(sag.stop_area_ref_ids)
  JOIN stations_stop_areas ssa ON ssa.stop_area_osm_id = sa.osm_id
  JOIN stations s ON ssa.station_id = s.id
  GROUP BY sag.osm_id
) k ON k.osm_id = v.osm_id
""",
            zooms.range(13),
        ),
    ]
    if not all_styles:
        return standard

    # Signal boxes: points (zoom_part 0) at z8-13, full geometry (zoom_part 1)
    # at z14, in one layer.
    signal_boxes = [
        'any',
        ['all', ['==', 'zoom_part', 0], between(8, 13)],
        ['all', ['==', 'zoom_part', 1], between(14, 14)],
    ]
    return standard + [
        # Speed
        Layer(
            'speed_railway_line_low',
            """
SELECT
  id, osm_id, way, feature, state, usage,
  maxspeed, ref, speed_label, rank
FROM railway_line_low
""",
            zooms.range(0, 7),
        ),
        Layer('speed_railway_signals', f'SELECT\n  {SIGNAL_COLUMNS}\nFROM speed_railway_signals_view', zooms.range(13)),
        # Signals
        Layer(
            'signals_railway_line_low',
            f"""
SELECT
  {columns(
    'id',
    'osm_id',
    'way',
    'feature',
    'state',
    'usage',
    'ref',
    'train_protection_rank',
    *(f'train_protection[{i + 1}] AS train_protection{i}' for i in range(3)),
    'train_protection_construction_rank',
    'train_protection_construction',
    'rank',
  )}
FROM railway_line_low
""",
            zooms.range(0, 7),
        ),
        Layer(
            'signals_signal_boxes_low',
            """
SELECT
  id, 0 AS zoom_part, center AS way, feature, ref, name, operator_color, operator_bright
FROM signal_boxes_view
""",
            signal_boxes,
            'signals_signal_boxes',
        ),
        Layer(
            'signals_signal_boxes_high',
            """
SELECT
  id, 1 AS zoom_part, way, feature, ref, name, operator_color, operator_bright
FROM signal_boxes_view
""",
            signal_boxes,
            'signals_signal_boxes',
        ),
        # Upstream stores multi-signal arrays; the *_signals_view expands them
        # into feature0-5 / deactivated0-5 / offset0-5 columns (FlatGeobuf
        # cannot hold StringList), matching what the style renders.
        Layer(
            'signals_railway_signals',
            f'SELECT\n  {SIGNAL_COLUMNS}\nFROM signals_railway_signals_view',
            zooms.range(13),
        ),
        # Electrification
        Layer(
            'electrification_railway_line_low',
            """
SELECT
  id, osm_id, way, feature, state, usage, ref,
  electrification_state, voltage, frequency, maximum_current,
  rank
FROM railway_line_low
""",
            zooms.range(0, 7),
        ),
        Layer(
            'electrification_signals',
            f'SELECT\n  {SIGNAL_COLUMNS}\nFROM electrification_signals_view',
            zooms.range(13),
        ),
        Layer(
            'electrification_railway_symbols',
            """
SELECT
  id, way, feature, ref, minzoom
FROM poi_view
WHERE layer = 'electrification' AND minzoom <= 17
ORDER BY rank DESC
""",
            zooms.feature_minzoom(13),
        ),
        Layer(
            'electrification_catenary',
            'SELECT id, way, feature, ref, transition FROM electrification_catenary_view',
            zooms.range(14),
        ),
        Layer(
            'electrification_substation',
            'SELECT id, way, name FROM electrification_substation_view',
            zooms.range(13),
        ),
        # Track: from railway_line_view, since railway_line_low lacks the
        # gauges array the style labels gauges with.
        Layer(
            'track_railway_line_low',
            """
SELECT
  id, osm_id, way, feature, state, usage, ref,
  gaugeint0, gauge0,
  array_to_string(gauges, ', ') AS gauges,
  track_class, loading_gauge, rank
FROM railway_line_view
WHERE state = 'present'
  AND feature IN ('rail', 'ferry')
  AND usage = 'main'
  AND service IS NULL
""",
            zooms.range(0, 7),
        ),
        # Operator
        Layer(
            'operator_railway_line_low',
            f"""
SELECT
  id, osm_id, way, feature, state, usage, ref,
  {joined('operator')},
  operator_color, operator_bright, primary_operator, owner, rank
FROM railway_line_low
""",
            zooms.range(0, 7),
        ),
        Layer(
            'operator_railway_symbols',
            """
SELECT
  id, way, feature, ref, minzoom
FROM poi_view
WHERE layer = 'operator' AND minzoom <= 17
ORDER BY rank DESC
""",
            zooms.feature_minzoom(13),
        ),
        # Route
        Layer(
            'route_railway_line_low',
            """
SELECT
  id, osm_id, way, feature, state, usage, highspeed,
  (SELECT count(*) FROM route_line rl JOIN routes r ON rl.route_id = r.osm_id WHERE rl.line_id = l.osm_id)
    AS route_count,
  name, ref, rank
FROM railway_line_low l
""",
            zooms.range(0, 7),
        ),
    ]
