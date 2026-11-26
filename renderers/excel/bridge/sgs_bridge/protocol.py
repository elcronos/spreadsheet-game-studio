"""SGF1 wire protocol (Python side).

Mirrors ``renderers/framebuffer/protocol.ts`` byte for byte. Little-endian::

    0  char[4] magic "SGF1"
    4  u32     frameId
    8  u16     width
    10 u16     height
    12 u8      flags  (bit0 keyframe, bit1 palette present)
    13 u8      reserved
    14 u16     paletteCount (0 when palette absent)
    16 u32     paletteVersion
    20 u32     runCount
    24 ...     palette: paletteCount * 3 bytes (R,G,B)
    .. ...     runs: { u16 row, u16 x0, u16 length, u8[length] indices }

JSON text messages carry a ``t`` field (see references/protocol.md).
"""
from __future__ import annotations

import json
import struct
from dataclasses import dataclass, field
from typing import Any, Iterable, List, Optional, Sequence, Tuple

import numpy as np

MAGIC = b"SGF1"
FLAG_KEY = 1
FLAG_PALETTE = 2
HEADER = struct.Struct("<4sIHHBBHII")
assert HEADER.size == 24
RUN_HEADER = struct.Struct("<HHH")


class ProtocolError(ValueError):
    """Malformed SGF1 frame or JSON message."""


@dataclass
class Run:
    row: int
    x0: int
    indices: np.ndarray  # uint8 view into the frame buffer

    @property
    def length(self) -> int:
        return int(self.indices.shape[0])


@dataclass
class DecodedFrame:
    frame_id: int
    width: int
    height: int
    keyframe: bool
    palette: Optional[np.ndarray]  # uint32 0xRRGGBB, or None when absent
    palette_version: int
    runs: List[Run] = field(default_factory=list)
    nbytes: int = 0

    @property
    def run_cells(self) -> int:
        return sum(r.length for r in self.runs)


def decode_frame(buf: bytes | bytearray | memoryview) -> DecodedFrame:
    """Decode one SGF1 frame. Run indices are zero-copy numpy views."""
    mv = memoryview(buf)
    n = len(mv)
    if n < HEADER.size:
        raise ProtocolError(f"frame too short ({n} bytes)")
    magic, frame_id, width, height, flags, _res, pal_n, pal_ver, run_count = HEADER.unpack_from(mv, 0)
    if magic != MAGIC:
        raise ProtocolError("Bad magic")
    arr = np.frombuffer(mv, dtype=np.uint8)
    o = HEADER.size
    palette = None
    if flags & FLAG_PALETTE:
        end = o + pal_n * 3
        if end > n:
            raise ProtocolError("palette truncated")
        rgb = arr[o:end].reshape(pal_n, 3).astype(np.uint32)
        palette = (rgb[:, 0] << 16) | (rgb[:, 1] << 8) | rgb[:, 2]
        o = end
    runs: List[Run] = []
    unpack = RUN_HEADER.unpack_from
    for _ in range(run_count):
        if o + 6 > n:
            raise ProtocolError("run header truncated")
        row, x0, length = unpack(mv, o)
        o += 6
        if row >= height or x0 + length > width:
            raise ProtocolError("Run out of bounds")
        if o + length > n:
            raise ProtocolError("run data truncated")
        runs.append(Run(row, x0, arr[o:o + length]))
        o += length
    return DecodedFrame(frame_id, width, height, bool(flags & FLAG_KEY), palette, pal_ver, runs, n)


def encode_frame(
    frame_id: int,
    indices: np.ndarray,
    runs: Iterable[Tuple[int, int, int]],
    keyframe: bool,
    palette: Optional[Sequence[int]],
    palette_version: int = 0,
) -> bytes:
    """Encode a frame (used by tests, native_test.py and Python clients).

    ``indices`` is the full (height, width) uint8 frame; ``runs`` are
    (row, x0, length) tuples selecting what to send.
    """
    h, w = indices.shape
    runs = list(runs)
    pal = list(palette) if palette is not None else []
    flags = (FLAG_KEY if keyframe else 0) | (FLAG_PALETTE if palette is not None else 0)
    parts = [HEADER.pack(MAGIC, frame_id & 0xFFFFFFFF, w, h, flags, 0, len(pal), palette_version & 0xFFFFFFFF, len(runs))]
    if pal:
        p = np.asarray(pal, dtype=np.uint32)
        rgb = np.stack([(p >> 16) & 255, (p >> 8) & 255, p & 255], axis=1).astype(np.uint8)
        parts.append(rgb.tobytes())
    for row, x0, length in runs:
        parts.append(RUN_HEADER.pack(row, x0, length))
        parts.append(np.ascontiguousarray(indices[row, x0:x0 + length], dtype=np.uint8).tobytes())
    return b"".join(parts)


def keyframe_runs(width: int, height: int) -> List[Tuple[int, int, int]]:
    return [(y, 0, width) for y in range(height)]


# ---------------------------------------------------------------------------
# JSON messages

GAME_TO_BRIDGE = {"hello", "state", "hud", "sheet", "telemetry", "bye"}
BRIDGE_TO_GAME = {"ready", "ack", "edit", "rule", "input", "error"}


def parse_text(s: str | bytes) -> dict:
    try:
        obj = json.loads(s)
    except (ValueError, TypeError) as e:
        raise ProtocolError(f"invalid JSON: {e}") from None
    if not isinstance(obj, dict) or not isinstance(obj.get("t"), str):
        raise ProtocolError("message must be an object with a string 't' field")
    return obj


def dumps(obj: dict) -> str:
    return json.dumps(obj, separators=(",", ":"), allow_nan=False, default=_json_default)


def _json_default(o: Any) -> Any:
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(f"not JSON serialisable: {type(o)}")


def msg_ready(sink: str, strategy: str, excel_version: Optional[str] = None, **extra: Any) -> str:
    m: dict = {"t": "ready", "sink": sink, "strategy": strategy}
    if excel_version is not None:
        m["excelVersion"] = excel_version
    m.update(extra)
    return dumps(m)


def msg_ack(frame_id: int, apply_ms: float, cells: int, calls: int, **extra: Any) -> str:
    m = {"t": "ack", "frameId": int(frame_id), "applyMs": round(float(apply_ms), 3), "cells": int(cells), "calls": int(calls)}
    m.update(extra)
    return dumps(m)


def msg_edit(key: str, value: Any) -> str:
    return dumps({"t": "edit", "key": key, "value": value})


def msg_rule(name: str, formula: str, value: Any) -> str:
    return dumps({"t": "rule", "name": name, "formula": formula, "value": value})


def msg_input(action: str, down: bool) -> str:
    return dumps({"t": "input", "action": action, "down": bool(down)})


def msg_error(message: str) -> str:
    return dumps({"t": "error", "message": str(message)})
