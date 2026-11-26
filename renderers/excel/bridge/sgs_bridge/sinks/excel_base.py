"""Shared Microsoft Excel sink logic (COM via pywin32, or xlwings).

NATIVE EXCEL IS UNVERIFIED in the environment this was written in (Linux, no
Excel). The planning code these sinks execute is verified through the mock
sink, and the COM call sequences are exercised against a fake COM object
model in tests/excel/test_excel_fake.py, but real Excel behaviour and
performance must be measured with renderers/excel/native_test.py on Windows.

Per frame batch:
  * ``Application.ScreenUpdating = False`` and ``Calculation = manual``, restored
    after the batch (Excel repaints once per frame).
  * ``values-cf``: one FormatConditions rule per palette index (xlCellValue,
    xlEqual) over the GAME range, created once; frames are bulk
    ``Range(address).Value = 2D tuple`` writes over merged dirty row bands.
  * ``interior``: same-colour cells grouped into multi-area Range address
    strings (<= 255 characters each) with ``Interior.Color`` set once per group.
"""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from ..layout import (
    EXCEL_COL_WIDTH_CHARS, EXCEL_ROW_HEIGHT_PT, GAME, INPUT, INPUT_HEADER, META, RULES, RULES_HEADER, TELEMETRY,
    TELEMETRY_HEADER, VARIABLE_HEADER, Layout, RuleRow, VarRow, column_name, display_value, quote_sheet, rect_a1,
)
from ..planning import Rect, chunk_addresses, rect_address, rgb_to_bgr
from ..state import FrameState
from .base import ROW_STYLE_RGB, Sink, SinkBusy, pad_rows

# Excel constants (late-bound COM has no typelib constants)
XL_CELL_VALUE = 1
XL_EQUAL = 3
XL_CALC_MANUAL = -4135
XL_CALC_AUTOMATIC = -4105
XL_SHEET_HIDDEN = 0
XL_SHEET_VERY_HIDDEN = 2
XL_OPENXML_WORKBOOK = 51
XL_OPENXML_MACRO_WORKBOOK = 52

# HRESULTs Excel returns while it is busy (cell edit mode, modal dialog)
BUSY_HRESULTS = {-2147418111, -2147417846, -2146777998}  # RPC_E_CALL_REJECTED, RPC_E_SERVERCALL_RETRYLATER, VBA_E_IGNORE


def _as_2d(v: Any) -> List[List[Any]]:
    if isinstance(v, (tuple, list)):
        if v and isinstance(v[0], (tuple, list)):
            return [list(r) for r in v]
        return [[x] for x in v]
    return [[v]]


class ExcelOps:
    """Minimal object-model operations; implemented for COM and xlwings."""

    def sheet_names(self) -> List[str]: ...
    def add_sheet(self, name: str) -> None: ...
    def set_values(self, sheet: str, addr: str, rows: Sequence[Sequence[Any]]) -> int: ...
    def get_values(self, sheet: str, addr: str) -> List[List[Any]]: ...
    def get_formulas(self, sheet: str, addr: str) -> List[List[Any]]: ...
    def set_formula(self, sheet: str, addr: str, formula: str) -> int: ...
    def set_fill(self, sheet: str, addr: str, rgb: Optional[int]) -> int: ...
    def clear_sheet(self, sheet: str) -> int: ...
    def set_col_width(self, sheet: str, addr: str, w: float) -> int: ...
    def set_row_height(self, sheet: str, addr: str, h: float) -> int: ...
    def set_number_format(self, sheet: str, addr: str, fmt: str) -> int: ...
    def set_bold(self, sheet: str, addr: str) -> int: ...
    def set_visible(self, sheet: str, state: int) -> int: ...
    def activate(self, sheet: str) -> None: ...
    def delete_name(self, name: str) -> None: ...
    def add_name(self, name: str, refers_to: str) -> int: ...
    def cf_list(self, sheet: str, addr: str) -> List[str]: ...
    def cf_reset(self, sheet: str, addr: str, colours_bgr: Sequence[int]) -> int: ...
    def cf_add(self, sheet: str, addr: str, index: int, bgr: int) -> int: ...
    def cf_set_colour(self, sheet: str, addr: str, position: int, bgr: int) -> int: ...
    def batch_begin(self) -> int: ...
    def batch_end(self) -> int: ...
    def active_cell(self) -> Optional[Tuple[str, int, int]]: ...
    def save(self) -> None: ...
    def version(self) -> str: ...
    def busy_error(self, e: BaseException) -> bool: return False
    supports_cf = True


