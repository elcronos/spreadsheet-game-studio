"""Shared helpers for tests/excel (python3 -m unittest discover tests/excel)."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
BRIDGE_DIR = os.path.join(ROOT, "renderers", "excel", "bridge")
if BRIDGE_DIR not in sys.path:
    sys.path.insert(0, BRIDGE_DIR)
FIXTURES = os.path.join(HERE, "fixtures")

from sgs_bridge.server import Bridge  # noqa: E402


def load_hello(width: Optional[int] = None, height: Optional[int] = None) -> Dict[str, Any]:
    with open(os.path.join(FIXTURES, "sample_hello.json")) as fh:
        h = json.load(fh)
    if width:
        h["width"] = width
    if height:
        h["height"] = height
    return h


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class BridgeThread:
    """Runs a Bridge on its own asyncio loop in a background thread."""

    def __init__(self, sink, **kw):
        self.sink = sink
        self.kw = kw
        self.loop = asyncio.new_event_loop()
        self.bridge: Optional[Bridge] = None
        self.thread = threading.Thread(target=self._run, daemon=True)
        self._started = threading.Event()
        self.error: Optional[BaseException] = None

    def _run(self):
        asyncio.set_event_loop(self.loop)

        async def main():
            self.bridge = Bridge(self.sink, port=0, **self.kw)
            try:
                await self.bridge.start()
            except BaseException as e:
                self.error = e
                self._started.set()
                return
            self._started.set()
            await self.bridge.stopping.wait()
            await self.bridge.stop()

        self.loop.run_until_complete(main())
        self.loop.run_until_complete(self.loop.shutdown_asyncgens())

    def __enter__(self):
        self.thread.start()
        self._started.wait(60)
        if self.error:
            raise self.error
        return self

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.bridge.port}/sgs"

    def __exit__(self, *exc):
        if self.bridge is not None:
            self.loop.call_soon_threadsafe(self.bridge.stopping.set)
        self.thread.join(60)
        if not self.thread.is_alive():
            self.loop.close()


class Client:
    """Small async game-side client for tests."""

    def __init__(self, ws):
        self.ws = ws
        self.inbox: List[Dict[str, Any]] = []

    @classmethod
    async def connect(cls, url: str):
        import websockets

        return cls(await websockets.connect(url, max_size=None))

    async def send_json(self, obj: Dict[str, Any]) -> None:
        await self.ws.send(json.dumps(obj))

    async def recv_until(self, pred, timeout: float = 10.0) -> Dict[str, Any]:
        for i, m in enumerate(self.inbox):
            if pred(m):
                return self.inbox.pop(i)
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError(f"no matching message; inbox={self.inbox[-5:]}")
            raw = await asyncio.wait_for(self.ws.recv(), left)
            m = json.loads(raw)
            if pred(m):
                return m
            self.inbox.append(m)

    async def recv_type(self, t: str, timeout: float = 10.0) -> Dict[str, Any]:
        return await self.recv_until(lambda m: m.get("t") == t, timeout)

    async def close(self) -> None:
        await self.ws.close()


def soffice_available() -> bool:
    if not shutil.which("soffice"):
        return False
    try:
        import uno  # noqa: F401
    except ImportError:
        return False
    return True


def node_available() -> bool:
    return shutil.which("node") is not None and os.path.exists(os.path.join(ROOT, "node_modules", "tsx"))


def run_node(args: List[str], timeout: float = 120) -> subprocess.CompletedProcess:
    return subprocess.run(["node", "--import", "tsx", *args], cwd=ROOT, capture_output=True, text=True, timeout=timeout)
