#!/usr/bin/env python3
"""Download and unpack the Lulutong (路路通) data package an.db (stdlib only).

Usage:
    python3 fetch.py --check          # print the upstream data version only, e.g. 20261114
    python3 fetch.py [out dir]        # download to <out>/an.db and unpack into <out>/an/
    python3 fetch.py --version <V> --db <an.db> --out <dir>
                                      # unpack version V into <dir>, for the build

The output dir defaults to this script's directory. The download is skipped when the
local an/ver.txt is already current (--force overrides). Only the version goes to
stdout and logs go to stderr, so CI can do `ver=$(python3 fetch.py --check)`.

With --version, the an.db at --db is used if the file exists, else the upstream one is
downloaded there. Upstream only keeps the latest version, so an older V can only come
from a kept file; anything but version V is an error.
"""
import argparse
import io
import os
import re
import shutil
import sys
import time
import urllib.request
import zipfile

# The android.ver on mirror 223.107.87.50:8011 is stuck in 2023; only trust this one
VER_URL = "http://down.lltskb.com/android.ver"
HERE = os.path.dirname(os.path.abspath(__file__))


def log(*a):
    print(*a, file=sys.stderr)


def get(url, tries=3, timeout=60):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except OSError as e:
            log(f"  {url}: {e}")
            if i + 1 < tries:
                time.sleep(5 * (i + 1))
    return None


def upstream():
    """-> (data version, [an.db download URLs])

    android.ver is hand-written JSON and has shipped typos like `"name": 应用宝",`
    (missing quote) that json.loads rejects, so the fields are pulled out with regexes.
    The first "version" block is the top-level one; the ones under "market" come later.
    """
    raw = get(VER_URL)
    if raw is None:
        sys.exit(f"无法获取 {VER_URL}")
    txt = raw.decode("utf-8-sig", "replace")
    m = re.search(r'"version"\s*:\s*\{[^}]*?"data"\s*:\s*"(\d{8})"', txt)
    u = re.search(r'"dataUrl"\s*:\s*\[([^\]]*)\]', txt)
    if not m or not u:
        sys.exit(f"android.ver 格式变了，解析不出 version.data / dataUrl：\n{txt[:500]}")
    return m.group(1), re.findall(r'"(https?://[^"]+)"', u.group(1))


def download(urls, ver):
    """Try dataUrl in order; accept only an intact ZIP whose ver.txt matches the manifest"""
    for url in urls:
        log(f"下载 {url}")
        b = get(url)
        if b is None:
            continue
        try:
            z = zipfile.ZipFile(io.BytesIO(b))
            bad = z.testzip()
            got = z.read("ver.txt").decode("utf-8", "replace").strip()
        except (zipfile.BadZipFile, KeyError) as e:
            log(f"  不是有效的数据包: {e}")
            continue
        if bad:
            log(f"  CRC 校验失败: {bad}")
        elif got != ver:
            log(f"  ver.txt 是 {got}，清单是 {ver}，跳过（镜像可能没同步）")
        else:
            return b, z
    sys.exit(f"所有 dataUrl 都没拿到 {ver} 版数据包")


def unpack(z, an):
    """Unpack to a temp dir and swap, so files dropped upstream don't linger in an/"""
    tmp = an.rstrip("/") + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    z.extractall(tmp)
    shutil.rmtree(an, ignore_errors=True)
    os.rename(tmp, an)


def fetch_version(ver, db, out):
    """Unpack exactly version `ver` into `out`, from the an.db at `db` or else upstream"""
    if os.path.exists(db):
        try:
            z = zipfile.ZipFile(db)
            bad = z.testzip()
            got = z.read("ver.txt").decode("utf-8", "replace").strip()
        except (zipfile.BadZipFile, KeyError) as e:
            sys.exit(f"{db} 不是有效的数据包: {e}")
        if bad:
            sys.exit(f"{db} CRC 校验失败: {bad}")
        if got != ver:
            sys.exit(f"{db} 是 {got} 版，需要 {ver} 版")
        log(f"使用已有的 {db}（{got}）")
    else:
        latest, urls = upstream()
        if latest != ver:
            sys.exit(f"上游已是 {latest} 版，{ver} 版只能来自保存下来的 an.db（{db} 不存在）")
        b, z = download(urls, ver)
        os.makedirs(os.path.dirname(os.path.abspath(db)), exist_ok=True)
        # Under another name first, so an interrupted run leaves nothing to reuse
        with open(db + ".part", "wb") as f:
            f.write(b)
        os.replace(db + ".part", db)
    unpack(z, out)
    log(f"已解压 {len(z.namelist())} 个文件到 {out}")
    print(ver)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("dir", nargs="?", default=HERE, help="输出目录（默认脚本所在目录）")
    ap.add_argument("--check", action="store_true", help="只打印上游数据版本号")
    ap.add_argument("--force", action="store_true", help="本地已是最新也重新下载")
    ap.add_argument("--version", help="只接受这个数据版本（与 --db、--out 同用）")
    ap.add_argument("--db", help="an.db 的位置：存在则直接使用，否则下载到这里")
    ap.add_argument("--out", help="解压到这个目录")
    args = ap.parse_args()

    if args.version or args.db or args.out:
        if not (args.version and args.db and args.out):
            ap.error("--version、--db、--out 必须同时给出")
        fetch_version(args.version, args.db, args.out)
        return

    ver, urls = upstream()
    if args.check:
        print(ver)
        return

    an = os.path.join(args.dir, "an")
    vp = os.path.join(an, "ver.txt")
    if not args.force and os.path.exists(vp) and open(vp).read().strip() == ver:
        log(f"{an} 已是 {ver}，跳过下载")
        print(ver)
        return

    b, z = download(urls, ver)
    os.makedirs(args.dir, exist_ok=True)
    with open(os.path.join(args.dir, "an.db"), "wb") as f:
        f.write(b)
    unpack(z, an)
    log(f"已解压 {len(z.namelist())} 个文件到 {an}（{len(b)} 字节）")
    print(ver)


if __name__ == "__main__":
    main()
