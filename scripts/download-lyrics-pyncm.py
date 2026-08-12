#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用 pyncm 给本地曲库批量下载歌词 —— 只下歌词，不下音频。

- 曲库目录 : 从 ~/.config/LinuxCockpit/aidj/config.json 的 music_folders 读取
- 登录态   : ~/Apps/ncm_info （pyncm --save 的产物，CLI --load 同款格式）
- 输出     : ~/Desktop/yrc/ 每首歌一对文件
               <音频文件名>.lrc   源语言 + 翻译 + 罗马音 合并（与 pyncm CLI 一致）
               <音频文件名>.yrc   逐词时间戳原始文本（歌曲有逐词歌词才写）
- 幂等     : 已存在 .lrc 则跳过（--redownload 强制重下）

搜索策略（--search-api auto 默认）：
  网易云搜索接口有粗暴限流：并发/高频必触发 460/405「操作频繁」，IP 级封几分钟。
  因此搜索一律「串行 + 限速 + 风控长冷却重试」。默认走 pyncm 登录态会话（恢复快、
  最稳）；本地 NeteaseCloudMusicApi（~/Apps/Music）可用时才切它做加速。
  歌词始终走 pyncm 登录态（node API 的 /lyric 拿不到 yrc）。

用法:
    ./scripts/download-lyrics-pyncm.py
    ./scripts/download-lyrics-pyncm.py --out ~/Desktop/yrc --workers 6
    ./scripts/download-lyrics-pyncm.py --limit 20     # 先试跑 20 首
    ./scripts/download-lyrics-pyncm.py --redownload   # 重下已有 .lrc 的
    ./scripts/download-lyrics-pyncm.py --search-api pyncm  # 强制纯 pyncm 串行搜索
