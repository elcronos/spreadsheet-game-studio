"""Snapshot sink: writes a real .xlsx (openpyxl) where every GAME cell has the
fill colour of its pixel. For demos and inspection, not real-time play: the
file is rewritten at most every ``every_s`` seconds and on shutdown/bye.
"""
from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from ..layout import Layout, RuleRow, TELEMETRY, TELEMETRY_HEADER, VarRow
from ..state import FrameState
from .base import ApplyResult, Sink, pad_rows


class SnapshotSink(Sink):
    name = "snapshot"
    default_strategy = "interior"

    def __init__(self, strategy: str = "auto", workbook: Optional[str] = None, every_s: float = 2.0, **opts: Any):
        super().__init__(strategy, workbook, **opts)
        self.path = workbook or "sgs_snapshot.xlsx"
        self.every_s = every_s
        self.indices: Optional[np.ndarray] = None
        self.palette: List[int] = []
        self.values: Dict[str, Any] = {}
        self.rule_formulas: Dict[str, str] = {}
        self.rule_values: Dict[str, Any] = {}
        self.tables: Dict[str, List[List[Any]]] = {}
        self.hud = ["", ""]
        self.last_save = 0.0
        self.dirty_since_save = False
        self.saves = 0

    def open(self) -> Dict[str, Any]:
        return {"appVersion": "openpyxl snapshot", "path": os.path.abspath(self.path)}

    def layout(self, lay: Layout) -> None:
        super().layout(lay)
        self.indices = np.zeros((lay.height, lay.width), dtype=np.uint8)
        self.palette = list(lay.palette)
        self.values = {k: v.default for k, v in lay.vars_by_key.items()}
        self.rule_formulas = {r.name: r.formula for r in lay.rules}

    def apply_frame(self, fs: FrameState) -> ApplyResult:
        t0 = time.perf_counter()
        cells = int(fs.dirty.sum())
        self.indices = fs.target.copy()
        self.palette = fs.palette[:fs.palette_count].tolist()
        fs.dirty[:] = False
        fs.palette_dirty = False
        fs.changed_slots.clear()
        self.dirty_since_save = True
        calls = 0
        if time.monotonic() - self.last_save >= self.every_s:
            self.save()
            calls = 1
        return ApplyResult(cells=cells, calls=calls, ms=(time.perf_counter() - t0) * 1000)

    def write_hud(self, line1: str, line2: str) -> None:
        self.hud = [line1, line2]
        self.dirty_since_save = True

    def read_editables(self):
        lay = self.layout_
        return ({k: _shown(lay.vars_by_key[k], v) for k, v in self.values.items()}, {n: (f, self.rule_values.get(n)) for n, f in self.rule_formulas.items()})

    def write_values(self, writes: Sequence[Tuple[VarRow, Any]]) -> None:
        for v, val in writes:
            self.values[v.key] = val
        self.dirty_since_save = True

    def write_rule_values(self, writes: Sequence[Tuple[RuleRow, Any]]) -> None:
        for r, val in writes:
            self.rule_values[r.name] = val

    def write_rule_formulas(self, writes: Sequence[Tuple[RuleRow, str]]) -> Dict[str, str]:
        for r, f in writes:
            self.rule_formulas[r.name] = f if f.startswith("=") else "=" + f
        return {r.name: self.rule_formulas[r.name] for r, _ in writes}

    def write_sheet(self, name: str, columns: List[str], rows: List[Dict[str, Any]]) -> None:
        self.tables[name] = pad_rows(columns, rows)[0]
        self.dirty_since_save = True

    def write_telemetry(self, items: List[Tuple[str, Any]]) -> None:
        self.tables[TELEMETRY] = [TELEMETRY_HEADER] + [[k, v] for k, v in items]

    def save(self) -> None:
        if self.layout_ is None or self.indices is None:
            return
        from ..workbook import build_workbook

        lay = self.layout_
        for r in lay.rules:
            r.formula = self.rule_formulas.get(r.name, r.formula)
        wb = build_workbook(lay, indices=self.indices, palette=self.palette, fills=True, conditional_formats=False, strategy="interior", values=self.values, sheets=self.tables, hud=self.hud)
        tmp = self.path + ".tmp.xlsx"
        wb.save(tmp)
        os.replace(tmp, self.path)
        self.last_save = time.monotonic()
        self.dirty_since_save = False
        self.saves += 1

    def dump(self) -> None:
        self.save()

    def close(self) -> None:
        if self.dirty_since_save:
            self.save()


def _shown(v: VarRow, val: Any) -> Any:
    from ..layout import display_value

    return display_value(v, val)
