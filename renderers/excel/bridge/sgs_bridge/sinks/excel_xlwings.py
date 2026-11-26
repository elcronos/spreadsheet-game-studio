"""Excel sink over xlwings (Windows via COM, macOS via AppleScript).
NATIVE EXCEL UNVERIFIED in this environment.

    pip install xlwings websockets numpy openpyxl
    python -m sgs_bridge --sink excel-xlwings --workbook game.xlsx

On Windows, conditional formats are created through ``Range.api`` (COM).
On macOS, xlwings has no conditional-format API, so ``values-cf`` needs a
workbook prebuilt by scripts/excel/build_workbook.py (it already contains the
64 rules); a missing workbook is created that way automatically. Without CF
rules the sink falls back to ``interior``. Expect much lower FPS on macOS:
every xlwings call is an AppleScript round trip.
"""
from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Optional

from ..layout import Layout
from .excel_base import XL_CELL_VALUE, XL_EQUAL, ComOps, ExcelOps, ExcelSinkBase, _as_2d

IS_WINDOWS = sys.platform.startswith("win")


class XlwingsOps(ExcelOps):
    def __init__(self, book: Any):
        self.book = book
        self.app = book.app
        self.supports_cf = IS_WINDOWS
        self._prev_calc: Optional[str] = None

    def busy_error(self, e: BaseException) -> bool:
        if IS_WINDOWS:
            return ComOps.busy_error(self, e)  # type: ignore[arg-type]
        return "busy" in str(e).lower() or "-1712" in str(e)  # AppleEvent timed out

    def sh(self, name: str):
        return self.book.sheets[name]

    def sheet_names(self) -> List[str]:
        return [s.name for s in self.book.sheets]

    def add_sheet(self, name: str) -> None:
        self.book.sheets.add(name, after=self.book.sheets[-1])

    def set_values(self, sheet, addr, rows) -> int:
        self.sh(sheet).range(addr).value = [list(r) for r in rows]
        return 1

    def get_values(self, sheet, addr):
        return _as_2d(self.sh(sheet).range(addr).options(ndim=2).value)

    def get_formulas(self, sheet, addr):
        return _as_2d(self.sh(sheet).range(addr).formula)

    def set_formula(self, sheet, addr, formula) -> int:
        self.sh(sheet).range(addr).formula = formula
        return 1

    def set_fill(self, sheet, addr, rgb) -> int:
        r = self.sh(sheet).range(addr)
        r.color = None if rgb is None or rgb < 0 else ((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255)
        return 1

    def clear_sheet(self, sheet) -> int:
        s = self.sh(sheet)
        if IS_WINDOWS:
            s.api.Cells.FormatConditions.Delete()
        s.clear()
        return 2

    def set_col_width(self, sheet, addr, w) -> int:
        self.sh(sheet).range(addr).column_width = w
        return 1

    def set_row_height(self, sheet, addr, h) -> int:
        self.sh(sheet).range(addr).row_height = h
        return 1

    def set_number_format(self, sheet, addr, fmt) -> int:
        self.sh(sheet).range(addr).number_format = fmt
        return 1

    def set_bold(self, sheet, addr) -> int:
        self.sh(sheet).range(addr).font.bold = True
        return 1

    def set_visible(self, sheet, state) -> int:
        try:
            self.sh(sheet).visible = False
        except Exception:
            pass
        return 1

    def activate(self, sheet) -> None:
        self.sh(sheet).activate()

    def delete_name(self, name) -> None:
        try:
            self.book.names[name].delete()
        except Exception:
            pass

    def add_name(self, name, refers_to) -> int:
        self.book.names.add(name, refers_to)
        return 1

    def cf_list(self, sheet, addr):
        if not IS_WINDOWS:
            return None  # cannot enumerate on macOS; the base trusts the prebuilt workbook's signature
        fcs = self.sh(sheet).range(addr).api.FormatConditions
        return [fcs(i).Formula1 for i in range(1, fcs.Count + 1)]

    def cf_reset(self, sheet, addr, colours_bgr) -> int:
        if not IS_WINDOWS:
            raise RuntimeError("conditional formats cannot be created through xlwings on macOS; prebuild the workbook")
        rng = self.sh(sheet).range(addr).api
        rng.FormatConditions.Delete()
        for i, c in enumerate(colours_bgr):
            fc = rng.FormatConditions.Add(XL_CELL_VALUE, XL_EQUAL, f"={i}")
            fc.Interior.Color = c
            fc.Font.Color = c
        return 2 + 6 * len(colours_bgr)

    def cf_add(self, sheet, addr, index, bgr) -> int:
        if not IS_WINDOWS:
            return 0
        fc = self.sh(sheet).range(addr).api.FormatConditions.Add(XL_CELL_VALUE, XL_EQUAL, f"={index}")
        fc.Interior.Color = bgr
        fc.Font.Color = bgr
        return 6

    def cf_set_colour(self, sheet, addr, position, bgr) -> int:
        if not IS_WINDOWS:
            return 0
        fc = self.sh(sheet).range(addr).api.FormatConditions(position)
        fc.Interior.Color = bgr
        fc.Font.Color = bgr
        return 6

    def batch_begin(self) -> int:
        self.app.screen_updating = False
        self._prev_calc = self.app.calculation
        if self._prev_calc != "manual":
            self.app.calculation = "manual"
        return 3

    def batch_end(self) -> int:
        if self._prev_calc and self._prev_calc != "manual":
            self.app.calculation = self._prev_calc
        self.app.screen_updating = True
        return 2

    def active_cell(self):
        try:
            sel = self.app.selection
            if sel is None or sel.count != 1:
                return None
            return (sel.sheet.name, sel.row, sel.column)
        except Exception:
            return None

    def save(self) -> None:
        self.book.save()

    def version(self) -> str:
        return str(self.app.version)


class XlwingsSink(ExcelSinkBase):
    name = "excel-xlwings"

    def __init__(self, strategy: str = "auto", workbook: Optional[str] = None, visible: bool = True, **opts: Any):
        super().__init__(strategy, workbook, visible, **opts)
        self._deferred = False

    def thread_init(self) -> None:
        if IS_WINDOWS:
            try:
                import pythoncom

                pythoncom.CoInitialize()
            except ImportError:
                pass

    def _open_book(self):
        import xlwings as xw  # lazy

        path = os.path.abspath(self.workbook) if self.workbook else None
        if path:
            for app in xw.apps:
                for b in app.books:
                    if os.path.normcase(b.fullname) == os.path.normcase(path):
                        return b
            return xw.Book(path)
        return xw.Book()

    def _connect(self) -> ExcelOps:
        if self.workbook and not os.path.exists(self.workbook):
            self._deferred = True  # build it with openpyxl at the first hello (CF rules included)
            return _DeferredOps()
        book = self._open_book()
        try:
            book.app.visible = bool(self.visible)
        except Exception:
            pass
        return XlwingsOps(book)

    def open(self) -> Dict[str, Any]:
        self.ops = self._connect()
        return {"excelVersion": self.ops.version() if not self._deferred else "pending"}

    def layout(self, lay: Layout) -> None:
        if self._deferred:
            self._ensure_workbook_file(lay)
            self.ops = XlwingsOps(self._open_book())
            self._deferred = False
        super().layout(lay)


class _DeferredOps(ExcelOps):
    def version(self) -> str:
        return "pending"
