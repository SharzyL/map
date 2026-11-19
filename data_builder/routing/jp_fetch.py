"""Collect sample Japanese trains (stop lists) through the map's API.

Each sample names a station, a word in the line's name and a word in the
train's kind; the first matching departure after the given hour is fetched
with its stops. Point --api at a local `wrangler dev` of this repository
(pnpm preview), not production.

Usage: jp_fetch.py --api http://127.0.0.1:8787 --out out/jp-trains.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request

# (label, station, line word, kind word, destination word, hour[, day, hours]);
# words match substrings. Limited expresses have no line of their own at a
# station: they are departures of kind 特急 on the line they run on. Day is
# weekday unless given (特急鎌倉 runs on holidays); hours to search, 2.
SAMPLES = [
    ("のぞみ 東京→", "東京", "東海道新幹線", "のぞみ", "", 9),
    ("こまち 東京→", "東京", "秋田新幹線", "", "", 9),
    ("つばさ 東京→", "東京", "山形新幹線", "つばさ", "", 9),
    ("サンダーバード 大阪→", "大阪", "京都線", "特急", "敦賀", 9),
    ("はるか 京都→", "京都", "京都線", "特急", "関西空港", 9),
    ("あずさ 新宿→", "新宿", "中央線快速", "特急", "松本", 9),
    ("踊り子 東京→", "東京", "東海道本線", "特急", "", 9),
    ("ひたち 品川→", "品川", "東海道本線", "特急", "いわき", 9),
    ("成田エクスプレス 東京→", "東京", "総武線快速", "特急", "成田空港", 9),
    ("湘南新宿ライン 新宿→", "新宿", "湘南新宿ライン", "快速", "", 10),
    ("東横線→副都心線 横浜→", "横浜", "東急東横線", "急行", "", 10),
    ("小田急ロマンスカー 新宿→", "新宿", "小田急小田原線", "特急", "", 10),
    ("近鉄特急 大阪難波→", "大阪難波", "近鉄難波線", "特急", "", 10),
    ("名鉄特急 名鉄名古屋→", "名鉄名古屋", "名鉄名古屋本線", "特急", "", 10),
    ("さくら 博多→", "博多", "九州新幹線", "", "", 9),
    ("上野東京ライン 上野→", "上野", "上野東京ライン", "", "", 10),
    ("山手線 東京→", "東京", "山手線", "", "", 10),
    ("東海道線 東京→", "東京", "東海道本線", "普通", "", 10),
    # Over freight lines and through junctions no service route stops at
    ("特急鎌倉 吉川美南→", "吉川美南", "武蔵野線", "特急", "鎌倉", 6, "holiday", 6),
    ("サンライズ出雲 東京→", "東京", "東海道本線", "特急", "出雲", 21),
    ("サンライズ瀬戸 東京→", "東京", "東海道本線", "特急", "高松", 21),
    ("相鉄・JR直通 新宿→", "新宿", "埼京線", "", "海老名", 10),
    ("相鉄・JR直通 海老名→", "海老名", "相鉄本線", "", "新宿", 10),
    # Across companies on connecting tracks
    ("日光 新宿→", "新宿", "湘南新宿ライン", "特急", "東武日光", 6, "weekday", 12),
    (
        "きぬがわ 新宿→",
        "新宿",
        "湘南新宿ライン",
        "特急",
        "鬼怒川温泉",
        6,
        "weekday",
        12,
    ),
    ("ふじさん 新宿→", "新宿", "小田急小田原線", "特急", "御殿場", 6, "weekday", 12),
    ("富士回遊 新宿→", "新宿", "中央線快速", "特急", "河口湖", 6, "weekday", 12),
]


def get(api: str, path: str, **params: object) -> dict:
    url = f"{api}{path}" + (f"?{urllib.parse.urlencode(params)}" if params else "")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                return json.load(r)
        except Exception as error:  # the local worker may be warming up
            if attempt == 2:
                raise
            print(f"  {path}: {error}, retrying", file=sys.stderr)
            time.sleep(5)
    raise AssertionError


def fetch(
    api: str,
    label: str,
    station: str,
    line_word: str,
    kind_word: str,
    dest_word: str,
    hour: int,
    day: str = "weekday",
    hours: int = 2,
) -> dict | None:
    found = get(api, "/api/v1/norikae/stations", q=station)["results"]
    if not found:
        print(f"{label}: no station {station}", file=sys.stderr)
        return None
    code = found[0]["code"]
    lines = get(api, f"/api/v1/norikae/stations/{code}/timetables")["lines"]
    for line in lines:
        if line_word not in line["name"]:
            continue
        for direction in line["directions"]:
            tt = get(
                api,
                f"/api/v1/norikae/stations/{code}/timetables/{direction['gid']}",
                day=day,
                hours=f"{hour}-{hour + hours}",
            )
            for dep in tt["departures"]:
                if kind_word in dep["kind"] and dest_word in dep["destination"]:
                    train = get(
                        api,
                        f"/api/v1/norikae/stations/{code}/timetables/{direction['gid']}/trains/{dep['train_id']}",
                    )
                    print(
                        f"{label}: {train['name']} on {line['name']}, {len(train['stops'])} stops",
                        file=sys.stderr,
                    )
                    # The train page's own `line` is not reliable; the timetable's is
                    return {
                        "label": label,
                        "kind": dep["kind"],
                        "destination": dep["destination"],
                        **train,
                        "timetable_line": line["name"],
                    }
    print(
        f"{label}: no {line_word} / {kind_word} departure at {station} ({[l['name'] for l in lines]})",
        file=sys.stderr,
    )
    return None


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--api", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument(
        "--keep", help="earlier output whose trains with a timetable_line are kept"
    )
    args = ap.parse_args()
    trains = []
    if args.keep:
        with open(args.keep, encoding="utf-8") as f:
            trains = [t for t in json.load(f) if "timetable_line" in t]
    have = {t["label"] for t in trains}
    for sample in SAMPLES:
        if sample[0] in have:
            continue
        try:
            train = fetch(args.api, *sample)
        # Keep going: one bad sample should not stop the rest
        except Exception as error:  # noqa: BLE001
            print(f"{sample[0]}: {error}", file=sys.stderr)
            continue
        if train:
            trains.append(train)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(trains, f, ensure_ascii=False, indent=1)
    print(f"{len(trains)} trains written to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
