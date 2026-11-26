"""Sink interface: one spreadsheet application (or stand-in) the bridge writes to.

All sink methods are called from a single dedicated worker thread (COM needs
an STA thread; UNO calls block), never concurrently.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from ..layout import Layout, RuleRow, VarRow
from ..planning import Rect, plan_bands, plan_colour_rects, row_spans, rects_cells
from ..state import FrameState

STRATEGIES = ("values-cf", "interior")


class SinkBusy(RuntimeError):
    """The application refused the call (e.g. Excel is in cell-edit mode). Retry later."""


class SinkError(RuntimeError):
    pass


@dataclass
class ApplyResult:
    cells: int = 0
    calls: int = 0
    busy: bool = False
    ms: float = 0.0
    detail: Dict[str, Any] = field(default_factory=dict)


class Sink:
    name = "base"
    default_strategy = "values-cf"
    #: one call expressed in cells, for band merging (values-cf)
    call_cost_cells = 600

    def __init__(self, strategy: str = "auto", workbook: Optional[str] = None, **opts: Any):
        if strategy not in ("auto",) + STRATEGIES + tuple(getattr(self, "extra_strategies", ())):
            raise ValueError(f"unknown strategy {strategy}")
        self.requested_strategy = strategy
        self.strategy = self.default_strategy if strategy == "auto" else strategy
        self.workbook = workbook
        self.opts = opts
        self.layout_: Optional[Layout] = None
        self.total_calls = 0

    # ---- lifecycle -----------------------------------------------------------
    def thread_init(self) -> None:
        """Called once in the worker thread before any other method."""

    def open(self) -> Dict[str, Any]:
        """Connect to the application. Returns info for the `ready` message."""
        return {}

    def layout(self, lay: Layout) -> None:
        self.layout_ = lay

    def save(self) -> None:
        pass

    def close(self) -> None:
        pass

    # ---- frames ----------------------------------------------------------------
    def apply_frame(self, fs: FrameState) -> ApplyResult:
        """Write every dirty cell of ``fs``; clears ``fs.dirty`` only on success."""
        t0 = time.perf_counter()
        res = ApplyResult()
        uses_values = self.strategy == "values-cf"
        if fs.palette_dirty:
            if uses_values:
                res.calls += self._apply_palette(fs)
            else:
                fs.mark_slots_dirty(fs.changed_slots)
        res.calls += self._begin_frame()
        try:
            if uses_values:
                rects = plan_bands(row_spans(fs.dirty), self.call_cost_cells)
                res.detail["bands"] = len(rects)
                for rect in rects:
                    r0, r1, c0, c1 = rect
                    res.calls += self._write_band(rect, fs.target[r0:r1, c0:c1])
                res.cells = rects_cells(rects)
            else:
                groups = plan_colour_rects(fs.target, fs.dirty)
                res.detail["colours"] = len(groups)
                res.detail["rects"] = sum(len(v) for v in groups.values())
                for idx, rects in groups.items():
                    res.calls += self._fill_rects(int(fs.palette[idx]), rects)
                    res.cells += rects_cells(rects)
        finally:
            res.calls += self._end_frame()
        fs.dirty[:] = False
        fs.palette_dirty = False
        fs.changed_slots.clear()
        self.total_calls += res.calls
        res.ms = (time.perf_counter() - t0) * 1000
        return res

    # primitives (return number of application calls made)
    def _begin_frame(self) -> int:
        return 0

    def _end_frame(self) -> int:
        return 0

    def _apply_palette(self, fs: FrameState) -> int:
        raise NotImplementedError

    def _write_band(self, rect: Rect, values: np.ndarray) -> int:
        raise NotImplementedError

    def _fill_rects(self, rgb: int, rects: Sequence[Rect]) -> int:
        raise NotImplementedError

    # ---- HUD / state -----------------------------------------------------------
    def write_hud(self, line1: str, line2: str) -> None:
        raise NotImplementedError

    def write_status(self, text: str) -> None:
        """Bridge status in the GAME HUD stats row (e.g. DISCONNECTED)."""
        self.write_hud(text, "")

    def read_editables(self) -> Tuple[Dict[str, Any], Dict[str, Tuple[str, Any]]]:
        """({var key: raw B value}, {rule name: (formula text in Excel syntax, computed value)})."""
        raise NotImplementedError

    def write_values(self, writes: Sequence[Tuple[VarRow, Any]]) -> None:
        raise NotImplementedError

    def write_rule_values(self, writes: Sequence[Tuple[RuleRow, Any]]) -> None:
        raise NotImplementedError

    def write_rule_formulas(self, writes: Sequence[Tuple[RuleRow, str]]) -> Dict[str, str]:
        """Write formulas (Excel syntax); return {name: formula as read back (Excel syntax)}."""
        raise NotImplementedError

    def write_sheet(self, name: str, columns: List[str], rows: List[Dict[str, Any]]) -> None:
        raise NotImplementedError

    def write_telemetry(self, items: List[Tuple[str, Any]]) -> None:
        raise NotImplementedError

    def active_cell(self) -> Optional[Tuple[str, int, int]]:
        """(sheet, row, col) the user has selected/is editing, if detectable."""
        return None

    def read_input(self) -> Optional[Dict[str, float]]:
        """INPUT sheet press counters written by the SGSInput VBA module, if any."""
        return None

    def info(self) -> Dict[str, Any]:
        return {}


def pad_rows(columns: List[str], rows: List[Dict[str, Any]]) -> Tuple[List[List[Any]], List[Optional[str]]]:
    """`sheet` message -> rectangular table (header first) + per-row styles."""
    width = max([len(columns)] + [len(r.get("cells") or []) for r in rows] + [1])
    table: List[List[Any]] = [list(columns) + [""] * (width - len(columns))]
    styles: List[Optional[str]] = ["header"]
    for r in rows:
        cells = [c if isinstance(c, (int, float)) and not isinstance(c, bool) else ("" if c is None else str(c)) for c in (r.get("cells") or [])]
        table.append(cells + [""] * (width - len(cells)))
        styles.append(r.get("style"))
    return table, styles


ROW_STYLE_RGB = {"header": 0xD9E1F2, "active": 0xFFF2CC, "done": 0xE2EFDA, "failed": 0xF8CBAD, "muted": 0xEDEDED}
