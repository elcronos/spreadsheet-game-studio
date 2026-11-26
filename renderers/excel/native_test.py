#!/usr/bin/env python3
"""Native spreadsheet integration test + benchmark (run this on Windows with Excel).

NATIVE EXCEL WAS NOT AVAILABLE where this bridge was written; every Excel
number in references/excel-backend.md is UNVERIFIED until this script has been
run on a machine with Excel. It produces the same results.json format as
scripts/excel/bench_sinks.py.

    pip install websockets numpy openpyxl pywin32 xlwings
    python renderers\\excel\\native_test.py                       # excel-com, correctness + benchmark
    python renderers\\excel\\native_test.py --sink excel-xlwings
    python renderers\\excel\\native_test.py --quick               # 80x45 + 160x90 only
    python renderers/excel/native_test.py --sink calc-uno        # same test on LibreOffice (Linux/macOS/Windows)
    python renderers/excel/native_test.py --sink mock            # self-check of this script

1. Correctness: lays out a workbook from tests/excel/fixtures/sample_hello.json,
   renders a known frame with each strategy, reads every GAME cell back from the
   application (value or Interior.Color/CellBackColor) and compares; checks the
   conditional-format rule count, that RULES formulas recalculate from the
   defined names, and that a user edit is detected by the poller.
2. Benchmark: an in-process bridge (real WebSocket on 127.0.0.1) and a Python
   game client that renders a synthetic scene, quantises it to the fixed
   64-colour palette, diffs it and streams SGF1 frames, one in flight, next
   frame on ack. Full-frame and differential modes per resolution.

Keep Excel visible and do not click into it while the benchmark runs (cell
edit mode makes COM calls fail; the bridge then acks frames as busy).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import statistics
import sys
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(HERE, "bridge"))

import numpy as np  # noqa: E402

from sgs_bridge.layout import build_layout  # noqa: E402
from sgs_bridge.protocol import encode_frame, keyframe_runs  # noqa: E402
from sgs_bridge.server import Bridge  # noqa: E402
from sgs_bridge.sinks import create_sink  # noqa: E402
from sgs_bridge.state import FrameState  # noqa: E402
from sgs_bridge.sync import StateSync  # noqa: E402

SAMPLE = os.path.join(ROOT, "tests", "excel", "fixtures", "sample_hello.json")
FIXED64 = [((r * 85) << 16) | ((g * 85) << 8) | (b * 85) for r in range(4) for g in range(4) for b in range(4)]


def load_hello(w: int, h: int) -> Dict[str, Any]:
    with open(SAMPLE) as fh:
        hello = json.load(fh)
    hello.update(width=w, height=h)
    return hello


# ---------------------------------------------------------------------------
# synthetic frames (Python port of node-client.ts "pan"/"drive" scenes, fixed64)

def render(scene: str, w: int, h: int, t: int) -> np.ndarray:
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    horizon = int(h * 0.42)
    pan = t * 1.5 if scene == "pan" else 0.0
    wx = x + pan
    k = y / max(1, horizon)
    r = 70 + 150 * k
    g = 110 + 80 * k
    b = 200 - 90 * k
    bx = np.floor(wx / max(3, w / 24))
    bh = ((bx * 7919) % 11) / 11
    sky = y < horizon
    bld = sky & (y > horizon * (0.25 + 0.6 * (1 - bh)))
    lit = ((np.floor(wx) % 3 == 0) & (y % 3 == 0)).astype(float)
    r = np.where(bld, 45 + 40 * bh + lit * 170, r)
    g = np.where(bld, 40 + 30 * bh + lit * 150, g)
    b = np.where(bld, 70 + 30 * bh + lit * 30, b)
    depth = np.maximum((y - horizon + 1) / max(1, h - horizon), 1e-3)
    half = w * (0.12 + 0.38 * depth)
    cx = w / 2 + (np.sin(t * 0.05) * w * 0.1 if scene == "pan" else 0)
    road = np.abs(x - cx) < half
    scroll = t * 0.35
    dash = road & (np.abs(x - cx) < max(1, w * 0.008)) & (np.floor((1 / depth) * 3 + scroll) % 2 == 0)
    stripe = np.floor((1 / depth) * 2 + scroll * 0.5) % 2 == 0
    gr = np.where(road, np.where(dash, 235, 70), np.where(stripe, 60, 50))
    gg = np.where(road, np.where(dash, 215, 72), np.where(stripe, 150, 130))
    gb = np.where(road, np.where(dash, 90, 80), np.where(stripe, 60, 50))
    r, g, b = np.where(sky, r, gr), np.where(sky, g, gg), np.where(sky, b, gb)
    sw, sh = max(2, round(w * 0.05)), max(2, round(h * 0.06))
    cols = [(220, 40, 40), (40, 120, 230), (240, 200, 30), (250, 250, 250), (30, 30, 30), (200, 60, 200)]
    for s in range(6):
        px = int(((s * 0.17 + t * (0.004 + s * 0.0015)) % 1) * (w - sw))
        py = int(horizon + 2 + ((s * 37) % max(1, h - horizon - sh - 2)))
        r[py:py + sh, px:px + sw], g[py:py + sh, px:px + sw], b[py:py + sh, px:px + sw] = cols[s]
    q = lambda c: np.clip(np.rint(np.clip(c, 0, 255) / 85), 0, 3).astype(np.uint8)  # noqa: E731
    return (q(r) * 16 + q(g) * 4 + q(b)).astype(np.uint8)


def diff_runs(prev: Optional[np.ndarray], cur: np.ndarray, gap: int = 4) -> Tuple[bool, List[Tuple[int, int, int]]]:
    h, w = cur.shape
    if prev is None:
        return True, keyframe_runs(w, h)
    runs = []
    ch = prev != cur
    for y in np.flatnonzero(ch.any(axis=1)):
        xs = np.flatnonzero(ch[y])
        start = last = int(xs[0])
        for x in xs[1:]:
            x = int(x)
            if x - last <= gap:
                last = x
            else:
                runs.append((int(y), start, last - start + 1))
                start = last = x
        runs.append((int(y), start, last - start + 1))
    return False, runs


# ---------------------------------------------------------------------------

def correctness(sink_name: str, strategy: str, workbook: Optional[str]) -> Dict[str, Any]:
    W, H = 24, 10
    rep: Dict[str, Any] = {"sink": sink_name, "strategy": strategy, "checks": {}}
    sink = create_sink(sink_name, strategy=strategy, workbook=workbook)
    sink.thread_init()
    try:
        info = sink.open()
        rep["app"] = info
        lay = build_layout(load_hello(W, H))
        sink.layout(lay)
        rep["strategyUsed"] = sink.strategy
        y, x = np.mgrid[0:H, 0:W]
        idx = ((x * 7 + y * 3) % 64).astype(np.uint8)
        fs = FrameState(W, H, lay.palette)
        from sgs_bridge.protocol import decode_frame

        fs.apply(decode_frame(encode_frame(1, idx, keyframe_runs(W, H), True, lay.palette)))
        t = time.perf_counter()
        res = sink.apply_frame(fs)
        rep["keyframeMs"] = round((time.perf_counter() - t) * 1000, 2)
        pal = np.array(lay.palette, np.int64)
        got = read_back(sink, lay, sink.strategy)
        want = idx.astype(np.int64) if sink.strategy == "values-cf" else pal[idx]
        rep["checks"]["pixelCellsMatch"] = bool(np.array_equal(got, want))
        rep["checks"]["mismatches"] = int((got != want).sum())
        if sink_name.startswith("excel") and sink.strategy == "values-cf":
            rep["checks"]["cfRules"] = len(sink.cf_pos)
        sync = StateSync(sink, lay)
        rep["checks"]["noEchoAfterLayout"] = sync.poll() == []
        bb, al, pr = (lay.vars_by_key[k] for k in ("world.baseBudget", "player.alert", "world.policeResponse"))
        sink.write_values([(bb, 2.0), (al, 3.0), (pr, 1.5)])
        sync.guard.wrote("var:" + bb.key, 2.0, 2.0)
        sync.guard.wrote("var:" + al.key, 3.0, 3)
        sync.guard.wrote("var:" + pr.key, 1.5, 1.5)
        time.sleep(0.2)
        _, rules = sink.read_editables()
        rep["checks"]["policeBudgetRecalc"] = rules["PoliceBudget"][1]
        rep["checks"]["policeBudgetOk"] = rules["PoliceBudget"][1] == 9.0
        # emulate a user edit through the application, then poll
        sink.write_values([(lay.vars_by_key["player.stamina"], 42)])
        out = sync.poll()
        rep["checks"]["userEditDetected"] = any('"player.stamina"' in m for m in out)
        rep["ok"] = all(v is True for k, v in rep["checks"].items() if isinstance(v, bool))
    finally:
        try:
            sink.close()
        except Exception:
            pass
    return rep


def read_back(sink, lay, strategy) -> np.ndarray:
    H, W = lay.height, lay.width
    if sink.name == "mock":
        if strategy == "values-cf":
            return np.nan_to_num(sink.values, nan=-1).astype(np.int64)
        return sink.fills.copy()
    if sink.name == "calc-uno":
        return sink.read_back_values().astype(np.int64) if strategy == "values-cf" else sink.read_back_colors()
    # Excel: through the sink's ops (COM or xlwings)
    ops = sink.ops
    if strategy == "values-cf":
        v = ops.get_values("GAME", lay.frame_range_a1())
        return np.array([[(-1 if c is None else int(c)) for c in row] for row in v], np.int64)
    out = np.zeros((H, W), np.int64)
    from sgs_bridge.planning import bgr_to_rgb

    for yy in range(H):
        for xx in range(W):
            r, c = lay.cell_of_pixel(xx, yy)
            if hasattr(ops, "ws"):
                col = ops.ws("GAME").Cells(r, c).Interior.Color
                out[yy, xx] = bgr_to_rgb(int(col))
            else:
                rgb = ops.sh("GAME").range((r, c)).color
                out[yy, xx] = -1 if rgb is None else (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]
    return out


async def stream(url: str, w: int, h: int, mode: str, scene: str, frames: int, max_s: float, warmup: int = 2) -> Dict[str, Any]:
    import websockets

    async with websockets.connect(url, max_size=None) as ws:
        await ws.send(json.dumps({**load_hello(w, h), "palette": FIXED64, "paletteMode": "fixed64"}))
        ready = None
        while ready is None:
            m = json.loads(await ws.recv())
            if m["t"] == "ready":
                ready = m
        prev = None
        recs = []
        t0 = time.perf_counter()
        t_stats = t0
        for i in range(frames):
            if i == warmup:
                t_stats = time.perf_counter()
            cur = render(scene, w, h, i)
            key, runs = diff_runs(None if mode == "full" else prev, cur)
            changed = w * h if key else int((prev != cur).sum())
            if not runs:
                recs.append({"rtt": 0, "applyMs": 0, "cells": 0, "calls": 0, "bytes": 0, "changed": 0})
                prev = cur
                continue
            buf = encode_frame(i + 1, cur, runs, key, FIXED64 if key else None)
            ts = time.perf_counter()
            await ws.send(buf)
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), 120))
                if m["t"] == "ack" and m["frameId"] == i + 1:
                    break
            recs.append({"rtt": (time.perf_counter() - ts) * 1000, "applyMs": m["applyMs"], "cells": m["cells"], "calls": m["calls"], "bytes": len(buf), "changed": changed, "busy": bool(m.get("busy"))})
            prev = cur
            if time.perf_counter() - t0 > max_s and i >= warmup + 5:
                break
        t_end = time.perf_counter()
        await ws.send(json.dumps({"t": "bye"}))
    st = recs[warmup:]
    p = lambda xs, q: float(np.percentile(xs, q, method="inverted_cdf")) if xs else float("nan")  # noqa: E731
    wall = t_end - t_stats
    return {
        "sink": ready["sink"], "strategy": ready["strategy"], "appVersion": ready.get("excelVersion") or ready.get("appVersion"),
        "resolution": f"{w}x{h}", "width": w, "height": h, "totalCells": w * h, "mode": mode, "scene": scene,
        "framesMeasured": len(st), "warmupFrames": warmup, "wallSeconds": round(wall, 3), "fps": round(len(st) / wall, 3),
        "applyMs": {"median": round(p([r["applyMs"] for r in st], 50), 3), "p95": round(p([r["applyMs"] for r in st], 95), 3), "mean": round(statistics.fmean(r["applyMs"] for r in st), 3)},
        "ackLatencyMs": {"median": round(p([r["rtt"] for r in st], 50), 3), "p95": round(p([r["rtt"] for r in st], 95), 3), "mean": round(statistics.fmean(r["rtt"] for r in st), 3)},
        "cellsWritten": {"median": p([r["cells"] for r in st], 50), "mean": round(statistics.fmean(r["cells"] for r in st), 3)},
        "calls": {"median": p([r["calls"] for r in st], 50), "mean": round(statistics.fmean(r["calls"] for r in st), 3)},
        "bytesPerFrame": {"median": p([r["bytes"] for r in st], 50), "mean": round(statistics.fmean(r["bytes"] for r in st), 3)},
        "changedCellsPct": round(100 * statistics.fmean(r["changed"] for r in st) / (w * h), 3),
        "busyAcks": sum(1 for r in st if r.get("busy")), "droppedFrames": 0, "client": "python (native_test.py)",
    }


class InProcessBridge:
    def __init__(self, sink):
        self.loop = asyncio.new_event_loop()
        self.sink = sink
        self.bridge: Optional[Bridge] = None
        self.started = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        asyncio.set_event_loop(self.loop)

        async def main():
            self.bridge = Bridge(self.sink, port=0)
            await self.bridge.start()
            self.started.set()
            await self.bridge.stopping.wait()
            await self.bridge.stop()

        self.loop.run_until_complete(main())

    def __enter__(self):
        self.thread.start()
        if not self.started.wait(120):
            raise RuntimeError("bridge did not start")
        return f"ws://127.0.0.1:{self.bridge.port}/sgs"

    def __exit__(self, *a):
        self.loop.call_soon_threadsafe(self.bridge.stopping.set)
        self.thread.join(120)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sink", default="excel-com", choices=["excel-com", "excel-xlwings", "calc-uno", "mock"])
    ap.add_argument("--strategies", default="values-cf,interior")
    ap.add_argument("--resolutions", default="80x45,160x90,240x135,320x180,480x270")
    ap.add_argument("--quick", action="store_true", help="80x45 and 160x90 only")
    ap.add_argument("--modes", default="full:pan,diff:pan,diff:drive")
    ap.add_argument("--frames", type=int, default=60)
    ap.add_argument("--max-seconds", type=float, default=10)
    ap.add_argument("--workbook", default=None, help="workbook path (default: a temp .xlsx)")
    ap.add_argument("--skip-bench", action="store_true")
    ap.add_argument("--out", default=os.path.join(HERE, "bench", "results-native.json"))
    a = ap.parse_args(argv)
    if a.quick:
        a.resolutions = "80x45,160x90"
    tmpdir = tempfile.mkdtemp(prefix="sgs_native_")
    wb = a.workbook or (os.path.join(tmpdir, "sgs_native_test.xlsx") if a.sink != "mock" else None)
    strategies = [s for s in a.strategies.split(",") if s]
    report: Dict[str, Any] = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "tool": "renderers/excel/native_test.py",
        "environment": {"os": platform.platform(), "python": platform.python_version(), "machine": platform.machine(), "cpus": os.cpu_count()},
        "correctness": [], "results": [],
    }
    print(f"== correctness ({a.sink}) ==")
    for s in strategies:
        rep = correctness(a.sink, s, wb)
        report["correctness"].append(rep)
        print(json.dumps(rep, default=str))
    if not a.skip_bench:
        print(f"== benchmark ({a.sink}) ==")
        for s in strategies:
            sink = create_sink(a.sink, strategy=s, workbook=wb)
            with InProcessBridge(sink) as url:
                for res in a.resolutions.split(","):
                    w, h = map(int, res.split("x"))
                    for ms in a.modes.split(","):
                        mode, _, scene = ms.partition(":")
                        r = asyncio.run(stream(url, w, h, mode, scene or "pan", a.frames if mode == "diff" else max(10, a.frames // 2), a.max_seconds))
                        r["verified"] = True  # measured on this machine with this application
                        report["results"].append(r)
                        print(f"{a.sink}/{r['strategy']}/{res}/{mode}/{scene}: apply med {r['applyMs']['median']:.1f} ms p95 {r['applyMs']['p95']:.1f} ms, {r['fps']:.1f} FPS, {r['cellsWritten']['mean']:.0f} cells, {r['calls']['mean']:.1f} calls")
    ok = all(c.get("ok") for c in report["correctness"])
    report["ok"] = ok
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(report, fh, indent=1, default=str)
    print(f"\n{'PASS' if ok else 'FAIL'} - wrote {a.out}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
