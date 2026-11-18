#!/usr/bin/env python3
"""Passes its input to its output unchanged, and says every few minutes on
stderr how much has gone through and how fast, so a long download piped
into osmium shows its progress, and a slow or stalled one shows as such.

Usage: meter.py <label> [total bytes] [--every SECONDS]

    planet pass 1: 31.4 GB of 95.2 GB (33%) in 10 min, 54 MB/s now, 52 MB/s on average, about 20 min left

With the total (a Content-Length) it gives the share and the time left at
the rate of the last interval. A last line gives the whole pass.
"""

import argparse
import os
import sys
import time

CHUNK = 1 << 20


def size(n: float) -> str:
    return f'{n / 1e9:.1f} GB' if n >= 1e9 else f'{n / 1e6:.0f} MB'


def rate(n: float, seconds: float) -> str:
    return f'{n / max(seconds, 1e-9) / 1e6:.0f} MB/s'


def span(seconds: float) -> str:
    minutes = int(seconds // 60)
    if minutes < 1:
        return f'{int(seconds)} s'
    return f'{minutes} min' if minutes < 60 else f'{minutes // 60} h {minutes % 60:02d} min'


def line(label: str, done: int, total: int | None, elapsed: float, recent: tuple[int, float] | None) -> str:
    """What has gone through so far; `recent` is the bytes and seconds of the
    last interval, for the rate now and the time left"""
    text = f'{label}: {size(done)}'
    if total:
        text += f' of {size(total)} ({done * 100 // total}%)'
    text += f' in {span(elapsed)}'
    if recent:
        text += f', {rate(*recent)} now'
    text += f', {rate(done, elapsed)} on average'
    if total and recent and recent[0] and done < total:
        text += f', about {span((total - done) / (recent[0] / recent[1]))} left'
    return text


def copy(label: str, total: int | None, every: float, src: int = 0, dst: int = 1) -> int:
    start = last_time = time.monotonic()
    done = last_done = 0
    while chunk := os.read(src, CHUNK):
        view = memoryview(chunk)
        while view:
            view = view[os.write(dst, view) :]
        done += len(chunk)
        now = time.monotonic()
        if now - last_time >= every:
            print(line(label, done, total, now - start, (done - last_done, now - last_time)), file=sys.stderr, flush=True)
            last_time, last_done = now, done
    print(line(label, done, None, time.monotonic() - start, None), file=sys.stderr, flush=True)
    return done


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('label')
    parser.add_argument('total', nargs='?', type=int, help='bytes expected (a Content-Length)')
    parser.add_argument('--every', type=float, default=180, help='seconds between lines (default: 180)')
    args = parser.parse_args()
    try:
        copy(args.label, args.total or None, args.every)
    except BrokenPipeError:
        # What reads it stopped (and says why); so does this
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