class ExcelSinkBase(Sink):
    default_strategy = "values-cf"
    call_cost_cells = 400  # UNVERIFIED guess for COM; tune with native_test.py

    def __init__(self, strategy: str = "auto", workbook: Optional[str] = None, visible: bool = True, **opts: Any):
        super().__init__(strategy, workbook, **opts)
        self.visible = visible
        self.ops: Optional[ExcelOps] = None
        self.frame_addr = ""
        self.cf_pos: Dict[int, int] = {}  # palette index -> FormatConditions position (1-based)
        self.sheet_sizes: Dict[str, Tuple[int, int]] = {}
        self.input_n = 0
        self.attached_prebuilt = False

    # subclasses: create self.ops (connect / open workbook)
    def _connect(self) -> ExcelOps:
        raise NotImplementedError

    def _call(self, fn, *a):
        try:
            return fn(*a)
        except SinkBusy:
            raise
        except Exception as e:
            if self.ops is not None and self.ops.busy_error(e):
                raise SinkBusy(str(e)) from None
            raise

    def open(self) -> Dict[str, Any]:
        self.ops = self._connect()
        return {"excelVersion": self.ops.version()}

    def _ensure_workbook_file(self, lay: Optional[Layout]) -> None:
        """Create the workbook with openpyxl (tested builder) when it does not exist yet."""
        if self.workbook and not os.path.exists(self.workbook) and lay is not None:
            from ..workbook import build_workbook

            build_workbook(lay, strategy=self.strategy).save(self.workbook)

    # ---- layout -------------------------------------------------------------------
    def layout(self, lay: Layout) -> None:
        super().layout(lay)
        ops = self.ops
        self.frame_addr = lay.frame_range_a1()
        sig = None
        try:
            if META in ops.sheet_names():
                sig = ops.get_values(META, "B1")[0][0]
        except Exception:
            sig = None
        if sig == lay.signature():
            self.attached_prebuilt = True
            self._attach(lay)
        else:
            self.attached_prebuilt = False
            self._relayout(lay)
        if self.strategy == "values-cf" and not ops.supports_cf and not self.cf_pos:
            # e.g. xlwings on macOS without a prebuilt workbook: cannot create CF rules
            self.strategy = "interior"
        self.input_n = len(lay.input_actions())
        self.sheet_sizes = {}
        try:
            ops.activate(GAME)
        except Exception:
            pass

    def _attach(self, lay: Layout) -> None:
        """Prebuilt workbook (build_workbook.py) whose signature matches: reuse its CF rules."""
        self._map_cf(lay)
        if self.strategy == "values-cf" and len(self.cf_pos) < len(lay.palette) and self.ops.supports_cf:
            self._reset_cf(lay.palette)

    def _map_cf(self, lay: Layout) -> None:
        self.cf_pos = {}
        try:
            lst = self.ops.cf_list(GAME, self.frame_addr)
            if lst is None:  # cannot enumerate (xlwings/macOS): prebuilt rules are in palette order
                self.cf_pos = {i: i + 1 for i in range(len(lay.palette))}
                return
            for pos, f1 in enumerate(lst, start=1):
                s = str(f1).lstrip("=").strip()
                if s.isdigit():
                    self.cf_pos.setdefault(int(s), pos)
        except Exception:
            self.cf_pos = {}

    def _reset_cf(self, palette: Sequence[int]) -> int:
        n = self.ops.cf_reset(GAME, self.frame_addr, [rgb_to_bgr(c) for c in palette])
        self.cf_pos = {i: i + 1 for i in range(len(palette))}
        return n

    def _relayout(self, lay: Layout) -> None:
        ops = self.ops
        have = set(ops.sheet_names())
        for nm in lay.all_sheets():
            if nm not in have:
                ops.add_sheet(nm)
        # GAME
        ops.clear_sheet(GAME)
        last_col = column_name(lay.origin_col0 + lay.width - 1)
        ops.set_col_width(GAME, f"{column_name(lay.origin_col0)}:{last_col}", EXCEL_COL_WIDTH_CHARS)
        ops.set_row_height(GAME, f"{lay.frame_first_row}:{lay.frame_first_row + lay.height - 1}", EXCEL_ROW_HEIGHT_PT)
        ops.set_number_format(GAME, self.frame_addr, ";;;")
        ops.set_values(GAME, "A1:A2", [[f"{lay.title} - waiting for first frame"], [""]])
        self.cf_pos = {}
        if self.strategy == "values-cf" and ops.supports_cf:
            self._reset_cf(lay.palette or [0])
        # names first removed (they may point at cleared sheets)
        for nm in lay.defined_names():
            ops.delete_name(nm)
        for sheet, rows in lay.var_sheets.items():
            ops.clear_sheet(sheet)
            table = [VARIABLE_HEADER] + [[v.label, display_value(v, v.default), _o(v.min), _o(v.max), v.unit, v.description, v.key] for v in rows]
            ops.set_values(sheet, f"A1:G{len(table)}", table)
            ops.set_bold(sheet, "A1:G1")
            if rows:
                ops.set_fill(sheet, f"B2:B{len(rows) + 1}", 0xFFF8E1)
        ops.clear_sheet(RULES)
        table = [RULES_HEADER] + [[r.name, "", "", r.min, r.max, r.description] for r in lay.rules]
        ops.set_values(RULES, f"A1:F{len(table)}", table)
        ops.set_bold(RULES, "A1:F1")
        for name, (sheet, row, col) in lay.defined_names().items():
            ops.add_name(name, f"={quote_sheet(sheet)}!${column_name(col - 1)}${row}")
        for r in lay.rules:
            ops.set_formula(RULES, f"B{r.row}", r.formula)
        for s in lay.custom_sheets:
            ops.clear_sheet(s["name"])
            if s["columns"]:
                ops.set_values(s["name"], rect_a1(1, 1, 1, len(s["columns"])), [s["columns"]])
        ops.clear_sheet(TELEMETRY)
        ops.set_values(TELEMETRY, "A1:B1", [TELEMETRY_HEADER])
        ops.clear_sheet(INPUT)
        acts = lay.input_actions()
        ops.set_values(INPUT, f"A1:D{len(acts) + 1}", [INPUT_HEADER] + [[a, 0, 0, "|".join(k)] for a, k in acts])
        ops.set_visible(INPUT, XL_SHEET_HIDDEN)
        ops.clear_sheet(META)
        ops.set_values(META, "A1:B4", [["signature", lay.signature()], ["width", lay.width], ["height", lay.height], ["strategy", self.strategy]])
        ops.set_visible(META, XL_SHEET_VERY_HIDDEN)

    # ---- frames -------------------------------------------------------------------
    def apply_frame(self, fs: FrameState):
        try:
            return super().apply_frame(fs)
        except SinkBusy:
            raise
        except Exception as e:
            if self.ops is not None and self.ops.busy_error(e):
                raise SinkBusy(str(e)) from None
            raise

    def _begin_frame(self) -> int:
        return self.ops.batch_begin()

    def _end_frame(self) -> int:
        return self.ops.batch_end()

    def _apply_palette(self, fs: FrameState) -> int:
        pal = [int(c) for c in fs.palette[:fs.palette_count]]
        if not self.ops.supports_cf:
            return 0
        missing = [i for i in range(len(pal)) if i not in self.cf_pos]
        if len(missing) > 16:
            return self._reset_cf(pal)
        calls = 0
        for i in sorted(fs.changed_slots):
            if i >= len(pal):
                continue
            if i in self.cf_pos:
                calls += self.ops.cf_set_colour(GAME, self.frame_addr, self.cf_pos[i], rgb_to_bgr(pal[i]))
            else:
                calls += self.ops.cf_add(GAME, self.frame_addr, i, rgb_to_bgr(pal[i]))
                self.cf_pos[i] = len(self.cf_pos) + 1
        return calls

    def _write_band(self, rect: Rect, values: np.ndarray) -> int:
        lay = self.layout_
        addr = rect_address(rect, lay.origin_row0, lay.origin_col0)
        return self.ops.set_values(GAME, addr, tuple(map(tuple, values.tolist())))

    def _fill_rects(self, rgb: int, rects: Sequence[Rect]) -> int:
        lay = self.layout_
        n = 0
        for addr in chunk_addresses(rects, lay.origin_row0, lay.origin_col0, 255):
            n += self.ops.set_fill(GAME, addr, rgb)
        return n

    # ---- HUD / state --------------------------------------------------------------------
    def write_hud(self, line1: str, line2: str) -> None:
        self._call(self.ops.set_values, GAME, "A1:A2", [[line1], [line2]])

    def read_editables(self):
        lay = self.layout_
        ops = self.ops
        vars_: Dict[str, Any] = {}
        for sheet, rows in lay.var_sheets.items():
            if not rows:
                continue
            data = self._call(ops.get_values, sheet, f"B2:B{len(rows) + 1}")
            for v, row in zip(rows, data):
                vars_[v.key] = row[0]
        rules: Dict[str, Tuple[str, Any]] = {}
        if lay.rules:
            n = len(lay.rules) + 1
            forms = self._call(ops.get_formulas, RULES, f"B2:B{n}")
            vals = self._call(ops.get_values, RULES, f"B2:B{n}")
            for r, (f,), (val,) in zip(lay.rules, forms, vals):
                rules[r.name] = (str(f), val if isinstance(val, (int, float)) and not isinstance(val, bool) else None)
        return vars_, rules

    def write_values(self, writes: Sequence[Tuple[VarRow, Any]]) -> None:
        for v, val in writes:
            self._call(self.ops.set_values, v.sheet, f"B{v.row}", [[display_value(v, val)]])

    def write_rule_values(self, writes: Sequence[Tuple[RuleRow, Any]]) -> None:
        for r, val in writes:
            self._call(self.ops.set_values, RULES, f"C{r.row}", [["" if val is None else val]])

    def write_rule_formulas(self, writes: Sequence[Tuple[RuleRow, str]]) -> Dict[str, str]:
        out = {}
        for r, f in writes:
            f = f.strip()
            f = f if f.startswith("=") else "=" + f
            self._call(self.ops.set_formula, RULES, f"B{r.row}", f)
            out[r.name] = str(self._call(self.ops.get_formulas, RULES, f"B{r.row}")[0][0])
        return out

    def write_sheet(self, name: str, columns: List[str], rows: List[Dict[str, Any]]) -> None:
        ops = self.ops
        if name not in ops.sheet_names():
            ops.add_sheet(name)
        table, styles = pad_rows(columns, rows)
        h, w = len(table), len(table[0])
        prev = self.sheet_sizes.get(name)
        if prev and (prev[0] > h or prev[1] > w):
            self._call(ops.clear_sheet, name)
        self._call(ops.set_values, name, rect_a1(1, 1, h, w), table)
        for i, st in enumerate(styles[1:], start=2):
            self._call(ops.set_fill, name, rect_a1(i, 1, i, w), ROW_STYLE_RGB.get(st or ""))
        self.sheet_sizes[name] = (h, w)

    def write_telemetry(self, items: List[Tuple[str, Any]]) -> None:
        table = [TELEMETRY_HEADER] + [[k, v] for k, v in items]
        prev = self.sheet_sizes.get(TELEMETRY)
        if prev and prev[0] > len(table):
            self._call(self.ops.clear_sheet, TELEMETRY)
        self._call(self.ops.set_values, TELEMETRY, f"A1:B{len(table)}", table)
        self.sheet_sizes[TELEMETRY] = (len(table), 2)

    def active_cell(self):
        return self._call(self.ops.active_cell)

    def read_input(self):
        if not self.input_n:
            return None
        data = self._call(self.ops.get_values, INPUT, f"A2:B{self.input_n + 1}")
        return {str(a): (float(b) if isinstance(b, (int, float)) else 0.0) for a, b in data if a}

    def save(self) -> None:
        if self.ops is not None and self.workbook:
            self._call(self.ops.save)


