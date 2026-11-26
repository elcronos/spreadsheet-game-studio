"""WebSocket bridge server: game (client) -> spreadsheet sink.

    python -m sgs_bridge --sink {excel-xlwings,excel-com,calc-uno,mock,snapshot} \
        --strategy {auto,values-cf,interior} --workbook PATH --port 8765

Listens on ws://127.0.0.1:<port>/sgs. Protocol: references/protocol.md.
"""
from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import contextlib
import logging
import signal
import sys
import time
from typing import Any, Dict, List, Optional

import websockets
from websockets.asyncio.server import ServerConnection, serve

from .layout import Layout, build_layout, hud_lines, minimal_hello
from .protocol import ProtocolError, decode_frame, msg_ack, msg_error, msg_input, msg_ready, parse_text
from .sinks import SINK_NAMES, create_sink
from .sinks.base import Sink, SinkBusy
from .state import FrameState
from .sync import InputTracker, StateSync

log = logging.getLogger("sgs_bridge")


class Bridge:
    def __init__(
        self,
        sink: Sink,
        host: str = "127.0.0.1",
        port: int = 8765,
        path: str = "/sgs",
        poll_ms: float = 250,
        input_poll_ms: float = 50,
        state_interval: float = 0.1,
        hud_interval: float = 0.2,
        sheet_interval: float = 0.5,
        telemetry_interval: float = 0.5,
        input_release_s: float = 0.6,
        global_keys: bool = False,
    ):
        self.sink = sink
        self.host, self.port, self.path = host, port, path
        self.poll_s = poll_ms / 1000
        self.input_poll_s = input_poll_ms / 1000
        self.intervals = {"state": state_interval, "hud": hud_interval, "sheet": sheet_interval, "telemetry": telemetry_interval}
        self.executor = concurrent.futures.ThreadPoolExecutor(1, thread_name_prefix="sgs-sink", initializer=sink.thread_init)
        self.client: Optional[ServerConnection] = None
        self.layout: Optional[Layout] = None
        self.frames: Optional[FrameState] = None
        self.sync: Optional[StateSync] = None
        self.info: Dict[str, Any] = {}
        self.ops: Optional[asyncio.Queue] = None
        self.pending: Dict[str, Any] = {}
        self.pending_sheets: Dict[str, Dict[str, Any]] = {}
        self.last_write: Dict[str, float] = {}
        self.inputs = InputTracker(input_release_s)
        self.global_keys = global_keys
        self.key_capture = None
        self.stats = {"frames": 0, "acks": 0, "coalesced": 0, "busy": 0, "edits": 0, "errors": 0, "connections": 0}
        self.ready_event = asyncio.Event()
        self.stopping = asyncio.Event()
        self._server = None
        self._tasks: List[asyncio.Task] = []
        self.opened = False
        self.last_apply: Dict[str, Any] = {}

    # ---- helpers ---------------------------------------------------------------
    async def call(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(self.executor, fn, *args)

    async def send(self, msg: str) -> None:
        ws = self.client
        if ws is None:
            return
        with contextlib.suppress(websockets.ConnectionClosed):
            await ws.send(msg)

    # ---- lifecycle ---------------------------------------------------------------
    async def start(self) -> None:
        if not self.opened:
            self.info = await self.call(self.sink.open) or {}
            self.opened = True
        self._server = await serve(self.handler, self.host, self.port, max_size=32 * 1024 * 1024, compression=None, ping_interval=20, ping_timeout=60)
        if self.port == 0:
            self.port = self._server.sockets[0].getsockname()[1]
        loop = asyncio.get_running_loop()
        self._tasks = [loop.create_task(self._writer_loop()), loop.create_task(self._poll_loop()), loop.create_task(self._input_loop())]
        if self.global_keys:
            from .input_capture import start_global_capture

            self.key_capture = start_global_capture(lambda: self.layout, lambda a, d: asyncio.run_coroutine_threadsafe(self.send(msg_input(a, d)), loop))
        self.ready_event.set()
        log.info("listening on ws://%s:%d%s (sink=%s strategy=%s)", self.host, self.port, self.path, self.sink.name, self.sink.strategy)

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        if self.key_capture is not None:
            with contextlib.suppress(Exception):
                self.key_capture.stop()
        if self.client is not None:
            with contextlib.suppress(Exception):
                await self.client.close(1001, "bridge shutting down")
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._server.wait_closed(), 3)
        with contextlib.suppress(Exception):
            if self.layout is not None:
                await self.call(self.sink.write_status, "BRIDGE STOPPED")
        with contextlib.suppress(Exception):
            await self.call(self.sink.save)
        with contextlib.suppress(Exception):
            await self.call(self.sink.close)
        self.executor.shutdown(wait=True)

    async def serve_forever(self) -> None:
        await self.start()
        try:
            await self.stopping.wait()
        finally:
            await self.stop()

    # ---- connection ---------------------------------------------------------------
    async def handler(self, ws: ServerConnection) -> None:
        path = ws.request.path if ws.request else "/"
        if path.split("?")[0] != self.path:
            await ws.close(4404, f"use {self.path}")
            return
        old = self.client
        if old is not None:
            with contextlib.suppress(Exception):
                await old.send(msg_error("replaced by a new game connection"))
                await old.close(4000, "replaced")
        self.client = ws
        self.stats["connections"] += 1
        ops: asyncio.Queue = asyncio.Queue()
        self.ops = ops
        worker = asyncio.get_running_loop().create_task(self._ops_worker(ws, ops))
        log.info("game connected from %s", ws.remote_address)
        try:
            async for msg in ws:
                if isinstance(msg, (bytes, bytearray, memoryview)):
                    ops.put_nowait(("frame", bytes(msg), time.perf_counter()))
                    continue
                try:
                    m = parse_text(msg)
                except ProtocolError as e:
                    await self.send(msg_error(str(e)))
                    continue
                t = m["t"]
                if t == "hello":
                    ops.put_nowait(("hello", m, 0.0))
                elif t == "state":
                    p = self.pending.setdefault("state", {"values": {}, "rules": []})
                    p["values"].update(m.get("values") or {})
                    if m.get("rules") is not None:
                        p["rules"] = m["rules"]
                elif t == "hud":
                    self.pending["hud"] = m
                elif t == "sheet":
                    if m.get("name"):
                        self.pending_sheets[str(m["name"]).upper()] = m
                elif t == "telemetry":
                    tel = self.pending.setdefault("telemetry", {})
                    tel.update({k: v for k, v in m.items() if k != "t"})
                elif t == "bye":
                    log.info("game said bye")
                    ops.put_nowait(("bye", None, 0.0))
                    break
                else:
                    await self.send(msg_error(f"unknown message type {t!r}"))
        except websockets.ConnectionClosed:
            pass
        finally:
            ops.put_nowait(("stop", None, 0.0))
            with contextlib.suppress(Exception):
                await worker
            if self.client is ws:
                self.client = None
                self.ops = None
                if self.layout is not None:
                    with contextlib.suppress(Exception):
                        await self.call(self.sink.write_status, f"DISCONNECTED - waiting for game on ws://{self.host}:{self.port}{self.path}")
                log.info("game disconnected")

    async def _ops_worker(self, ws: ServerConnection, ops: asyncio.Queue) -> None:
        """Applies hello and frames strictly in arrival order; coalesces queued frames."""
        while True:
            kind, payload, t_recv = await ops.get()
            if kind == "stop":
                return
            if kind == "bye":
                if hasattr(self.sink, "dump"):
                    await self.call(self.sink.dump)
                continue
            if kind == "hello":
                try:
                    await self._do_hello(payload)
                except Exception as e:  # report, keep connection
                    log.exception("hello failed")
                    self.stats["errors"] += 1
                    await self.send(msg_error(f"layout failed: {e}"))
                continue
            # frames: drain everything already queued (coalescing), stop at a non-frame op
            batch = [(payload, t_recv)]
            requeue = None
            while not ops.empty():
                item = ops.get_nowait()
                if item[0] == "frame":
                    batch.append((item[1], item[2]))
                else:
                    requeue = item
                    break
            await self._do_frames(batch)
            if requeue is not None:
                # put back in front: process right away
                if requeue[0] == "stop":
                    return
                if requeue[0] == "hello":
                    try:
                        await self._do_hello(requeue[1])
                    except Exception as e:
                        await self.send(msg_error(f"layout failed: {e}"))
                elif requeue[0] == "bye" and hasattr(self.sink, "dump"):
                    await self.call(self.sink.dump)

    async def _do_hello(self, hello: Dict[str, Any]) -> None:
        lay = build_layout(hello)
        self._hello_cache = {k: v for k, v in hello.items() if k != "t"}
        for w in lay.warnings:
            log.warning("%s", w)
        def job():
            self.sink.layout(lay)
            return StateSync(self.sink, lay)  # primes from the freshly written cells (worker thread)

        self.sync = None
        sync = await self.call(job)
        self.layout = lay
        self.frames = FrameState(lay.width, lay.height, lay.palette)
        self.sync = sync
        self.inputs = InputTracker(self.inputs.release_s)
        info = dict(self.info)
        extra = {k: v for k, v in info.items() if k != "excelVersion"}
        await self.send(msg_ready(self.sink.name, self.sink.strategy, info.get("excelVersion"), width=lay.width, height=lay.height, origin={"col": lay.origin_col0, "row": lay.origin_row0}, warnings=lay.warnings, **extra))
        log.info("layout ready %dx%d", lay.width, lay.height)

    async def _do_frames(self, batch) -> None:
        t0 = batch[0][1]
        ids: List[int] = []
        nbytes = 0
        for buf, _t in batch:
            try:
                f = decode_frame(buf)
            except ProtocolError as e:
                self.stats["errors"] += 1
                await self.send(msg_error(f"bad frame: {e}"))
                continue
            if self.frames is None or (f.width, f.height) != (self.frames.width, self.frames.height):
                # frames before hello, or size changed without hello: lay out from the frame itself
                pal = f.palette.tolist() if f.palette is not None else (self.layout.palette if self.layout else [])
                base = dict(self._last_hello_or(f.width, f.height, pal))
                base.update(width=f.width, height=f.height)
                if f.palette is not None:
                    base["palette"] = pal
                await self._do_hello(base)
            try:
                self.frames.apply(f)
            except ProtocolError as e:
                await self.send(msg_error(str(e)))
                continue
            ids.append(f.frame_id)
            nbytes += f.nbytes
        if not ids:
            return
        self.stats["frames"] += len(ids)
        self.stats["coalesced"] += len(ids) - 1
        busy = False
        try:
            res = await self.call(self.sink.apply_frame, self.frames)
            cells, calls, detail = res.cells, res.calls, res.detail
        except SinkBusy as e:
            busy = True
            self.stats["busy"] += 1
            cells, calls, detail = 0, 0, {"busy": str(e)}
        except Exception as e:
            log.exception("frame apply failed")
            self.stats["errors"] += 1
            await self.send(msg_error(f"frame apply failed: {e}"))
            cells, calls, detail = 0, 0, {}
        apply_ms = (time.perf_counter() - t0) * 1000
        self.last_apply = {"applyMs": apply_ms, "cells": cells, "calls": calls, **detail}
        for fid in ids[:-1]:
            await self.send(msg_ack(fid, apply_ms, 0, 0, coalesced=True))
        extra: Dict[str, Any] = {"bytes": nbytes}
        if busy:
            extra["busy"] = True
        if len(ids) > 1:
            extra["merged"] = len(ids)
        await self.send(msg_ack(ids[-1], apply_ms, cells, calls, **extra))
        self.stats["acks"] += len(ids)

    def _last_hello_or(self, w: int, h: int, pal) -> Dict[str, Any]:
        return getattr(self, "_hello_cache", None) or minimal_hello(w, h, pal)

    # ---- periodic jobs -------------------------------------------------------------
    def _due(self, kind: str, now: float) -> bool:
        return now - self.last_write.get(kind, 0.0) >= self.intervals[kind]

    async def _writer_loop(self) -> None:
        while True:
            await asyncio.sleep(0.02)
            if self.layout is None or self.sync is None:
                continue
            now = time.monotonic()
            try:
                if "state" in self.pending and self._due("state", now):
                    st = self.pending.pop("state")
                    self.last_write["state"] = now
                    msgs = await self.call(self.sync.push, st["values"], st.get("rules") or [])
                    for m in msgs:
                        self.stats["edits"] += 1
                        await self.send(m)
                if "hud" in self.pending and self._due("hud", now):
                    hud = self.pending.pop("hud")
                    self.last_write["hud"] = now
                    l1, l2 = hud_lines(hud)
                    await self.call(self.sink.write_hud, l1, l2)
                if self.pending_sheets and self._due("sheet", now):
                    self.last_write["sheet"] = now
                    sheets, self.pending_sheets = self.pending_sheets, {}
                    for name, m in sheets.items():
                        await self.call(self.sink.write_sheet, name, list(m.get("columns") or []), list(m.get("rows") or []))
                if "telemetry" in self.pending and self._due("telemetry", now):
                    tel = self.pending.pop("telemetry")
                    self.last_write["telemetry"] = now
                    items = [(k, v) for k, v in tel.items() if isinstance(v, (int, float, str, bool))]
                    items.append(("bridge.frames", self.stats["frames"]))
                    items.append(("bridge.coalesced", self.stats["coalesced"]))
                    items.append(("bridge.busy", self.stats["busy"]))
                    if self.last_apply:
                        items.append(("bridge.applyMs", round(self.last_apply.get("applyMs", 0), 2)))
                    await self.call(self.sink.write_telemetry, items)
            except asyncio.CancelledError:
                raise
            except SinkBusy:
                pass
            except Exception as e:
                log.exception("state write failed")
                await self.send(msg_error(f"state write failed: {e}"))

    async def _poll_loop(self) -> None:
        while True:
            await asyncio.sleep(self.poll_s)
            if self.sync is None or self.client is None:
                continue
            try:
                msgs = await self.call(self.sync.poll)
            except asyncio.CancelledError:
                raise
            except SinkBusy:
                continue
            except Exception as e:
                log.warning("poll failed: %s", e)
                continue
            for m in msgs:
                self.stats["edits"] += 1
                await self.send(m)

    async def _input_loop(self) -> None:
        while True:
            await asyncio.sleep(self.input_poll_s)
            if self.layout is None or self.client is None:
                continue
            try:
                counts = await self.call(self.sink.read_input)
            except asyncio.CancelledError:
                raise
            except Exception:
                continue
            for action, down in self.inputs.update(counts, time.monotonic()):
                await self.send(msg_input(action, down))


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m sgs_bridge", description="Spreadsheet Game Studio native spreadsheet bridge")
    p.add_argument("--sink", choices=SINK_NAMES, default="mock")
    p.add_argument("--strategy", choices=["auto", "values-cf", "interior", "interior-runs"], default="auto", help="interior-runs: Calc only, one call per rectangle (benchmark)")
    p.add_argument("--workbook", default=None, help="workbook to attach to / create (xlsx). snapshot: output path")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--path", default="/sgs")
    p.add_argument("--poll-ms", type=float, default=250)
    p.add_argument("--input-release-ms", type=float, default=600, help="VBA OnKey has no key-up: release after this long without repeats")
    p.add_argument("--global-keys", action="store_true", help="capture keys system-wide with pynput (Windows/macOS) and forward as input")
    p.add_argument("--uno-host", default="127.0.0.1")
    p.add_argument("--uno-port", type=int, default=2002)
    p.add_argument("--no-spawn-soffice", action="store_true", help="calc-uno: connect to an already running soffice")
    p.add_argument("--visible", action="store_true", help="calc-uno: show the Calc window (needs a desktop)")
    p.add_argument("--mock-dump", default=None, help="mock: write sink state JSON here on bye/shutdown")
    p.add_argument("--mock-call-ms", type=float, default=0.0, help="mock: simulated latency per call")
    p.add_argument("--snapshot-every", type=float, default=2.0, help="snapshot: min seconds between .xlsx writes")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def sink_from_args(a: argparse.Namespace) -> Sink:
    kw: Dict[str, Any] = {}
    if a.sink == "calc-uno":
        kw = dict(uno_host=a.uno_host, uno_port=a.uno_port, spawn=not a.no_spawn_soffice, visible=a.visible)
    elif a.sink == "mock":
        kw = dict(dump_path=a.mock_dump, call_ms=a.mock_call_ms)
    elif a.sink == "snapshot":
        kw = dict(every_s=a.snapshot_every)
    return create_sink(a.sink, strategy=a.strategy, workbook=a.workbook, **kw)


def main(argv: Optional[List[str]] = None) -> int:
    a = build_arg_parser().parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sink = sink_from_args(a)

    async def run() -> None:
        bridge = Bridge(sink, a.host, a.port, a.path, poll_ms=a.poll_ms, input_release_s=a.input_release_ms / 1000, global_keys=a.global_keys)
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            with contextlib.suppress(NotImplementedError, RuntimeError):
                loop.add_signal_handler(sig, bridge.stopping.set)
        await bridge.serve_forever()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:  # Windows: no add_signal_handler
        log.info("interrupted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
