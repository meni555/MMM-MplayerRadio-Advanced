#!/usr/bin/env python3
"""Long-running stream resolver for ytcast (JSON lines over stdin/stdout).

Request:  {"id": 1, "video": "dQw4w9WgXcQ"}
Response: {"id": 1, "url": "...", "title": "...", "artist": "...", "duration": 212, "thumbnail": "..."}
          {"id": 1, "error": "..."}

Why a separate process instead of running yt-dlp per title: starting Python and importing yt-dlp takes several
seconds on a Raspberry Pi. Here it happens once; the player JS and results are cached. Several requests run in
parallel (prefetching the next title does not block the current one).
"""
import json, os, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
import yt_dlp

TTL = 4 * 3600          # YouTube stream URLs expire after about 6 h
_cache, _lock, _out = {}, threading.Lock(), threading.Lock()

OPTS = {
    "quiet": True, "no_warnings": True, "noplaylist": True, "skip_download": True,
    # audio only, Opus preferred (smaller, mpv plays it directly)
    "format": "bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio/best",
    # since 2025 YouTube needs a JS runtime for the signatures; Node is in the container
    "js_runtimes": {"node": {}},
    "socket_timeout": 10,
    "source_address": "0.0.0.0",  # IPv4 only (many home networks have no working IPv6 route)
}
_local = threading.local()  # YoutubeDL is not thread-safe -> one instance per thread

def _ydl():
    if not hasattr(_local, "ydl"):
        _local.ydl = yt_dlp.YoutubeDL(OPTS)
    return _local.ydl

def resolve(video_id):
    now = time.time()
    with _lock:
        hit = _cache.get(video_id)
        if hit and now - hit[0] < TTL:
            return hit[1]
    info = _ydl().extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    res = {
        "url": info["url"],
        "title": info.get("track") or info.get("title") or video_id,
        "artist": info.get("artist") or info.get("creator") or info.get("uploader") or "",
        "album": info.get("album") or "",
        "duration": info.get("duration") or 0,
        "thumbnail": info.get("thumbnail") or "",
    }
    with _lock:
        _cache[video_id] = (now, res)
        for k in [k for k, v in _cache.items() if now - v[0] > TTL]:
            _cache.pop(k, None)
    return res

def handle(req):
    try:
        out = {"id": req["id"], **resolve(req["video"])}
    except Exception as e:  # noqa: BLE001 - errors are returned as a response
        out = {"id": req["id"], "error": str(e).splitlines()[0][:300]}
    with _out:
        sys.stdout.write(json.dumps(out) + "\n"); sys.stdout.flush()

pool = ThreadPoolExecutor(max_workers=3)

# warm-up: load the player JS and solve the signature once, so the first real cast starts quickly
WARMUP = os.environ.get("WARMUP_VIDEO", "jNQXAC9IVRw")
if WARMUP:
    def _warm():
        t = time.time()
        try:
            resolve(WARMUP); print(f"[resolver] warmed up in {time.time()-t:.1f}s", file=sys.stderr, flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[resolver] warm-up failed: {e}", file=sys.stderr, flush=True)
    pool.submit(_warm)
for line in sys.stdin:
    line = line.strip()
    if line:
        pool.submit(handle, json.loads(line))
