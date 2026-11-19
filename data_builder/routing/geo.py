"""Distances and encoded polylines, in plain Python. The Worker has the same
in TypeScript (src/worker/api/geo.ts)."""

from __future__ import annotations

import math

EARTH_M = 6_371_000


def metres(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (
        math.sin((p2 - p1) / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    )
    return 2 * EARTH_M * math.asin(min(1.0, math.sqrt(a)))


def encode_polyline(coords: list[tuple[float, float]], precision: int = 6) -> str:
    """Google encoded polyline of (lat, lon) points."""
    factor = 10**precision
    out, plat, plon = [], 0, 0
    for lat, lon in coords:
        ilat, ilon = round(lat * factor), round(lon * factor)
        for d in (ilat - plat, ilon - plon):
            d = ~(d << 1) if d < 0 else d << 1
            while d >= 0x20:
                out.append(chr((0x20 | (d & 0x1F)) + 63))
                d >>= 5
            out.append(chr(d + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def decode_polyline(text: str, precision: int = 6) -> list[tuple[float, float]]:
    """(lat, lon) points of a Google encoded polyline."""
    factor, out, i, lat, lon = 10**precision, [], 0, 0, 0
    while i < len(text):
        deltas = []
        for _ in range(2):
            shift = result = 0
            while True:
                b = ord(text[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            deltas.append(~(result >> 1) if result & 1 else result >> 1)
        lat, lon = lat + deltas[0], lon + deltas[1]
        out.append((lat / factor, lon / factor))
    return out
