"""In-memory sink: numpy grid of fills + values with a call counter.

It executes exactly the plans the real sinks execute. For the interior
strategy it goes through the *Excel* address-string path (multi-area ranges of
<= 255 characters) and parses those strings back into cells, so the Excel
planning code is verified end to end on Linux. Conditional formatting is
emulated: a cell holding value ``i`` displays CF colour ``i``.
"""
from __future__ import annotations

import json
import threading
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from ..layout import RULES, TELEMETRY, Layout, RuleRow, VarRow, display_value
from ..planning import Rect, chunk_addresses, parse_address_list
from ..state import FrameState
from .base import Sink, pad_rows


class MockSink(Sink):
    name = "mock"
    default_strategy = "values-cf"

    def __init__(self, strategy: str = "auto", workbook: Optional[str] = None, call_ms: float = 0.0, cell_us: float = 0.0, address_limit: int = 255, dump_path: Optional[str] = None, **opts: Any):
        super().__init__(strategy, workbook, **opts)
        self.call_ms = call_ms
        self.cell_us = cell_us
        self.address_limit = address_limit
        self.dump_path = dump_path
        self.lock = threading.RLock()
        self.values: Optional[np.ndarray] = None  # float, NaN = empty
        self.fills: Optional[np.ndarray] = None  # int64 rgb, -1 = no fill
        self.cf = np.full(256, -1, dtype=np.int64)
        self.cells: Dict[Tuple[str, int, int], Any] = {}  # (sheet,row,col) -> value or formula text
        self.sheet_tables: Dict[str, List[List[Any]]] = {}
        self.hud = ["", ""]
        self.calls = 0
        self.frames_applied = 0
        self.selected: Optional[Tuple[str, int, int]] = None
        self.input_counts: Optional[Dict[str, float]] = None
        self.address_strings = 0
        self.layout_count = 0
        self.rule_eval = True

    def _call(self, n: int = 1, cells: int = 0) -> int:
        self.calls += n
        d = n * self.call_ms / 1000 + cells * self.cell_us / 1e6
        if d > 0:
            time.sleep(d)
        return n

    def open(self) -> Dict[str, Any]:
        return {"appVersion": "mock"}

    def layout(self, lay: Layout) -> None:
        with self.lock:
            super().layout(lay)
            self.layout_count += 1
            self.values = np.full((lay.height, lay.width), np.nan)
            self.fills = np.full((lay.height, lay.width), -1, dtype=np.int64)
            self.cf[:] = -1
            self.cells.clear()
            for rows in lay.var_sheets.values():
                for v in rows:
                    self.cells[(v.sheet, v.row, 2)] = display_value(v, v.default)
            for r in lay.rules:
                self.cells[(RULES, r.row, 2)] = r.formula
            if lay.palette:
                for i, c in enumerate(lay.palette[:256]):
                    self.cf[i] = c

    # ---- frames ---------------------------------------------------------------
    def _apply_palette(self, fs: FrameState) -> int:
        with self.lock:
            for i in sorted(fs.changed_slots):
                self.cf[i] = int(fs.palette[i]) if i < fs.palette_count else -1
            return self._call(len(fs.changed_slots))

    def _write_band(self, rect: Rect, values: np.ndarray) -> int:
        r0, r1, c0, c1 = rect
        with self.lock:
            self.values[r0:r1, c0:c1] = values
        return self._call(1, values.size)

    def _fill_rects(self, rgb: int, rects: Sequence[Rect]) -> int:
        lay = self.layout_
        n = 0
        with self.lock:
            for addr in chunk_addresses(rects, lay.origin_row0, lay.origin_col0, self.address_limit):
                assert len(addr) <= self.address_limit, addr
                self.address_strings += 1
                cells = 0
                for ra, rb, ca, cb in parse_address_list(addr):
                    y0, y1 = ra - 1 - lay.origin_row0, rb - lay.origin_row0
                    x0, x1 = ca - 1 - lay.origin_col0, cb - lay.origin_col0
                    self.fills[y0:y1, x0:x1] = rgb
                    cells += (y1 - y0) * (x1 - x0)
                n += self._call(1, cells)
        return n

    def apply_frame(self, fs: FrameState):
        res = super().apply_frame(fs)
        self.frames_applied += 1
        return res

    def rendered(self) -> np.ndarray:
        """What a user would see: (h, w) int64 0xRRGGBB, -1 where nothing is shown."""
        with self.lock:
            if self.strategy == "values-cf":
                v = self.values
                out = np.full(v.shape, -1, dtype=np.int64)
                ok = ~np.isnan(v)
                out[ok] = self.cf[v[ok].astype(np.int64)]
                return out
            return self.fills.copy()

    # ---- HUD / state -------------------------------------------------------------
    def write_hud(self, line1: str, line2: str) -> None:
        with self.lock:
            self.hud = [line1, line2]
            self._call(2)

    def read_editables(self):
        lay = self.layout_
        with self.lock:
            self._call(len(lay.var_sheets) + (1 if lay.rules else 0))
            vars_ = {v.key: self.cells.get((v.sheet, v.row, 2)) for rows in lay.var_sheets.values() for v in rows}
            rules = {r.name: (str(self.cells.get((RULES, r.row, 2))), self._eval_rule(r)) for r in lay.rules}
            return vars_, rules

    def _eval_rule(self, r: RuleRow) -> Any:
        """Tiny evaluator for tests: names -> B cells, Excel arithmetic only. None on error."""
        if not self.rule_eval:
            return None
        lay = self.layout_
        env: Dict[str, Any] = {"ROUND": lambda a, d=0: round(a, int(d)), "MAX": max, "MIN": min, "ABS": abs}
        for name, (sheet, row, col) in lay.defined_names().items():
            if sheet == RULES:
                continue
            v = self.cells.get((sheet, row, col))
            env[name] = v if isinstance(v, (int, float)) else 0
        f = str(self.cells.get((RULES, r.row, 2)) or "")
        try:
            expr = f.lstrip("=").replace("^", "**")
            return float(eval(compile(expr, "<rule>", "eval"), {"__builtins__": {}}, env))  # noqa: S307 (test-only mock)
        except Exception:
            return None

    def write_values(self, writes: Sequence[Tuple[VarRow, Any]]) -> None:
        with self.lock:
            for v, val in writes:
                self.cells[(v.sheet, v.row, 2)] = display_value(v, val)
            self._call(len(writes))

    def write_rule_values(self, writes: Sequence[Tuple[RuleRow, Any]]) -> None:
        with self.lock:
            for r, val in writes:
                self.cells[(RULES, r.row, 3)] = val
            self._call(len(writes))

    def write_rule_formulas(self, writes: Sequence[Tuple[RuleRow, str]]) -> Dict[str, str]:
        with self.lock:
            out = {}
            for r, f in writes:
                f = f.strip()
                f = f if f.startswith("=") else "=" + f
                self.cells[(RULES, r.row, 2)] = f
                out[r.name] = f
            self._call(len(writes) * 2)
            return out

    def write_sheet(self, name: str, columns: List[str], rows: List[Dict[str, Any]]) -> None:
        with self.lock:
            self.sheet_tables[name] = pad_rows(columns, rows)[0]
            self._call(1)

    def write_telemetry(self, items: List[Tuple[str, Any]]) -> None:
        with self.lock:
            self.sheet_tables[TELEMETRY] = [["Metric", "Value"]] + [[k, v] for k, v in items]
            self._call(1)

    def active_cell(self):
        return self.selected

    def read_input(self):
        with self.lock:
            return dict(self.input_counts) if self.input_counts is not None else None

    # ---- test helpers (thread-safe) ---------------------------------------------
    def user_edit(self, sheet: str, row: int, col: int, value: Any) -> None:
        with self.lock:
            self.cells[(sheet, row, col)] = value

    def user_press(self, action: str) -> None:
        with self.lock:
            if self.input_counts is None:
                self.input_counts = {}
            self.input_counts[action] = self.input_counts.get(action, 0) + 1

    def cell(self, sheet: str, row: int, col: int) -> Any:
        with self.lock:
            return self.cells.get((sheet, row, col))

    def dump(self, path: Optional[str] = None) -> Optional[str]:
        path = path or self.dump_path
        if not path or self.layout_ is None:
            return None
        with self.lock:
            rend = self.rendered()
            data = {
                "width": self.layout_.width, "height": self.layout_.height, "strategy": self.strategy,
                "frames": self.frames_applied, "calls": self.calls, "hud": self.hud,
                "rendered": [[int(c) for c in row] for row in rend],
                "values": [[None if np.isnan(c) else int(c) for c in row] for row in self.values],
                "cells": {f"{s}!{r},{c}": v for (s, r, c), v in self.cells.items()},
                "sheets": self.sheet_tables,
            }
        with open(path, "w") as fh:
            json.dump(data, fh)
        return path

    def close(self) -> None:
        self.dump()
