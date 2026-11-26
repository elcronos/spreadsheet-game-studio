"""Bridge-side state: the frame shadow and edit echo suppression."""
from __future__ import annotations

import math
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

from .protocol import DecodedFrame, ProtocolError


class FrameState:
    """Shadow of what the GAME range should show.

    ``target`` holds the latest palette index per cell (all received frames
    applied). ``dirty`` marks cells the sink has not yet written
    successfully; it is only cleared after a successful sink write, so a busy
    or failed write (Excel in cell-edit mode) self-heals on the next frame
    without needing a keyframe request in the protocol.
    """

    def __init__(self, width: int, height: int, palette: Optional[List[int]] = None):
        self.width, self.height = width, height
        self.target = np.zeros((height, width), dtype=np.uint8)
        self.dirty = np.ones((height, width), dtype=bool)
        self.palette = np.zeros(256, dtype=np.uint32)
        self.palette_count = 0
        self.palette_version = -1
        self.palette_dirty = True  # sink must (re)apply palette (CF colours)
        self.changed_slots: set[int] = set()
        if palette:
            self.set_palette(np.asarray(palette, dtype=np.uint32), 0)
        self.frames = 0
        self.last_frame_id = -1

    def set_palette(self, pal: np.ndarray, version: int) -> List[int]:
        n = min(256, len(pal))
        old = self.palette.copy()
        oldn = self.palette_count
        self.palette[:n] = pal[:n]
        self.palette_count = n
        self.palette_version = version
        changed = [i for i in range(max(n, oldn)) if i >= oldn or i >= n or old[i] != self.palette[i]]
        if changed:
            self.palette_dirty = True
            self.changed_slots.update(changed)
        return changed

    def apply(self, f: DecodedFrame) -> None:
        if f.width != self.width or f.height != self.height:
            raise ProtocolError(f"frame {f.width}x{f.height} does not match layout {self.width}x{self.height}")
        if f.palette is not None:
            self.set_palette(f.palette, f.palette_version)
        elif f.palette_version != self.palette_version and self.palette_version >= 0:
            # contract: palette must accompany a version change; keep the last one
            self.palette_version = f.palette_version
        if f.keyframe:
            self.dirty[:] = True
        t, d = self.target, self.dirty
        for r in f.runs:
            n = r.indices.shape[0]
            t[r.row, r.x0:r.x0 + n] = r.indices
            d[r.row, r.x0:r.x0 + n] = True
        self.frames += 1
        self.last_frame_id = f.frame_id

    def mark_slots_dirty(self, slots) -> int:
        """Interior strategy: cells whose palette slot changed colour must be refilled."""
        if not slots:
            return 0
        m = np.isin(self.target, np.fromiter(slots, dtype=np.uint8, count=len(slots)))
        self.dirty |= m
        return int(m.sum())

    def rgb(self) -> np.ndarray:
        """(h, w) uint32 0xRRGGBB of the target frame."""
        return self.palette[self.target]


_MISSING = object()


def _norm_formula(s: Any) -> str:
    return "".join(str(s).split()).upper()


def same_value(a: Any, b: Any, formula: bool = False) -> bool:
    if a is _MISSING or b is _MISSING:
        return False
    if formula:
        return _norm_formula(a) == _norm_formula(b)
    if isinstance(a, bool) or isinstance(b, bool):
        try:
            return bool(a) == bool(b) and not isinstance(a, str) and not isinstance(b, str)
        except Exception:
            return False
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if math.isnan(float(a)) or math.isnan(float(b)):
            return False
        return abs(float(a) - float(b)) <= 1e-9 * max(1.0, abs(float(a)), abs(float(b)))
    if a is None or b is None:
        return (a is None or a == "") and (b is None or b == "")
    return str(a) == str(b)


class EchoGuard:
    """Tells user edits apart from values the bridge wrote itself.

    Keys are ``var:<key>`` or ``rule:<Name>``.

    * ``sheet_last[key]``: what the cell held after the bridge's own last
      write (read back, so spreadsheet canonicalisation such as Calc
      reformatting a formula never looks like a user edit).
    * ``game_last[key]``: the game value last written, to skip redundant writes.
    * ``hold[key]``: after a user edit, incoming game state for that key is
      ignored until the game echoes the user's value or ``hold_s`` expires
      (then the game value is written back, e.g. when the game rejected the
      edit).
    """

    def __init__(self, hold_s: float = 1.5, clock: Callable[[], float] = time.monotonic):
        self.hold_s = hold_s
        self.clock = clock
        self.sheet_last: Dict[str, Any] = {}
        self.game_last: Dict[str, Any] = {}
        self.hold: Dict[str, Tuple[Any, float]] = {}

    @staticmethod
    def _is_formula(key: str) -> bool:
        return key.startswith("rule:")

    def reset(self) -> None:
        self.sheet_last.clear()
        self.game_last.clear()
        self.hold.clear()

    def observe(self, key: str, sheet_value: Any) -> bool:
        """Report what a cell currently holds; True when it is a user edit."""
        prev = self.sheet_last.get(key, _MISSING)
        if prev is _MISSING:
            self.sheet_last[key] = sheet_value
            return False
        if same_value(prev, sheet_value, self._is_formula(key)):
            return False
        self.sheet_last[key] = sheet_value
        self.hold[key] = (sheet_value, self.clock() + self.hold_s)
        self.game_last.pop(key, None)  # force a rewrite later if the game disagrees
        return True

    def want_write(self, key: str, game_value: Any) -> bool:
        h = self.hold.get(key)
        f = self._is_formula(key)
        if h is not None:
            if same_value(game_value, h[0], f):
                del self.hold[key]
                self.game_last[key] = game_value
                return False
            if self.clock() < h[1]:
                return False
            del self.hold[key]
        return not same_value(game_value, self.game_last.get(key, _MISSING), f)

    def wrote(self, key: str, game_value: Any, sheet_value: Any) -> None:
        self.game_last[key] = game_value
        self.sheet_last[key] = sheet_value

    def held(self, key: str) -> bool:
        return key in self.hold
