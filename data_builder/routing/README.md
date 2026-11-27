# Train routes

The routes of timetable trains on OSM track, in the shape the API answers
(the train route endpoints in [`src/worker/api/doc.md`](../../src/worker/api/doc.md)):
the railway ways a route covers whole, the parts it covers partly as
geometry, an overview, where it passes each stop, and its legs. They are
built here, on the railway extract, and imported into the Worker's D1
database (`cr`), from which the Worker serves
`/api/v1/cr/trains/{train}/route` and the Yahoo trains' `…/route`.

## Files

| File                                                          | What it does                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph.py`                                                    | Loads the extract into a routing graph: track ways, junctions, and where each OSM station attaches to the track (stop positions in its stop area, tracks by its platforms, route stops, and the nearest high-speed, conventional and metro track) |
| `route.py`                                                    | A\* between attach points on (vertex, direction): no turn sharper than 90° between stops; weighted by track class, hinted ways and, off them, a high-speed preference; sharp turns only at a cost where OSM does not connect the track through    |
| `cr_stations.py`                                              | Every lltskb station matched to OSM, from the extract's stations, as `../stations/cr-station-trains.py` matches them; that file keeps only the stops, routing needs the stations trains pass too                                                  |
| `cr_lines.py`                                                 | Matches lltskb's lines to OSM line relations (name, sections, track within 1 km of the line's stations); `cr-line-relations.csv` overrides                                                                                                        |
| `cr_route.py`                                                 | China Railway routes per run, in the API's format, checked against lltskb's km; lists suspected OSM gaps in `out/cr-osm-issues.csv`                                                                                                               |
| `jp-rules.csv`                                                | Trains no OSM service route covers (サンライズ, 特急鎌倉): the lines and ends of their routes                                                                                                                                                     |
| `jp_store.py`                                                 | Japan's OSM service routes cut into stop-to-stop hops, the D1 shape, on SQLite; routes are kept to them by type, name and `jp-rules.csv`                                                                                                          |
| `jp_assemble.py`, `geo.py`                                    | A Yahoo train's route from the stored hops, by queries it yields: run on SQLite here; the Worker runs its port to TypeScript (`src/worker/api/jp-assemble.ts`) on D1                                                                              |
| `export_d1.py`                                                | SQL loading the China routes and the Japanese tables into D1 as a new version, and dropping old versions                                                                                                                                          |
| `cr_poc.py`                                                   | The first China attempt (line chains vs direct, per stop), kept for comparison                                                                                                                                                                    |
| `test_routing.py`, `test_jp_assemble.py`, `test_export_d1.py` | Tests on a small synthetic network, a tiny store of hops, and the SQL                                                                                                                                                                             |

## Running

The data build (`../steps.toml`) runs these steps. By hand, from this directory,
with the railway extract of the box around China and Japan (`../osm-railways/filter-planet.sh`, here `lines.osm.pbf`), the timetable
unpacked and exported (`../cr-timetable`: `an/`, `csv/`) and the station files
(`../stations`: `cr-station-trains.csv`, `jp-station-codes.csv`):

```bash
nix-shell shell.nix          # osmium, pyosmium, numpy, scipy, shapely

# China and Japan, with what lies in between (the cut relations.sh takes too)
ts=$(osmium fileinfo -g header.option.osmosis_replication_timestamp lines.osm.pbf)
osmium extract -b 73,17,146,54 -s smart lines.osm.pbf -o out/cnjp.osm.pbf

python3 graph.py out/cnjp.osm.pbf out/graph.pkl
python3 cr_stations.py out/graph.pkl csv cr-station-trains.csv out/cr-stations.csv
python3 cr_lines.py out/graph.pkl csv out/cr-stations.csv out/cr-lines.json
python3 cr_route.py out/graph.pkl csv out/cr-stations.csv out/cr-lines.json out \
    --routes out/cr-routes.jsonl.gz  # --jobs N
python3 jp_store.py build out/graph.pkl jp-station-codes.csv out/paths.sqlite
python3 -m unittest discover -s . -p 'test_*.py'

