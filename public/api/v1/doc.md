# API v1

JSON API for Japan train routes and station timetables, backed by
[Yahoo! 乗換案内](https://transit.yahoo.co.jp/), for China Railway
timetables from the 路路通 (lulutong) timetable data under `/api/v1/cr/*`
(see [China Railway](#china-railway); the conventions there differ), and
for railway routes and lines from OpenStreetMap under `/api/v1/relations/*`
(see [Railway relations](#railway-relations)).

Base URL: `https://map.shz.al`, the map's own Worker. The API is under `/api/v1`:
Japanese routes and timetables under `/api/v1/norikae`, China Railway under
`/api/v1/cr`, and what serves both (relations, search) at its root.

## Conventions

- `GET` only. No authentication.
- Responses are `application/json; charset=utf-8`; keys are `snake_case`.
- Station names must be **Japanese** (e.g. `渋谷`, not `Shibuya`).
- All dates/times are **Japan time** (JST, UTC+9). Times are `"HH:MM"`;
  `date` is `YYYY-MM-DD`. Times after midnight wrap (`"00:59"`), so compare
  against the route's `departure` to detect overnight trips; except a train's
  stop times (`…/trains/{train_id}`), which count the hours of its later days
  on from 24 as Yahoo does (`"33:47"` is 09:47 the next morning).
- Money is integer yen. Durations are integer minutes (`*_min`).
- Every successful response includes `source_url`: the Yahoo page it was
  parsed from.
- Fields that Yahoo does not provide for a given item are `null`.
- Every object with a Yahoo station code (`code` or `id`) also has `osm`:
  the OpenStreetMap features matched to that code, as `N123` / `W123` /
  `R123` (node / way / relation). A code often has several, e.g. one station
  node per operator. Bus stops, places without a code and unmatched stations
  get `[]`. Matching is by name, so a few stations may be missing or wrong.
- The same objects have `lat` / `lon` (WGS 84 degrees): the centre of the
  `osm` features, so they line up with the map. They are `null` when `osm`
  is empty. Station search results also give Yahoo's own position,
  `yahoo_lat` / `yahoo_lon`, for bus stops too.
- Unknown query parameters are rejected with `400`, to catch typos.
- `Cache-Control: public, max-age=N` is set on success; errors are `no-store`.
- CORS is open (`Access-Control-Allow-Origin: *`).

## Endpoints

| Endpoint                                                                       | Purpose                                  |
| ------------------------------------------------------------------------------ | ---------------------------------------- |
| `GET /api/v1/norikae/routes`                                                   | Route search between stations            |
| `GET /api/v1/norikae/stations?q=`                                              | Find station codes by name               |
| `GET /api/v1/norikae/stations/{code}/timetables`                               | Lines and directions at a station        |
| `GET /api/v1/norikae/stations/{code}/status`                                   | Service notices of a station's lines     |
| `GET /api/v1/norikae/stations/{code}/timetables/{gid}`                         | Departure timetable for one direction    |
| `GET /api/v1/norikae/stations/{code}/timetables/{gid}/status`                  | Service notices of one direction's line  |
| `GET /api/v1/norikae/stations/{code}/timetables/{gid}/trains/{train_id}`       | Stop-by-stop schedule of one train       |
| `GET /api/v1/norikae/stations/{code}/timetables/{gid}/trains/{train_id}/route` | The track one train runs on, as OSM ways |

China Railway: `GET /api/v1/cr/stations?q=`, `GET /api/v1/cr/stations/{station}/timetable`,
`GET /api/v1/cr/trains/{train}`, `GET /api/v1/cr/trains/{train}/route`,
`GET /api/v1/cr/trainsets/{train}`.

Railway relations: `GET /api/v1/relations/{id}`.

Search: `GET /api/v1/search?q=` (China Railway train numbers for now).

anitabi (experimental): `GET /api/v1/anitabi/{file}`.

Typical timetable flow: `stations` → `timetables` (pick a `gid`) →
`timetables/{gid}` (pick a `train_id`) → `trains/{train_id}`.
Station `id`s in route results are the same codes, so you can jump straight
from a route to a station's timetables.

---

### `GET /api/v1/norikae/routes`

Search routes. Returns 3 routes per page.

| Param       | Values                                                                                                          | Default         |
| ----------- | --------------------------------------------------------------------------------------------------------------- | --------------- |
| `from`      | departure station (required)                                                                                    |                 |
| `to`        | arrival station (required)                                                                                      |                 |
| `via`       | via station; repeat up to 3 times                                                                               | none            |
| `date`      | `YYYY-MM-DD`                                                                                                    | today (JST)     |
| `time`      | `HH:MM`; only with `time_type=departure\|arrival`                                                               | now (JST)       |
| `time_type` | `departure`, `arrival` (arrive by), `first` (first train), `last` (last train), `unspecified`                   | `departure`     |
| `sort`      | `time`, `fare`, `transfer`                                                                                      | `time`          |
| `ticket`    | `ic`, `cash`                                                                                                    | `ic`            |
| `seat`      | `non_reserved`, `reserved`, `green`                                                                             | `non_reserved`  |
| `walk`      | `fast`, `slightly_fast`, `slightly_slow`, `slow`                                                                | `slightly_slow` |
| `exclude`   | comma list of `shinkansen`, `express`, `airline`, `highway_bus`, `local_bus`, `ferry`, `bus` (= both bus kinds) | none            |
| `page`      | `1`–`20`                                                                                                        | `1`             |

Yahoo resolves station names loosely: an unknown or misspelled name may be
matched to a different place. Check `legs[0].from.name` and
`legs[-1].to.name` if it matters.

```
GET /api/v1/norikae/routes?from=東京&to=新大阪&seat=reserved&date=2026-11-16&time=08:30
```

```jsonc
{
  "source_url": "https://transit.yahoo.co.jp/search/result?from=...",
  "query": {
    "from": "東京",
    "to": "新大阪",
    "via": [],
    "date": "2026-11-16",
    "time": "08:30",
    "time_type": "departure",
    "sort": "time",
    "ticket": "ic",
    "seat": "reserved",
    "walk": "slightly_slow",
    "exclude": [],
    "page": 1,
  },
  "routes": [
    {
      "index": 1,
      "departure": "08:30",
      "arrival": "11:00",
      "duration_min": 150, // door to door
      "ride_min": 150, // time on board
      "transfers": 0,
      "distance_km": 552.6,
      "fare": {
        "label": "IC優先", // fare basis Yahoo used
        "total": 14720,
        "breakdown": [
          // present when Yahoo splits the total
          { "label": "乗車券", "amount": 8910 },
          { "label": "特別料金", "amount": 5810 },
        ],
        "sections": [
          // base-fare spans; one ticket each
          { "from": "東京", "to": "新大阪", "mode": "train", "amount": 8910 },
        ],
      },
      "legs": [
        {
          "mode": "train", // train | bus | ferry | air | walk | other
          "line": "ＪＲ新幹線のぞみ17号", // null for walk
          "destination": "博多行", // terminal / heading; may be null
          "duration_min": 150,
          "from": {
            "name": "東京",
            "id": "22828",
            "time": "08:30",
            "platform": "18番線",
            "osm": ["N2149761647", "N6193732167"],
            "lat": 35.680611,
            "lon": 139.766441,
          },
          "to": {
            "name": "新大阪",
            "id": "25978",
            "time": "11:00",
            "platform": "22番線",
            "osm": ["N534123201", "N3626952971"],
            "lat": 34.733504,
            "lon": 135.500202,
          },
          "surcharges": [{ "label": "指定席", "amount": 5810 }],
          "note": null, // operator notice, e.g. service changes
          "stops": [
            // intermediate stops (excludes from/to)
            {
              "name": "品川",
              "id": "22709",
              "time": "08:37",
              "osm": ["N2546879674"],
              "lat": 35.628459,
              "lon": 139.739081,
            },
            {
              "name": "新横浜",
              "id": "23212",
              "time": "08:48",
              "osm": ["N3585794198"],
              "lat": 35.50765,
              "lon": 139.617439,
            },
          ],
        },
      ],
    },
  ],
}
```

Notes:

- `legs[i].to` and `legs[i+1].from` are the same place; `to.time` is the
  arrival there and the next `from.time` the departure.
- `id` is `null` for places without a Yahoo station page (e.g. ferry
  terminals, landmarks).
- `platform` is `null` when Yahoo has no information. Bus legs use
  `のりば` / `おりば`.
- `fare.sections` only lists base fares; seat/express charges are in each
  leg's `surcharges`.

Errors: `404 not_found` when Yahoo finds no route or cannot resolve a station;
the message is Yahoo's own (e.g. `「zzqqxx」に該当する出発地はありませんでした。`).

---

### `GET /api/v1/norikae/stations`

Find stations (and bus stops) by name.

| Param  | Values                           | Default   |
| ------ | -------------------------------- | --------- |
| `q`    | search text, Japanese (required) |           |
| `type` | `station`, `bus`, `all`          | `station` |

```
GET /api/v1/norikae/stations?q=渋谷
```

```json
{
  "source_url": "https://transit.yahoo.co.jp/api/suggest?value=...",
  "results": [
    {
      "code": "22715",
      "name": "渋谷",
      "type": "station",
      "address": "東京",
      "yahoo_lat": 35.658516,
      "yahoo_lon": 139.701773,
      "osm": ["N241896099", "N3623713008"],
      "lat": 35.658713,
      "lon": 139.701637
    }
  ]
}
```

An empty `results` list means nothing matched. Yahoo rejects some symbols
in `q` (`<`, `&`, `/`, `'`, `"`, `\`); those searches return
`400 bad_request`.

---

### `GET /api/v1/norikae/stations/{code}/timetables`

Lines serving a station, with one `gid` per direction.

```
GET /api/v1/norikae/stations/22715/timetables
```

```json
{
  "source_url": "https://transit.yahoo.co.jp/timetable/22715",
  "station": {
    "code": "22715",
    "name": "渋谷",
    "osm": ["N241896099", "N3623713008"],
    "lat": 35.658713,
    "lon": 139.701637
  },
  "lines": [
    {
      "name": "ＪＲ湘南新宿ライン",
      "directions": [
        { "direction": "新宿・高崎・宇都宮", "gid": "1051", "source": "逗子・小田原" },
        { "direction": "横浜・大船", "gid": "1050", "source": "宇都宮・新宿" }
      ]
    }
  ]
}
```

---

### `GET /api/v1/norikae/stations/{code}/status`

Service notices (運行情報, from レスキューナウ as Yahoo shows them) of the
station's lines: only the lines that have one, named as in
`/timetables`. A line Yahoo flags without saying what about comes with no
`notices`; its notice is in its direction's status (below). Kept for 3
minutes.

```
GET /api/v1/norikae/stations/21338/status
```

```json
{
  "source_url": "https://transit.yahoo.co.jp/timetable/21338",
  "lines": [
    {
      "line": "ＪＲ陸羽西線",
      "notices": [
        {
          "status": "列車遅延",
          "message": "大雨の影響で、列車に遅れが出ています。",
          "cause": "大雨",
          "range": "上下方面[全区間]",
          "updated": "2026-11-25 11:00"
        }
      ],
      "url": "https://transit.yahoo.co.jp/traininfo/detail/461/0/"
    },
    { "line": "ＪＲ陸羽東線", "notices": [], "url": "https://transit.yahoo.co.jp/traininfo/detail/460/0/" }
  ]
}
```

`status` is Yahoo's: 列車遅延, 運転見合わせ, 運転再開, その他 and others.
`updated` is Japan time. `url` is Yahoo's page about the line's service.

---

### `GET /api/v1/norikae/stations/{code}/timetables/{gid}/status`

The service notices of one direction's line, as above; `line` is Yahoo's
name for it in its service information (`陸羽東線`), and `notices` is empty
when there are none. Kept for 3 minutes.

```json
{
  "source_url": "https://transit.yahoo.co.jp/timetable/21338/510",
  "line": "陸羽東線",
  "notices": [
    {
      "status": "その他",
      "message": "大雨災害の影響で、鳴子温泉〜新庄駅間の運転を見合わせています。代行輸送を行っています。",
      "cause": "大雨災害",
      "range": "上下方面[鳴子温泉〜新庄]",
      "updated": "2026-11-25 05:00"
    }
  ],
  "url": "https://transit.yahoo.co.jp/traininfo/detail/460/0/"
}
```

---

### `GET /api/v1/norikae/stations/{code}/timetables/{gid}`

Departures from the station in one direction.

| Param   | Values                                                  | Default          |
| ------- | ------------------------------------------------------- | ---------------- |
| `day`   | `weekday`, `saturday`, `holiday` (Sundays and holidays) | today's schedule |
| `hours` | `H` or `H-H`, inclusive (e.g. `7-9`)                    | all              |

```
GET /api/v1/norikae/stations/22715/timetables/1051?day=weekday&hours=7-8
```

```json
{
  "source_url": "https://transit.yahoo.co.jp/timetable/22715/1051?kind=1",
  "station": {
    "code": "22715",
    "name": "渋谷",
    "osm": ["N241896099", "N3623713008"],
    "lat": 35.658713,
    "lon": 139.701637
  },
  "line": "ＪＲ湘南新宿ライン",
  "direction": "新宿・高崎・宇都宮",
  "source": "逗子・小田原",
  "day": "weekday",
  "departures": [
    {
      "time": "07:16",
      "train_id": "33461",
      "kind": "普通",
      "destination": "小金井",
      "extra": false,
      "name": "普通",
      "kind_mark": null,
      "destination_mark": "金",
      "track": "3",
      "cars": 15,
      "train_number": "2520Y",
      "starts_here": false,
      "green_car": true,
      "express_toll": false,
      "kind_color": null
    }
  ]
}
```

- `kind`: train type (普通, 快速, 特急, ...).
- `extra: true`: runs only on specific days.
- `name`: the train's name as Yahoo shows it: the type for most trains, the
  service and number for named ones (`特急わかしお1号`).
- `kind_mark`, `destination_mark`: the one-character marks a printed
  timetable puts over the minute (`特`, `勝`); `null` for the line's usual
  type and destination, which carry none.
- `track`: the track it leaves from, as the station names it (`3`, `京葉1`
  for 京葉1番線).
- `cars`: number of cars; `null` when Yahoo does not say (often for limited
  expresses).
- `train_number`: the railway's own train number (`1803Y`, `1051M`), not
  Yahoo's `train_id`.
- `starts_here`: the train begins its run at this station.
- `green_car`: the train has a Green Car (first class).
- `express_toll`: a limited express, needing a ticket of its own (特急券).
- `kind_color`: Yahoo's color for the type, `#rrggbb` (快速 `#0000ff`, 特急
  `#ff0000`); `null` where it has none (普通).
- `source` (here and for each direction in the lines' list): where the
  direction's trains come from; `null` when Yahoo leaves it out.
- `track`, `train_number` are `null` when Yahoo does not give them.
- `day` in the response is the schedule Yahoo actually returned.

---

### `GET /api/v1/norikae/stations/{code}/timetables/{gid}/trains/{train_id}`

All stops of one train. `train_id` comes from a timetable's `departures`.

```
GET /api/v1/norikae/stations/22715/timetables/1051/trains/33471
```

```json
{
  "source_url": "https://transit.yahoo.co.jp/timetable/22715/1051/33471",
  "station": {
    "code": "22715",
    "name": "渋谷",
    "osm": ["N241896099", "N3623713008"],
    "lat": 35.658713,
    "lon": 139.701637
  },
  "train_id": "33471",
  "name": "快速",
  "line": "ＪＲ湘南新宿ライン",
  "comments": ["大宮−小山間快速。"],
  "stops": [
    {
      "code": "23096",
      "name": "大船",
      "arrival": null,
      "departure": "08:16",
      "osm": ["N263267206"],
      "lat": 35.353328,
      "lon": 139.531396
    },
    {
      "code": "23251",
      "name": "戸塚",
      "arrival": "08:21",
      "departure": "08:21",
      "osm": ["N4011643455"],
      "lat": 35.400841,
      "lon": 139.534676
    }
  ]
}
```

`arrival` is `null` at the origin, `departure` is `null` at the terminus.

### `GET /api/v1/norikae/stations/{code}/timetables/{gid}/trains/{train_id}/route`

The track the train runs on, for drawing it on a map of OpenStreetMap data,
put together from the OSM routes stopping at its stops (and, for trains no OSM
route covers, such as サンライズ, routes made for them).

```
GET /api/v1/norikae/stations/22715/timetables/1051/trains/33471/route
```

```json
{
  "data_version": "2026-11-12T16:00:00Z",
  "bbox": [139.531, 35.353, 139.71, 35.69],
  "ways": [123456789, 123456790],
  "partial": ["<polyline>"],
  "overview": ["<polyline>"],
  "stops": [{ "name": "大船", "position": [139.5314, 35.3533], "elements": ["N263267206"], "rank": 23 }],
  "legs": [{ "from": "大船", "to": "戸塚", "line": "湘南新宿ライン", "method": "line" }]
}
```

| Field          |                                                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data_version` | the OSM data's time (its `osmosis_replication_timestamp`)                                                                                                                                           |
| `bbox`         | `[west, south, east, north]` of the route                                                                                                                                                           |
| `ways`         | OSM railway ways the train covers end to end                                                                                                                                                        |
| `partial`      | the parts of ways it covers only partly, as geometry                                                                                                                                                |
| `overview`     | the whole route simplified to about 300 m, for small scales                                                                                                                                         |
| `stops`        | each stop: where the route meets it (`[lon, lat]`), its OSM station elements and `rank`, how many OSM passenger routes stop at the station (`null` without elements or before the ranks are loaded) |
| `legs`         | the route between consecutive stops: `line`, the OSM route it follows (`null` if none); `method`, `line` (along it) or `straight` (no route found; `straight` is a straight line to draw instead)   |

Geometry is a Google encoded polyline with precision 6 (latitude first); a
line in several pieces is an array of them. Errors are the train endpoint's,
and `503 data_unavailable` while the route data is not loaded.

---

## China Railway

Timetables of China Railway passenger trains, from the 路路通 (lulutong)
timetable data. These endpoints never call Yahoo; they read data imported
when a new timetable version is published. The exception is
`/api/v1/cr/trainsets`, which asks 12306 live.

- Dates and times are **China time** (UTC+8). Times are `"HH:MM"` and wrap
  after midnight; `day` says which day of the train's run a time is on
  (`1` = the day it left its origin).
- Every successful response includes `data_version`, the timetable's
  version date (e.g. `"20261114"`), instead of `source_url`
  (`/api/v1/cr/trainsets` has `source_url`, the 12306 request).
- Station names are **Chinese** (`北京南`). Search also matches pinyin and
  its initials (`beijingnan`, `bjn`) and telegraph codes (`VNP`).
- Times are scheduled; cancellations and temporary changes are not applied.
  Days after midnight are inferred from the clock times, since the data has
  no dates per stop.

| Endpoint                                      | Purpose                                                               |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `GET /api/v1/cr/stations?q=`                  | Find stations by name, pinyin or telegraph code                       |
| `GET /api/v1/cr/stations/{station}/timetable` | Every train stopping at a station on a day                            |
| `GET /api/v1/cr/trains/{train}`               | Stop-by-stop schedule of a train                                      |
| `GET /api/v1/cr/trains/{train}/route`         | The track a train runs on, as OSM ways                                |
| `GET /api/v1/cr/trainsets/{train}`            | The trainset running a train (e.g. `CR400BF-S-3243`), live from 12306 |

Typical flow: `cr/stations` (or the map's OSM ids) → a station's `timetable`
(pick a `train`) → `cr/trains/{train}` for its stops, lines and rolling stock,
`cr/trains/{train}/route` for its track on the map, and
`cr/trainsets/{train}` for the trainset on that day.

### `GET /api/v1/cr/stations`

Prefix search; busier stations first, an exact name match before all.

| Param | Values                                              | Default |
| ----- | --------------------------------------------------- | ------- |
| `q`   | name, pinyin, initials or telegraph code (required) |         |

```
GET /api/v1/cr/stations?q=bjn
```

```json
{
  "data_version": "20261114",
  "results": [
    { "name": "北京南", "telecode": "VNP", "pinyin": "beijingnan" },
    { "name": "宝鸡南", "telecode": "BBY", "pinyin": "baojinan" }
  ]
}
```

`pinyin` is `null` for the few stations the data has no pinyin for.

---

### `GET /api/v1/cr/stations/{station}/timetable`

`{station}` is a station name (`北京南`, URL-encoded) or one or more OSM
elements of the station, comma-separated: `N124205138` or
`N124205138,W987654` (node `N`, way `W`, relation `R`; at most 10). With
several, the first that is a known station is used, so a map can pass every
element it grouped into one station.

| Param   | Values                                                   | Default       |
| ------- | -------------------------------------------------------- | ------------- |
| `date`  | `YYYY-MM-DD`                                             | today (China) |
| `hours` | `H` or `H-H`, inclusive (e.g. `7-9`), of the listed time | all           |

```
GET /api/v1/cr/stations/N124205138/timetable?date=2026-11-16&hours=6
```

```json
{
  "data_version": "20261114",
  "station": { "name": "北京丰台", "telecode": "FTP" },
  "date": "2026-11-16",
  "trains": [
    {
      "train": "Z156/Z157",
      "arrival": "05:36",
      "departure": "06:02",
      "origin": "泰州",
      "destination": "哈尔滨西",
      "day": 2,
      "platform": "10",
      "arrival_number": "Z156",
      "departure_number": "Z156",
      "bound": "上行",
      "line": "京哈",
      "line_in": "京沪",
      "line_out": "京哈"
    },
    {
      "train": "K2550",
      "arrival": "06:11",
      "departure": null,
      "origin": "沈阳北",
      "destination": "北京丰台",
      "day": 2,
      "platform": "12",
      "arrival_number": "K2550",
      "departure_number": null,
      "bound": "上行",
      "line": "京沪",
      "line_in": "京沪",
      "line_out": null
    }
  ]
}
```

- Lists every train that stops at the station on `date`, sorted by time:
  `departure`, or `arrival` at the train's terminus (`departure` is `null`
  there, `arrival` at its origin).
- A train that left its origin the day before and stops here after midnight
  is listed under this `date`, with `day: 2` (both trains above).
- `train` is the full number; `Z156/Z157` is one train whose number changes
  on the way. Pass it, URL-encoded, to `cr/trains`.
- `platform` is the platform or ticket gate, `null` when unknown.
- `arrival_number`, `departure_number`: the number the train arrives and
  leaves under here, from the timetable data, as the railway assigns them.
  They differ only where the number changes: Z156/Z157 arrives at 山海关 as
  Z156 and leaves as Z157. `null` at the origin and terminus respectively.
  For a few dozen trains the data has no per-stop number; they show their
  first number throughout, as lulutong's app does.
- `bound`: `下行` for an odd number, `上行` for an even one, from
  `departure_number` (`arrival_number` at the terminus). It follows the
  railway's numbering, which is set per line and section, so it is not
  always "toward Beijing": Z156 leaves 北京丰台 for 山海关 still as 上行.
- `line_in`, `line_out`: the line the train arrives and leaves on, named as
  passengers know it (京沪, 京沪高速, 京广高速, 沪汉蓉 …): the line it is on
  50 km away, so connectors next to the station do not count. Where that
  point is on a connector or a line inside a railway hub (虹封线 in 上海),
  it is the line the train is on before it, or after it for a station
  inside the hub: G8354 comes into 太仓 from 上海虹桥 on 沪苏通. `null` at the
  origin and terminus respectively, when the data has no route for the
  train (about 1%), or when the train runs on nothing but connectors and
  suburban links (北京直通线, 西长铁路).
- `line`: the one to group by: `line_out`, or `line_in` at the terminus.
- Group or filter by `line` and `bound` to build direction tabs, e.g.
  京沪高速 下行 at 北京南; trains with `line: null` belong under "other".
- The timetable data sometimes names the conventional line where a train
  runs on the high-speed one beside it, or the reverse (京广线 and
  京广高铁 near 北京西). These lines are corrected by the train's class (G
  only high-speed; K, T, Z and other conventional classes only
  conventional) and, for D and C trains, by their return train and
  rolling stock.

Errors: `404 not_found` when the name or none of the OSM elements is a known
station.

---

### `GET /api/v1/cr/trains/{train}`

`{train}` is a train number (`G1`, `g1`), either half of a double number
(`Z157` finds `Z156/Z157`, and `Z156/Z157B`, its next service period), or a
full number from a timetable.

| Param  | Values                                                         | Default       |
| ------ | -------------------------------------------------------------- | ------------- |
| `date` | `YYYY-MM-DD`, the day the train leaves its origin; sets `runs` | today (China) |

```
GET /api/v1/cr/trains/G1?date=2026-11-16
```

```json
{
  "data_version": "20261114",
  "train": "G1",
  "date": "2026-11-16",
  "trains": [
    {
      "train": "G1",
      "service": { "from": "2026-01-27", "to": null },
      "runs": true,
      "rolling_stock": {
        "model": "CR400BF-S",
        "coupled": true,
        "depot": "上局上海段",
        "description": "CR400BF-S型重联，G1955/6/7/8石家庄调向"
      },
      "lines": [
        {
          "name": "京沪高速线",
          "stations": [
            { "name": "北京南", "km": 0 },
            { "name": "廊坊", "km": 60 },
            { "name": "京津所", "km": 110 },
            // ...
            { "name": "上海虹桥", "km": 1318 }
          ]
        }
      ],
      "stops": [
        {
          "name": "北京南",
          "telecode": "VNP",
          "arrival": null,
          "departure": "06:30",
          "day": 1,
          "km": 0,
          "platform": "17",
          "elements": ["N539260172"],
          "position": [116.372399, 39.863483],
          "arrival_number": null,
          "departure_number": "G1",
          "bound": "下行"
        },
        {
          "name": "沧州西",
          "telecode": "CBP",
          "arrival": "07:18",
          "departure": "07:20",
          "day": 1,
          "km": 210,
          "platform": "2",
          "elements": ["N8927836153"],
          "position": [116.760262, 38.305767],
          "arrival_number": "G1",
          "departure_number": "G1",
          "bound": "下行"
        }
      ]
    }
  ]
}
```

- `trains` usually has one entry. A number can have several, each with its
  own `service` period: `Z156` returns `Z156/Z157` until 2026-11-24 and
  `Z156/Z157B` from 2026-11-25. Use `runs` to pick the one for `date`.
- `service` is the train's service period; `to: null` means until further
  notice.
- `runs`: whether the train leaves its origin on `date`.
- `rolling_stock` is what the train runs with on `date` (or the nearest day
  of its service), `null` when the data has none (about 8% of trains):
  - `model`: e.g. `CR400AF-Z`, `CRH380BG`, or a coach type like `25G` for
    loco-hauled trains; `null` when `description` names none.
  - `coupled`: two trainsets run together (重联).
  - `depot`: the railway depot or company that operates the stock.
  - `description`: the data's own text, often with power supply and notes
    such as where the set turns around (调向). A set runs several trains in
    a rotation, so notes may name those other trains.
  - Individual trainsets (`CR400BF-S-3243`) are not in the data; ask
    `/api/v1/cr/trainsets/{train}`.
- `lines`: the railway lines the train runs over, in order, each with every
  station the train passes on it (stops, stations it runs through, and
  junctions or block posts, `所`). The last station of a line is the first
  of the next. `km` is on the same scale as the stops' `km`.
  - Every stop is in `stations` with its own `name` and `km`, so the lines
    between two stops are the lines from the first one's entry to the
    second one's. Between `北京丰台` (km 1298) and `山海关` (km 1629), Z157
    runs on 京沪线 to 北京 (km 1314), then on 京哈线.
  - Match stops to `stations` in order, by `name` and `km`: a train that
    loops or turns back passes some stations twice, and a junction is listed
    at the end of one line and the start of the next.
  - Stops come from the timetable; the stations between them come from the
    railway's line tables, with km spread between the stops by their
    distances on the lines.
  - Empty when unknown (about 1% of trains).
- `km` is the distance from the origin.
- `arrival_number`, `departure_number`, `bound` on each stop: as in the
  station timetable. A stop where the two numbers differ is where the
  number changes; lulutong's app shows it as `Z157/Z156` (东台, Z156/Z157).
- `elements` are the stop's OSM station features and `position` their
  centre (`[lon, lat]`); both `null` for a station not matched to OSM.

Errors: `404 not_found` for an unknown train.

### `GET /api/v1/cr/trains/{train}/route`

The track the train runs on, for drawing it on a map of OpenStreetMap data:
the run of `{train}` on `date` (the one leaving its origin that day, else the
one in service), routed along the lines of its timetable path.

| Param  | Values                                            | Default       |
| ------ | ------------------------------------------------- | ------------- |
| `date` | `YYYY-MM-DD`, the day the train leaves its origin | today (China) |

The response is the Yahoo train route's (above), with `data_version` the
OSM data's time; `legs` are the legs of the timetable path, named by its
lines, so they may begin or end at a junction the train does not stop at.

Errors: `404 not_found` for an unknown train, or a train whose route is not
built yet (one new in the timetable); `503 data_unavailable` while the route
data is not loaded.

---

## Railway relations

Railway routes and lines from OpenStreetMap, for drawing them on a map built
from the same data: OSM's railway extract, cut to China, Japan and what lies
between. Responses name OSM elements, so a map can highlight its own features
by id.

- Every successful response includes `data_version`: the extract's
  replication timestamp (`"2026-11-12T18:00:00Z"`). Answers for one version
  never change.
- Elements are a type letter and an OSM id: `N241896099`, `W137315646`.
- Coordinates are `[lon, lat]`; bounding boxes `[west, south, east, north]`.
- Geometry is a [Google encoded polyline](https://developers.google.com/maps/documentation/utilities/polylinealgorithm)
  with **precision 6**; a line in several pieces is an array of them.

| Endpoint                     | Purpose                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `GET /api/v1/relations/{id}` | A route, line or route master: its ways, stations and outline |

### `GET /api/v1/relations/{id}`

`{id}` is an OSM relation id: a route (`route=train`, `subway`,
`light_rail`, `tram`, `monorail`, `funicular`), a line (`route=railway`) or a
`route_master`. In Japan it can also be one of the official lines (路線) of
MLIT's railway data, 国土数値情報 N02: `jp-` and 10 hex digits
(`jp-15e84d7cdd` is 山陰本線). No parameters.

```
GET /api/v1/relations/1972920
```

```json
{
  "data_version": "2026-11-12T18:00:00Z",
  "relation": {
    "id": 1972920,
    "kind": "route",
    "type": "train",
    "name": "JR山手線",
    "ref": "JY",
    "from": "品川",
    "to": "品川",
    "operator": "東日本旅客鉄道",
    "network": "東京近郊区間;山手線",
    "colour": "#B1CB39",
    "master": 1139468,
    "wikidata": "Q693036",
    "wikipedia": "ja:山手線"
  },
  "bbox": [139.699312, 35.616831, 139.779778, 35.740525],
  "length_m": 34493,
  "overview": ["{er}bAuw}oiGryQt|Ajs…"],
  "ways": [781158785, 211240840],
  "stops": [
    { "name": "品川", "position": [139.738507, 35.628654], "elements": ["N4011643454"], "km": null, "rank": 31 },
    { "name": "大崎", "position": [139.728663, 35.619475], "elements": ["N241815384"], "km": null, "rank": 14 }
  ]
}
```

- `relation`: `kind` is `route`, `line` or `master`, and `type` the
  `route=` (or `route_master=`) value. `name`, `ref`, `from`, `to`,
  `operator`, `network`, `wikidata` and `wikipedia` are the tags, `null` when
  absent. `colour` is the `colour` tag when it is a CSS colour. `master` is
  the route master a route belongs to.
- `ways`: the member ways that are railway track, in member order (a line's
  sections included); `bbox` is their extent. `length_m` is their length
  along one track: tracks side by side count once.
- `overview`: the ways simplified to about 300 m, one track of several side
  by side, joined into as few pieces as possible.
- `stops`: stations in order, each with its `name`, `position`, the station
  elements it belongs to (`railway=station`, `halt` or `tram_stop`, through
  its stop area, else the nearest within 300 m), `km`, the stop
  position's `railway:position` when tagged, and `rank`, how many OSM
  passenger routes stop at the station (the busiest of its elements; a
  stop area's stations share theirs), which the map places labels by.
  - A route: its stop and platform members in member order, one per station,
    placed at the stop position.
  - A line: the stations it lists as members, and those of its kind of track
    (train or metro) with a station node within 100 m of its track, a stop
    position on it or a platform beside it; placed on the track and ordered
    along it, from its `from` station when tagged.
- A route master has `routes` (its routes, as `relation` above), `bbox` and
  `overview` instead of `ways`, `stops` and `length_m`.
- An official line has `kind` `line` and `type` `railway`; `ways` are the
  ways matched to it, including those of other lines it shares track with;
  `stops` are N02's stations of the line, matched to OSM stations by name.
  `relation` adds `aliases`, other names its track carries, and
  `attribution`, which anything showing the line must display:
  `{"text": "「国土数値情報（鉄道データ）」（国土交通省）を加工して作成", "url": "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html"}`.
  Its `colour` is its routes' colour, by length along it, when routes of that
  colour run along at least a quarter of it.

Errors: `400 bad_request` for a malformed id, `404 not_found` for a relation
not in the data.

---

### `GET /api/v1/cr/trainsets/{train}`

The trainset (动车组) 12306 assigns to an EMU train on a day, with its
model, size and coaches. Asked live from 12306, the source lulutong's app
uses; the timetable data only has the model (`rolling_stock` in
`cr/trains`).

`{train}` is a train number (`G2705`, `g2705`). A full number from a
timetable works too: `Z156/Z157B` is asked as `Z156`.

| Param  | Values                                            | Default       |
| ------ | ------------------------------------------------- | ------------- |
| `date` | `YYYY-MM-DD`, the day the train leaves its origin | today (China) |

```
GET /api/v1/cr/trainsets/G2705?date=2026-11-14
```

```json
{
  "source_url": "https://mobile.12306.cn/wxxcx/openplatform-inner/...getCarDetail?trainCode=G2705&runningDay=20261114&reqType=form&carCode=G2705",
  "train": "G2705",
  "date": "2026-11-14",
  "trainset": {
    "id": "CR400BF-S-3243",
    "model": "CR400BF-S",
    "brand": "复兴号",
    "cars": 8,
    "length_m": 208.95,
    "capacity": 619,
    "max_speed_kmh": 350,
    "details": [
      { "name": "列车编组", "value": "8辆" },
      { "name": "列车长度", "value": "208.95m" },
      { "name": "列车定员", "value": "619人" },
      { "name": "最高时速", "value": "350km/h" },
      { "name": "餐车", "value": "05车" },
      { "name": "静音车厢", "value": null }
    ],
    "coaches": ["01车 一等/商务 32/5", "02车 二等 93", "...", "08车 二等/商务 43/6"]
  }
}
```

- `trainset` is `null` when 12306 has none: unknown numbers, and trains
  that are not EMUs (`K551`). A `200` with `null` does not mean the train
  does not exist.
- `id` is the trainset's model and number. `brand` is 复兴号 or 和谐号.
- `cars`, `length_m`, `capacity`, `max_speed_kmh` are read from `details`,
  which keeps all of 12306's labels as given; a label with no value
  (`静音车厢`, a quiet coach) is `null`.
- `coaches` lists each coach with its seat classes and seat counts, as 12306
  words them.
- For a train of two coupled sets (`rolling_stock.coupled` in `cr/trains`),
  12306 describes one set.
- 12306 may answer the same set for every date; treat it as the planned
  trainset, not a confirmation of what ran.

Errors: `400 bad_request` for a `{train}` that is not a train number;
`502`/`504` as for Yahoo when 12306 errs or is slow.

---

## Search

### `GET /api/v1/search`

Find China Railway trains by number, with each train's origin and terminus.
Stations and lines will follow; every result has a `type` so they can join
the same list.

| Param   | Values                                                         | Default |
| ------- | -------------------------------------------------------------- | ------- |
| `q`     | start of a train number (required): `G1`, `g1`, `Z157`, `Ｇ１` |         |
| `limit` | `1`–`50`                                                       | `20`    |

```
GET /api/v1/search?q=Z157
```

```json
{
  "data_version": "20261120",
  "query": "Z157",
  "results": [
    {
      "type": "cr_train",
      "train": "Z156/Z157",
      "origin": "泰州",
      "destination": "哈尔滨西",
      "service": { "from": "2024-04-02", "to": "2026-11-24" }
    },
    {
      "type": "cr_train",
      "train": "Z156/Z157B",
      "origin": "泰州",
      "destination": "哈尔滨西",
      "service": { "from": "2026-11-25", "to": null }
    }
  ]
}
```

- Matches numbers that start with `q`, case-insensitively, ignoring spaces
  and full-width forms. Either half of a double number matches (`Z157`
  finds `Z156/Z157`), and so does the full number as a timetable writes it
  (`Z156/Z157B`).
- Sorted exact match first, then shorter numbers: `G1` lists G1, then
  G10–G19, then G100 and on.
- A number with several service periods appears once per period, each
  with its `service` (as in `cr/trains`); pass `train` to
  `/api/v1/cr/trains/{train}` for its stops.
- `query` is `q` as matched: upper case, without spaces.
- `results` is empty when nothing matches.

Errors: `400 bad_request` without `q`; `503 data_unavailable` when the
China Railway data is not loaded.

## anitabi

### `GET /api/v1/anitabi/{file}`

Experimental. anitabi's anime pilgrimage spots, the files its own map at
[anitabi.cn/map](https://www.anitabi.cn/map) loads, passed on unchanged from
`https://www.anitabi.cn/d/{file}`, which sends no CORS headers. The map's
anitabi layer reads them (`src/anitabi.ts` describes their fields).

| `file`                  | What                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `g.json`                | `[works, page_size, modified]`: every work with the position and priority of its spots         |
| `g0.json`, `g1.json`, … | The spots' details (names, screenshots, episodes), `page_size` works each, in `g.json`'s order |
| `users.csv`             | `id,nickname` of contributors                                                                  |

| Param | Values                                                                                     | Default |
| ----- | ------------------------------------------------------------------------------------------ | ------- |
| `d`   | anitabi's cache key, passed on: base 36 of `floor(ms / 1440000) + 6`, new every 24 minutes | none    |

Errors: `404 not_found` for a chunk past the last; `502`/`504` when anitabi
errs or is slow.

## Errors

```json
{ "error": { "code": "bad_request", "message": "time must be HH:MM (00:00–23:59)" } }
```

| HTTP | `code`                 | Meaning                                                                                                                       |
| ---- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 400  | `bad_request`          | Missing, malformed or unknown parameter, or input Yahoo rejected                                                              |
| 404  | `not_found`            | Unknown endpoint, station, line, train, or no route found                                                                     |
| 405  | `method_not_allowed`   | Only `GET`/`HEAD`/`OPTIONS` are supported                                                                                     |
| 500  | `internal_error`       | Bug in this service                                                                                                           |
| 502  | `upstream_error`       | Yahoo (or 12306, for `cr/trainsets`) returned an error or was unreachable, or the service's instance in Japan was unreachable |
| 502  | `upstream_parse_error` | Yahoo's page format (or 12306's answer) changed; needs a code update                                                          |
| 503  | `region_unavailable`   | Yahoo refused the request (HTTP 403), usually because of where it came from; retry later                                      |
| 503  | `data_unavailable`     | China Railway, train route or railway relation data is not loaded, or its database is unreachable                             |
| 504  | `upstream_timeout`     | Yahoo (or 12306) did not respond within 15 s                                                                                  |

## Caching

Upstream pages are cached at the edge and the same lifetime is sent to
clients:

| Data                                                       | TTL    |
| ---------------------------------------------------------- | ------ |
| Routes                                                     | 5 min  |
| Station search, line lists                                 | 1 day  |
| Service notices (`.../status`)                             | 3 min  |
| Timetable with `day`                                       | 1 hour |
| Timetable without `day` (today's)                          | 10 min |
| Train schedule, train route                                | 1 hour |
| China Railway timetables and routes (other `/api/v1/cr/*`) | 1 hour |
| China Railway trainsets (`/api/v1/cr/trainsets`)           | 10 min |
| Search (`/api/v1/search`)                                  | 1 hour |
| Railway relations (`/api/v1/relations/*`)                  | 1 day  |
| anitabi (`/api/v1/anitabi/*`)                              | 1 hour |

Results are scheduled times; real-time delays are not reflected, beyond the
service notices of the `status` endpoints.
