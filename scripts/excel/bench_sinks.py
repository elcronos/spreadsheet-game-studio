#!/usr/bin/env python3
"""Benchmark the native-spreadsheet bridge end to end (real measurements).

For every (sink, strategy) a real bridge process is started
(``python -m sgs_bridge``); for every resolution and update mode the Node
client (renderers/excel/node-client.ts: real FramePipeline + real
ExcelBridgeBackend over a real WebSocket) streams frames as fast as acks
allow. Results go to renderers/excel/bench/results.json and a Markdown table
is printed (copied into references/excel-backend.md).

    python3 scripts/excel/bench_sinks.py                 # mock + calc-uno, all resolutions
    python3 scripts/excel/bench_sinks.py --sinks mock --resolutions 80x45,160x90
    python3 scripts/excel/bench_sinks.py --sinks excel-com   # on Windows with Excel (see native_test.py)
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BRIDGE_DIR = os.path.join(ROOT, "renderers", "excel", "bridge")
CLIENT = os.path.join("renderers", "excel", "node-client.ts")
DEFAULT_OUT = os.path.join(ROOT, "renderers", "excel", "bench", "results.json")


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def wait_port(port: int, timeout: float) -> bool:
    t = time.monotonic() + timeout
    while time.monotonic() < t:
        try:
            with socket.create_connection(("127.0.0.1", port), 0.3):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def environment(sinks: List[str]) -> Dict[str, Any]:
    env: Dict[str, Any] = {
        "os": platform.platform(), "python": platform.python_version(), "machine": platform.machine(),
        "cpus": os.cpu_count(),
    }
    try:
        with open("/proc/cpuinfo") as fh:
            for line in fh:
                if line.startswith("model name"):
                    env["cpu"] = line.split(":", 1)[1].strip()
                    break
        with open("/proc/meminfo") as fh:
            env["memGB"] = round(int(fh.readline().split()[1]) / 1048576, 1)
    except OSError:
        pass
    try:
        env["node"] = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
    except OSError:
        pass
    if "calc-uno" in sinks and shutil.which("soffice"):
        env["libreoffice"] = subprocess.run(["soffice", "--version"], capture_output=True, text=True).stdout.strip()
        env["libreofficeMode"] = "headless (no window, no repaint cost)"
    env["excel"] = "not available in this environment - native Excel numbers UNVERIFIED" if not any(s.startswith("excel") for s in sinks) else "see sink results"
    return env


def start_bridge(sink: str, strategy: str, port: int, log_path: str, extra: List[str]) -> subprocess.Popen:
    args = [sys.executable, "-m", "sgs_bridge", "--sink", sink, "--strategy", strategy, "--port", str(port), *extra]
    if sink == "calc-uno":
        args += ["--uno-port", str(free_port())]
    logf = open(log_path, "a")
    return subprocess.Popen(args, cwd=BRIDGE_DIR, stdout=logf, stderr=subprocess.STDOUT)


def stop_bridge(p: subprocess.Popen) -> None:
    if p.poll() is None:
        p.send_signal(signal.SIGINT if os.name != "nt" else signal.CTRL_C_EVENT)
        try:
            p.wait(30)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait(5)


def run_client(port: int, res: str, mode: str, scene: str, frames: int, max_s: float, label: str, timeout: float) -> Optional[Dict[str, Any]]:
    out = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
    cmd = ["node", "--import", "tsx", CLIENT, "--url", f"ws://127.0.0.1:{port}/sgs", "--res", res, "--mode", mode, "--scene", scene,
           "--frames", str(frames), "--max-seconds", str(max_s), "--label", label, "--out", out]
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"label": label, "error": f"timeout after {timeout}s"}
    if p.returncode != 0:
        return {"label": label, "error": (p.stderr or p.stdout).strip()[-500:]}
    with open(out) as fh:
        r = json.load(fh)
    os.unlink(out)
    return r


def md_table(results: List[Dict[str, Any]]) -> str:
    head = "| sink | strategy | res | mode | scene | changed % | apply ms med | apply ms p95 | ack ms med | FPS | cells/frame | calls/frame | bytes/frame |\n|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"
    lines = [head]
    for r in results:
        if "error" in r:
            lines.append(f"| {r.get('sink', '?')} | {r.get('strategy', '?')} | {r.get('resolution', '?')} | {r.get('mode', '?')} | {r.get('scene', '?')} | error: {r['error'][:60]} |||||||||")
            continue
        lines.append(
            f"| {r['sink']} | {r['strategy']} | {r['resolution']} | {r['mode']} | {r['scene']} | {r['changedCellsPct']:.1f} | {r['applyMs']['median']:.2f} | {r['applyMs']['p95']:.2f} | "
            f"{r['ackLatencyMs']['median']:.2f} | {r['fps']:.1f} | {r['cellsWritten']['mean']:.0f} | {r['calls']['mean']:.1f} | {r['bytesPerFrame']['mean']:.0f} |"
        )
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sinks", default="mock,calc-uno")
    ap.add_argument("--strategies", default="values-cf,interior")
    ap.add_argument("--extra-calc-strategies", default="interior-runs", help="extra Calc-only strategies, measured at --extra-resolutions")
    ap.add_argument("--extra-resolutions", default="80x45,160x90,320x180")
    ap.add_argument("--resolutions", default="80x45,160x90,240x135,320x180,480x270")
    ap.add_argument("--modes", default="full:pan,diff:pan,diff:drive", help="mode:scene list (full = keyframe every frame)")
    ap.add_argument("--frames-diff", type=int, default=90)
    ap.add_argument("--frames-full", type=int, default=40)
    ap.add_argument("--max-seconds", type=float, default=8.0, help="per configuration")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--bridge-args", default="", help="extra args for every bridge (e.g. --workbook for excel sinks)")
    a = ap.parse_args(argv)
    sinks = [s for s in a.sinks.split(",") if s]
    if "calc-uno" in sinks:
        try:
            import uno  # noqa: F401
        except ImportError:
            print("calc-uno: python uno module not importable - skipping", file=sys.stderr)
            sinks.remove("calc-uno")
    res_list = [r for r in a.resolutions.split(",") if r]
    modes = [m for m in a.modes.split(",") if m]
    results: List[Dict[str, Any]] = []
    t_all = time.monotonic()
    log_path = os.path.join(tempfile.gettempdir(), "sgs_bench_bridge.log")
    for sink in sinks:
        strategies = [s for s in a.strategies.split(",") if s]
        plan = [(s, res_list) for s in strategies]
        if sink == "calc-uno":
            plan += [(s, [r for r in a.extra_resolutions.split(",") if r]) for s in a.extra_calc_strategies.split(",") if s]
        for strategy, resolutions in plan:
            port = free_port()
            p = start_bridge(sink, strategy, port, log_path, a.bridge_args.split())
            if not wait_port(port, 60):
                print(f"{sink}/{strategy}: bridge did not start (see {log_path})", file=sys.stderr)
                stop_bridge(p)
                continue
            try:
                for res in resolutions:
                    for ms in modes:
                        mode, _, scene = ms.partition(":")
                        scene = scene or "pan"
                        frames = a.frames_full if mode == "full" else a.frames_diff
                        label = f"{sink}/{strategy}/{res}/{mode}/{scene}"
                        t = time.monotonic()
                        r = run_client(port, res, mode, scene, frames, a.max_seconds, label, timeout=a.max_seconds * 6 + 90)
                        r.setdefault("sink", sink)
                        r.setdefault("resolution", res)
                        r.setdefault("mode", mode)
                        r["strategyRequested"] = strategy
                        if r.get("strategy") in (None, "?"):
                            r["strategy"] = strategy
                        r["verified"] = not sink.startswith("excel")
                        results.append(r)
                        if "error" in r:
                            print(f"{label}: ERROR {r['error'][:200]}", flush=True)
                        else:
                            print(f"{label}: apply med {r['applyMs']['median']:.2f} ms p95 {r['applyMs']['p95']:.2f} ms, {r['fps']:.1f} FPS, {r['cellsWritten']['mean']:.0f} cells, {r['calls']['mean']:.1f} calls, {r['bytesPerFrame']['mean']:.0f} B ({time.monotonic() - t:.1f}s)", flush=True)
            finally:
                stop_bridge(p)
    doc = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "tool": "scripts/excel/bench_sinks.py",
        "method": "Node client (real FramePipeline fixed64 + ExcelBridgeBackend) -> WebSocket -> python -m sgs_bridge -> sink; one frame in flight; next frame sent on ack. applyMs = bridge-side decode+plan+sink write; ack latency = client round trip.",
        "scenes": {"pan": "camera pans 1.5 cells/frame over skyline + road + 6 moving cars (changes spread over the frame)", "drive": "static camera, scrolling lane dashes + 6 moving cars (localised changes)"},
        "environment": environment(sinks),
        "nativeExcel": "UNVERIFIED - no Excel in this environment; run renderers/excel/native_test.py on Windows",
        "totalSeconds": round(time.monotonic() - t_all, 1),
        "results": results,
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(doc, fh, indent=1)
    print()
    print(md_table(results))
    print(f"\nwrote {a.out} in {doc['totalSeconds']} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