# Into D1: the timetable version the routes are for, the extract's time
ver=$(cat an/ver.txt)
python3 export_d1.py cr out/cr-routes.jsonl.gz out/cr-station-positions.csv "$ver" "$ts" out/cr-routes.sql
python3 export_d1.py jp out/paths.sqlite "$ts" out/jp.sql
d1() { npx --yes wrangler@4 d1 execute cr --remote --config ../../wrangler.toml "$@"; }
d1 --file=out/cr-routes.sql && d1 --file=out/jp.sql
d1 --json --command "$(python3 export_d1.py --list-old)" > out/tables.json
drop=$(python3 export_d1.py --drop-old "$ver" "$ts" < out/tables.json)
[ -n "$drop" ] && d1 --command "$drop"
```

China routes are per run of a timetable version: build them from the
timetable the Worker serves. Until the next build, runs of a newer
timetable that are new get 404 for their route; the others keep the route
of the version it was built for.

`cr_route.py` routes in 8 processes by default (`--jobs`), forked after the
graph is loaded so they share it; runs on the same lines go to the same
process, whose searches serve them all. Besides the issue lists it writes
`out/cr-stretches.csv`, every stretch with its routed and lltskb km and how
it was routed, to compare one version's routes with another's.

`out/` is not committed.

## How a route is found

**Everywhere**

- Stations attach to the track where trains serving them stop: the stop
  positions of their stop area, the tracks by their platforms, the stops of
  routes, and the nearest track of each kind (high-speed, conventional,
  metro) within 400 m, or 1 km for mainline. Each kind on its own: a metro
  beside 许昌东 or the conventional 京广线 at 广州北 must not hide the
  high-speed line.
- No turn sharper than 90° between stops; reversing costs extra at a stop
  and more at a station passed. Where no path avoids a sharp turn, or the
  one that does goes far round, sharp turns are allowed at 3 km each: OSM
  does not always connect the track through, or joins it at an odd angle.
- A path more than 3× the straight distance is not plausible, unless the
  timetable says the train goes that far (G5063 loops 51 km from 南昌 round
  to 南昌西, 12 km away).
- High-speed track is preferred or avoided only off the hinted ways: the
  lines a train is hinted to are what it runs on, high-speed or not. Every
  train from 昆明 to 广通北 takes 广昆线, which OSM tags highspeed=yes,
  though lltskb's line names do not say so.

**China Railway** (`cr_lines.py`, `cr_route.py`)

- Legs are lltskb's path (12\_车次路径.csv), per run: a named line from the
  station where the train joins it. A stop the path misses is put in where
  it adds the least distance: Z21 stops at 太原, the path passes 太原南;
  K1229's last leg, 通让线, ends at 大庆西, and the train goes on to 齐齐哈尔.
- Stations are lltskb's, every one of them, not only the stops: matched to
  OSM by name as for the export, from the extract's stations
  (`cr_stations.py`). The stations a train passes tell which way it runs.
- Each lltskb line keeps to the OSM line relations matched to it: same name
  (or one name containing the other: 京哈沈哈段 ~ 京哈高速线), the relation's
  own track and its sections' (沪昆线, 杭昌高速线), passing within 1 km of
  most of the line's stations; else relations passing 80% of its stations,
  of the same kind if they can (津霸线 runs through 天津 on 津山线 and 京沪线,
  not 京津城际线 beside them). Matched lines carry 99.4% of train-km.
- **By line.** The route is cut where it changes line at a stop; a junction
  OSM does not have (杜家坎所) joins the legs on either side. Where it
  changes line without stopping, lltskb's station is left out: it is the
  junction of the fare path, which the train need not pass. G2711 leaves
  京港赣深段 for 莞塘深线 before 东莞南; 石德线 and 京广线 trains reach 石太线
  by 石家庄直通线 and 石家庄北, 6.5 km from 石家庄. Each span is one search
  along its lines' track (off it costs 50×), through only the stops the
  lines do not pass. The line's stations in between are no
  boundaries, so the route cannot end a hop on a track that does not lead
  on; stops are placed on the route afterwards. A span continues where the
  last one ended, or starts afresh from any of its first station's attach
  points where that track does not lead on, or where starting afresh is
  more than 5 km shorter: the last span may end on a platform track that
  reaches the next line only by turning back. G7357 reaches 上海虹桥 from
  虹封线 on a track that runs on south but not onto 沪昆高速; continuing
  from it turned back past 封浜 and added 40 km, within a 506 km span's
  tolerance.
- Each span is checked against lltskb's km (the lines' km, else the
  train's own between its stops) and the lines' stations. A route missing
  most of a leg's stations, at least two, by more than 2 km runs on another
  line: from 昆明 to 广通北, 成昆线's old line matches lltskb's 153 km (fare
  km), but misses 双湄村 and 禄丰南 on 广昆线, the line lltskb names; the
  train takes 广昆线, 113 km. One station off the route is no sign (襄渝线
  lists 白河县 on the old line, 3.7 km from 白河东 on the new). More than 10%
  off the km, or on another line, a span is also routed through the
  stations it missed, all the train's stops, hop by hop through the lines'
  stations, directly, and without the lines; the closest to the km wins, a
  route missing a stop by more than 1 km, running on another line, turning
  sharply, or turning back where the train does not stop ranks lower. A
  line's stations in lltskb follow its fare path, not always its track:
  滠武线 lists 滠口 between 武汉 and 丹水池, while trains for 汉口 take the link
  to 丹水池; routed through 滠口, they ran past it and back, 33.9 km against
  lltskb's 31, closer than the 27.3 km along the link. More than 50% longer
  than lltskb's km, a span is drawn straight rather than as a detour round
  a gap; far shorter, it is kept, as lltskb's km are fare km, which may go
  round (6259's path runs out to 富拉尔基 and back to 昂昂溪). Train ferries
  (粤海轮渡) are drawn straight.

**Japan** (`jp_store.py`)

- Every OSM service route (route=train, subway, …) is cut into hops between
  consecutive stops, each routed once along the route, continuing from
  where the previous hop ended. A route stop belongs to the stations of its
  stop area, else to the nearest station. Routes listing stops out of
  order, as a whole (JR東海道本線) or locally (two stops swapped), are put
  back in order along the track; loops get a closing hop.
- A train's leg takes the route stopping at both ends that scores best: 新幹線
  or not by the share of high-speed track on the hops it would use (かもめ is
  mapped over both the リレー and the 西九州新幹線), the train's name or line in
  the route's name, the route's direction, the previous leg's route; then
  the shorter. A leg twice the straight distance falls to the next route. A
  conventional train never takes a route over a kilometre or more of
  新幹線 track: only こだま stops at both 姫路 and 岡山, and サンライズ runs on
  山陽本線.
- Trains no OSM route covers are routed by rule (`jp-rules.csv` rows with
  `from` and `to`): サンライズ runs through 名古屋 and 大阪 without stopping
  and on 伯備線 past where its local route ends, 特急鎌倉 takes the 武蔵野南線
  freight line, OSM's やくも links only two of its stops. Each is routed once
  along its lines, both ways, and stored as a route stopping at every
  station on the way; a train matching the rule takes it before any other.
  A rule may list where the train changes tracks (`via`) and lines for each
  section (`prefer`, split by `;`): from 千葉, 富士回遊 and あずさ run on the
  総武快速線 to 錦糸町, on the 緩行線 to 御茶ノ水, then on 中央線快速.

## Results (extract of 2026-11-12 16:00 UTC, lltskb 20261114)

**China**, all 15,131 runs, 56,102 legs, in 4 minutes on 8 processes:

|                                              |       |
| -------------------------------------------- | ----- |
| Leg km along matched line relations (`line`) | 98.7% |
| Routed without the line (`graph`)            | 1.2%  |
| Straight (incl. the 粤海轮渡 train ferry)    | 0.1%  |

Against lltskb's km, by km: 75.6% within 2%, 87.8% within 5%, 97.2% within
10%, 0.2% more than 25% off. 86% of spans route as one search along their
line, 11% the same from a fresh start at a station where the lines meet.
lltskb's km are not always track km, so a route off them may be right:

- Fare km keep an old line's length: from 昆明 to 广通北, 153 km by the old
  成昆线, while every train takes 广昆线, 113 km. These are 79 of the 137
  spans more than 25% off.
- They run through the junction a line is reckoned from, which the train
  need not pass: 石家庄 for trains between 石德线 or 京广线 and 石太线, which
  take 石家庄直通线 and turn at 石家庄北.
- On 武广 lltskb gives 52 km for 长沙南→株洲西, which are 39.6 km apart in a
  straight line; the route there runs on high-speed track at that distance.

Three lists of what is left, by how many runs it touches:

- `out/cr-osm-issues.csv`: 84 hops that need a sharp turn, find no
  plausible path, or run 1.5× lltskb's km (郑渝高铁 at 禹州 and 平顶山西,
  沪昆线 小新街→照福铺, the 杭甬线 钱清/绍兴 order).
- `out/cr-stop-issues.csv`: 51 stations the route passes more than 2 km
  away: matched to the wrong OSM station or missing from OSM's track.
  天府机场 (105 runs) is matched to the airport's metro station, 2 km from
  the 成宜高铁 track; 盛泽 sits by the 沪苏湖 junction OSM joins backwards;
  徐闻 and 海口 are the train ferry's ends.
- `out/cr-retraces.csv`: runs whose route runs back over track it ran,
  8 km or more out and back, with where it turns and the stop there if any.
  Most are real: trains reverse at a stop (or run out and back, G8745/G8748
  成都–重庆). One turning nowhere near a stop is likely an artefact; with
  timetable 20261120, 30 of 633 runs.

lltskb's path does not always fit the stops: Z111 stops at 肇庆, but its
path runs by 江门 on 广珠线, and its route there is 43% over the km.

**Japan**, 27 sample trains, from stored hops, against known distances
(営業キロ where given):

| Train                          | Route      | Known                                                                        |
| ------------------------------ | ---------- | ---------------------------------------------------------------------------- |
| のぞみ 東京→博多               | 1,066.6 km | 1,069 km of track                                                            |
| 名鉄特急 豊橋→名鉄岐阜         | 99.7 km    | 99.8 km                                                                      |
| 東横線→副都心線→東上線         | 65.4 km    | about 64–65 km                                                               |
| 山手線, two laps less one stop | 67.0 km    | about 69 km                                                                  |
| 東海道線 宇都宮→熱海           | 213.5 km   | 217.7 km                                                                     |
| サンライズ出雲 東京→出雲市     | 950.8 km   | about 953 km; 浜松→姫路 387.6 (387.2), 姫路→岡山 88.3 (88.6)                 |
| サンライズ瀬戸 東京→高松       | 801.5 km   | about 804 km                                                                 |
| 特急鎌倉 吉川美南→鎌倉         | 107.7 km   | about 110 km; 府中本町→鶴見 on the 武蔵野南線 28.2 (28.8)                    |
| 相鉄・JR直通 新宿→海老名       | 54.1 km    | about 52 km                                                                  |
| 富士回遊 千葉→河口湖           | 148.9 km   | about 150 km; 千葉→新宿 46.0 (46.4), switching tracks at 錦糸町 and 御茶ノ水 |
| 日光 新宿→東武日光             | 139.2 km   | 大宮→栃木 over the 栗橋 link: 26.2 km of 東北本線, 29.5 km of 東武日光線     |
| ふじさん 新宿→御殿場           | 97.6 km    | 新宿→松田 71.4 on 小田急, then the 松田 link to 御殿場線                     |

Every leg of every sample follows an OSM service route (サンダーバード: 大阪 ->
敦賀, 特急はるか, JR成田エクスプレス, 近鉄特急ひのとり, the 相鉄 through
service, 日光列車, ふじさん, …) or a rule's route; none is straight.
Responses are 3–52 KB.

Storage: 1,506 routes (12 from rules), 24,169 hops, 9.0 MB of SQLite, 34 s
to build. A train is four small queries and 2–15 ms of joining.

## Known issues and next steps

- **OSM gaps.** `cr-osm-issues.csv` is a to-do list for OSM itself; fixing
  the top dozens would fix thousands of runs. A Japanese list would come
  from the same check over all routes' hops.
- **Japan validation.** 27 trains is a sample; Yahoo gives no km per leg
  to check against. A wider check needs stop lists of many more trains, and
  would show which other trains need a rule.
- **Stations with several codes.** 日暮里 has three Yahoo codes, which the
  山手線 route's hops join with 0–13 m of track: 西日暮里→日暮里 and
  日暮里→鶯谷 come out near zero length.
- **Stations near the track.** Stored Japanese legs run ~0.3 km long at
  each station (continuing from a platform track); harmless on the map,
  visible in short legs.
- **Per-train relations.** Chinese mappers have mapped some trains as route
  relations (D8913天水南-兰州西, the G56xx/G58xx Hong Kong trains); where one
  exists, it could be used directly.