def _o(v):
    return "" if v is None else v


# ---------------------------------------------------------------------------
# COM implementation (pywin32 Dispatch objects, or any object with the same shape)

class ComOps(ExcelOps):
    def __init__(self, app: Any, wb: Any):
        self.app, self.wb = app, wb
        self._ws: Dict[str, Any] = {}
        self._prev_calc: Optional[int] = None

    def ws(self, name: str):
        w = self._ws.get(name)
        if w is None:
            w = self._ws[name] = self.wb.Worksheets(name)
        return w

    def busy_error(self, e: BaseException) -> bool:
        hr = getattr(e, "hresult", None)
        if hr is None and getattr(e, "args", None):
            hr = e.args[0] if isinstance(e.args[0], int) else None
        return hr in BUSY_HRESULTS

    def sheet_names(self) -> List[str]:
        return [self.wb.Worksheets(i).Name for i in range(1, self.wb.Worksheets.Count + 1)]

    def add_sheet(self, name: str) -> None:
        ws = self.wb.Worksheets.Add(None, self.wb.Worksheets(self.wb.Worksheets.Count))
        ws.Name = name
        self._ws[name] = ws

    def set_values(self, sheet, addr, rows) -> int:
        self.ws(sheet).Range(addr).Value = tuple(tuple(r) for r in rows)
        return 2

    def get_values(self, sheet, addr):
        return _as_2d(self.ws(sheet).Range(addr).Value)

    def get_formulas(self, sheet, addr):
        return _as_2d(self.ws(sheet).Range(addr).Formula)

    def set_formula(self, sheet, addr, formula) -> int:
        self.ws(sheet).Range(addr).Formula = formula
        return 2

    def set_fill(self, sheet, addr, rgb) -> int:
        it = self.ws(sheet).Range(addr).Interior
        if rgb is None or rgb < 0:
            it.ColorIndex = -4142  # xlColorIndexNone
        else:
            it.Color = rgb_to_bgr(int(rgb))
        return 3

    def clear_sheet(self, sheet) -> int:
        ws = self.ws(sheet)
        ws.Cells.FormatConditions.Delete()
        ws.Cells.Clear()
        ws.Cells.UseStandardWidth = True
        ws.Cells.UseStandardHeight = True
        return 6

    def set_col_width(self, sheet, addr, w) -> int:
        self.ws(sheet).Range(addr).ColumnWidth = w
        return 2

    def set_row_height(self, sheet, addr, h) -> int:
        self.ws(sheet).Range(addr).RowHeight = h
        return 2

    def set_number_format(self, sheet, addr, fmt) -> int:
        self.ws(sheet).Range(addr).NumberFormat = fmt
        return 2

    def set_bold(self, sheet, addr) -> int:
        self.ws(sheet).Range(addr).Font.Bold = True
        return 3

    def set_visible(self, sheet, state) -> int:
        self.ws(sheet).Visible = state
        return 1

    def activate(self, sheet) -> None:
        self.ws(sheet).Activate()

    def delete_name(self, name) -> None:
        try:
            self.wb.Names(name).Delete()
        except Exception:
            pass

    def add_name(self, name, refers_to) -> int:
        self.wb.Names.Add(name, refers_to)
        return 2

    def cf_list(self, sheet, addr):
        fcs = self.ws(sheet).Range(addr).FormatConditions
        out = []
        for i in range(1, fcs.Count + 1):
            try:
                out.append(fcs(i).Formula1)
            except Exception:
                out.append("")
        return out

    def cf_reset(self, sheet, addr, colours_bgr) -> int:
        rng = self.ws(sheet).Range(addr)
        rng.FormatConditions.Delete()
        n = 2
        for i, c in enumerate(colours_bgr):
            n += self.cf_add(sheet, addr, i, c, rng)
        return n

    def cf_add(self, sheet, addr, index, bgr, rng=None) -> int:
        rng = rng if rng is not None else self.ws(sheet).Range(addr)
        fc = rng.FormatConditions.Add(XL_CELL_VALUE, XL_EQUAL, f"={index}")
        fc.Interior.Color = bgr
        fc.Font.Color = bgr
        return 6

    def cf_set_colour(self, sheet, addr, position, bgr) -> int:
        fc = self.ws(sheet).Range(addr).FormatConditions(position)
        fc.Interior.Color = bgr
        fc.Font.Color = bgr
        return 6

    def batch_begin(self) -> int:
        self.app.ScreenUpdating = False
        self._prev_calc = self.app.Calculation
        if self._prev_calc != XL_CALC_MANUAL:
            self.app.Calculation = XL_CALC_MANUAL
        return 3

    def batch_end(self) -> int:
        n = 1
        if self._prev_calc is not None and self._prev_calc != XL_CALC_MANUAL:
            self.app.Calculation = self._prev_calc
            n += 1
        self.app.ScreenUpdating = True
        return n

    def active_cell(self):
        ac = self.app.ActiveCell
        if ac is None:
            return None
        return (ac.Worksheet.Name, ac.Row, ac.Column)

    def save(self) -> None:
        self.wb.Save()

    def version(self) -> str:
        return str(self.app.Version)