"""

import argparse
import concurrent.futures as cf
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import pyncm
except ImportError:  # pyncm 装在 uv tool venv 里，自动切换到它的解释器重跑
    _candidates = [os.path.expanduser("~/.local/share/uv/tools/pyncm/bin/python")]
    for _py in _candidates:
        if os.path.exists(_py):
            os.execv(_py, [_py] + sys.argv)
    sys.exit("未找到 pyncm 环境，请先运行: uv tool install pyncm")

from pyncm import LoadSessionFromString, SetCurrentSession
from pyncm.apis import cloudsearch, track
from pyncm.utils.lrcparser import LrcParser

AIDJ_CFG = Path(os.path.expanduser("~/.config/LinuxCockpit/aidj/config.json"))
CRED = Path(os.path.expanduser("~/Apps/ncm_info"))
DEFAULT_OUT = Path(os.path.expanduser("~/Desktop/yrc"))
NCM_BASE = os.environ.get("NCM_BASE_URL", "http://127.0.0.1:3000")
MUSIC_DIR = Path(os.path.expanduser("~/Apps/Music"))

AUDIO_EXTS = {
    ".mp3",
    ".flac",
    ".m4a",
    ".aac",
    ".ogg",
    ".opus",
    ".wav",
    ".wma",
    ".ncm",
}

# ---------------------------------------------------------------------------
# 网易云搜索接口有粗暴限流（并发必 460/405「操作频繁」，IP/会话级封几分钟）。
# 无论哪个后端都必须：串行 + 限速 + 遇风控长冷却重试。pyncm 登录态会话恢复
# 快，node API 匿名会话封得久，所以默认走 pyncm 串行，node API 仅作加速选项。
# ---------------------------------------------------------------------------
_search_lock = threading.Lock()
_search_last = 0.0
_SEARCH_MIN_INTERVAL = 0.8  # 两次搜索的最小间隔 (s)
_SEARCH_RETRIES = 5  # 风控后最多重试次数
_SEARCH_COOLDOWN = 30  # 风控冷却 (s)，每次重试前等待

_started_server = False
_server_proc: subprocess.Popen | None = None


def load_session() -> None:
    if not CRED.exists():
        sys.exit(f"找不到登录态文件: {CRED}")
    SetCurrentSession(LoadSessionFromString(CRED.read_text("utf-8")))


def library_folders() -> list[Path]:
    cfg = {}
    if AIDJ_CFG.exists():
        try:
            cfg = json.loads(AIDJ_CFG.read_text("utf-8"))
        except Exception as e:  # noqa: BLE001
            print(f"警告: 解析 {AIDJ_CFG} 失败 ({e})")
    folders = cfg.get("music_folders") or []
    if not folders:
        sys.exit("aidj config 里没有 music_folders，无法枚举曲库")
    return [Path(f).expanduser() for f in folders]


def scan_audio(folders: list[Path]) -> list[Path]:
    files = []
    for base in folders:
        if not base.is_dir():
            print(f"跳过不存在的曲库目录: {base}")
            continue
        for root, _, names in os.walk(base):
            for n in names:
                if Path(n).suffix.lower() in AUDIO_EXTS:
                    files.append(Path(root) / n)
    return files


def norm(s: str) -> str:
    return re.sub(r"\s+", "", (s or "").lower())


def likely_mismatch(name: str, song: dict) -> bool:
    n = norm(name)
    title = norm(song.get("name", ""))
    artists = norm("".join(a.get("name", "") for a in song.get("artists") or []))
    title_part = norm(name.split(" - ", 1)[-1])
    if title and title in n:
        return False
    if title and title_part and (title in title_part or title_part in title):
        return False
    if artists and artists in n:
        return False
    return True


# -- 搜索：本地 node API -------------------------------------------------------
def ncm_health() -> bool:
    """真做一次搜索，body code==200 才算可用（405=被网易云限流）。"""
    try:
        with urllib.request.urlopen(f"{NCM_BASE}/search?keywords=test&limit=1", timeout=5) as r:
            d = json.loads(r.read())
        return d.get("code") == 200
    except Exception:
        return False


def start_ncm_server() -> bool:
    global _started_server, _server_proc
    if not MUSIC_DIR.joinpath("app.js").exists():
        return False
    print(f"启动本地网易云 API: node {MUSIC_DIR}/app.js …")
    try:
        _server_proc = subprocess.Popen(
            ["node", "app.js"],
            cwd=str(MUSIC_DIR),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        _started_server = True
    except Exception as e:  # noqa: BLE001
        print(f"  启动失败: {e}")
        return False
    for _ in range(12):
        time.sleep(1)
        if ncm_health():
            return True
    return False


def ncm_search(query: str) -> dict | None:
    url = f"{NCM_BASE}/search?keywords={urllib.parse.quote(query)}&limit=1"
    for attempt in range(_SEARCH_RETRIES):
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                d = json.loads(r.read())
        except Exception:
            d = {}
        songs = (d.get("result") or {}).get("songs") or []
        if songs:
            return songs[0]
        if d.get("code") == 200:
            return None  # 真没搜到
        if attempt < _SEARCH_RETRIES - 1:
            time.sleep(_SEARCH_COOLDOWN)  # 405/460 风控 → 冷却
    return None


# -- 搜索：pyncm（必须串行） ----------------------------------------------------
def pyncm_search(query: str) -> dict | None:
    global _search_last
    for attempt in range(_SEARCH_RETRIES):
        with _search_lock:
            wait = _search_last + _SEARCH_MIN_INTERVAL - time.time()
            if wait > 0:
                time.sleep(wait)
            try:
                res = cloudsearch.GetSearchResult(query, stype=cloudsearch.SONG, limit=5)
            except Exception:
                res = {}
            _search_last = time.time()
        songs = (res.get("result") or {}).get("songs") or []
        if songs:
            return songs[0]
        if res.get("code") == 200:
            return None  # 真无此歌，不重试
        if attempt < _SEARCH_RETRIES - 1:
            print(f"    搜索被限流 (code={res.get('code')})，冷却 {_SEARCH_COOLDOWN}s 后重试…", flush=True)
            time.sleep(_SEARCH_COOLDOWN)
    return None


# -- 搜索统一入口 ---------------------------------------------------------------
_search_mode = "auto"


def ensure_search(args) -> str:
    global _search_mode
    if args.search_api != "auto":
        _search_mode = args.search_api
    elif ncm_health():
        _search_mode = "ncm"
    elif start_ncm_server() and ncm_health():
        _search_mode = "ncm"
    else:
        _search_mode = "pyncm"
    print(
        f"搜索方式: {'本地 NCM API' if _search_mode == 'ncm' else 'pyncm 串行 (限速·最稳)'}"
        "（网易云搜索有风控，均已加冷却重试）"
    )
    return _search_mode


def search_song(query: str) -> dict | None:
    if _search_mode == "ncm":
        return ncm_search(query)
    return pyncm_search(query)


# -- 歌词（pyncm 登录态，可并发） -----------------------------------------------
def fetch_lyrics(song_id) -> dict:
    last = {}
    for attempt in range(3):
        try:
            d = track.GetTrackLyricsNew(song_id)
            if d and d.get("code") == 200:
                return d
            last = d or {}
        except Exception as e:  # noqa: BLE001
            last = {"error": str(e)}
        time.sleep(2 ** attempt)
    return last


def write_lrc(name: str, dLyrics: dict, outdir: Path) -> bool:
    lrc = LrcParser()
    for k in {"lrc", "tlyric", "romalrc"}:
        blob = dLyrics.get(k)
        if blob and blob.get("lyric"):
            lrc.LoadLrc(blob["lyric"])
    text = lrc.DumpLyrics()
    if not text:
        return False
    (outdir / f"{name}.lrc").write_text(text, encoding="utf-8")
    return True


def write_yrc(name: str, dLyrics: dict, outdir: Path) -> bool:
    yrc = dLyrics.get("yrc")
    if not yrc or not yrc.get("lyric"):
        return False
    (outdir / f"{name}.yrc").write_text(yrc["lyric"], encoding="utf-8")
    return True


def log_failed(failed: Path, line: str) -> None:
    with open(failed, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def process_song(audio: Path, outdir: Path, redownload: bool, failed: Path):
    name = audio.stem
    lrc_path = outdir / f"{name}.lrc"
    if not redownload and lrc_path.exists():
        return ("skip", name)

    query = name
    song = search_song(query)
    if not song and " - " in name:
        song = search_song(name.split(" - ", 1)[1])  # 退回歌名部分
    if not song:
        log_failed(failed, f"{name}\t未搜索到")
        return ("no-hit", name)

    dLyrics = fetch_lyrics(song["id"])
    if not dLyrics or dLyrics.get("code") != 200:
        log_failed(failed, f"{name}\t拉取歌词失败 (id={song['id']}) {dLyrics.get('error', '')}")
        return ("failed", name)

    has_lrc = write_lrc(name, dLyrics, outdir)
    has_yrc = write_yrc(name, dLyrics, outdir)
    if not has_lrc:
        log_failed(failed, f"{name}\t无歌词 (id={song['id']})")
        return ("no-lyric", name)

    if likely_mismatch(name, song):
        print(f"   ? 低置信度: 「{name}」→「{song.get('name')}」")
        log_failed(failed, f"{name}\t低置信度: → {song.get('name')} (id={song['id']})")

    return ("yrc" if has_yrc else "lrc", name)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"输出目录 (默认 {DEFAULT_OUT})")
    ap.add_argument("--workers", type=int, default=6, help="歌词下载并发 (默认 6)")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 首，0=全部 (默认 0)")
    ap.add_argument("--redownload", action="store_true", help="重下已存在 .lrc 的歌")
    ap.add_argument(
        "--search-api",
        choices=["auto", "ncm", "pyncm"],
        default="auto",
        help="搜索后端: auto=node API 可用则用否则 pyncm 串行 (默认 auto); 推荐 pyncm",
    )
    args = ap.parse_args()

    load_session()
    ensure_search(args)
    folders = library_folders()
    files = scan_audio(folders)
    if args.limit:
        files = files[: args.limit]
    print(f"曲库 {len(folders)} 个目录，共 {len(files)} 首待处理 → {args.out}")

    args.out.mkdir(parents=True, exist_ok=True)
    failed = args.out / "_failed.tsv"
    if args.redownload and failed.exists():
        failed.unlink()

    counts = {"skip": 0, "yrc": 0, "lrc": 0, "no-lyric": 0, "no-hit": 0, "failed": 0}
    done = 0
    with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(process_song, f, args.out, args.redownload, failed): f for f in files}
        for fut in cf.as_completed(futs):
            try:
                kind, name = fut.result()
            except Exception as e:  # noqa: BLE001
                kind, name = "failed", futs[fut].name
                print(f"   ✗ {name}: {e}")
            counts[kind] += 1
            done += 1
            if done % 50 == 0 or done == len(files):
                print(f"  [{done}/{len(files)}] ok={counts['yrc'] + counts['lrc']} "
                      f"skip={counts['skip']} 无歌词={counts['no-lyric']} "
                      f"未命中={counts['no-hit']} 失败={counts['failed']}")

    if _started_server and _server_proc:
        print("停止本次脚本拉起的网易云 API 服务…")
        try:
            _server_proc.terminate()
            _server_proc.wait(timeout=5)
        except Exception:
            _server_proc.kill()

    print("\n完成:")
    print(f"  {counts['yrc']} 首含逐词 yrc")
    print(f"  {counts['lrc']} 首仅普通 lrc")
    print(f"  {counts['skip']} 首已存在跳过")
    print(f"  {counts['no-lyric']} 首无歌词 / {counts['no-hit']} 首未搜索到 / {counts['failed']} 首失败")
    print(f"  需人工复查的条目: {failed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
