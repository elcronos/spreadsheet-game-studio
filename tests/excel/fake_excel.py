"""A fake Excel COM object model (late-bound Dispatch shape) for Linux tests.

It is NOT Excel. It implements just enough of Application / Workbook /
Worksheet / Range / Interior / FormatConditions / Names semantics for
ComSink's call sequences to be checked (addresses, BGR colours, 2D value
arrays, CF rules, defined names, busy errors). Real Excel behaviour and
performance remain UNVERIFIED (use renderers/excel/native_test.py).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import helpers  # noqa: F401  (sys.path)
from sgs_bridge.planning import parse_address_list

RPC_E_CALL_REJECTED = -2147418111


class ComError(Exception):
    def __init__(self, hresult: int, msg: str = "Call was rejected by callee."):
        super().__init__(hresult, msg)
        self.hresult = hresult


class FakeApp:
    def __init__(self):
        self.Version = "16.0 (fake)"
        self._screen = True
        self.screen_toggles = 0
        self.Calculation = -4105
        self.calc_toggles = 0
        self.busy = 0  # raise RPC_E_CALL_REJECTED for the next N guarded calls
        self.calls = 0
        self.wb: Optional[FakeWorkbook] = None
        self.ActiveCell = None

    def _tick(self):
        self.calls += 1
        if self.busy:
            self.busy -= 1
            raise ComError(RPC_E_CALL_REJECTED)

    @property
    def ScreenUpdating(self):
        return self._screen

    @ScreenUpdating.setter
    def ScreenUpdating(self, v):
        self._tick()
        self.screen_toggles += 1
        self._screen = v

    def __setattr__(self, k, v):
        if k == "Calculation" and "calc_toggles" in self.__dict__:
            self.__dict__["calc_toggles"] += 1
        object.__setattr__(self, k, v)


class _Sheets:
    def __init__(self, wb):
        self.wb = wb

    def __call__(self, key):
        if isinstance(key, int):
            return self.wb._sheets[key - 1]
        for s in self.wb._sheets:
            if s.Name == key:
                return s
        raise ComError(-2147352565, f"no sheet {key}")

    @property
    def Count(self):
        return len(self.wb._sheets)

    def Add(self, before=None, after=None):
        s = FakeSheet(self.wb, f"Sheet{len(self.wb._sheets) + 1}")
        self.wb._sheets.append(s)
        return s


class _Names:
    def __init__(self, wb):
        self.wb = wb

    def __call__(self, name):
        if name not in self.wb.names:
            raise ComError(-2147352565, "no name")
        wb = self.wb

        class N:
            RefersTo = wb.names[name]

            def Delete(self_inner):
                del wb.names[name]
        return N()

    def Add(self, name, refers_to):
        self.wb.names[name] = refers_to


class FakeWorkbook:
    def __init__(self, app: FakeApp):
        self.app = app
        app.wb = self
        self._sheets: List[FakeSheet] = [FakeSheet(self, "Sheet1")]
        self.Worksheets = _Sheets(self)
        self.names: Dict[str, str] = {}
        self.Names = _Names(self)
        self.saved = 0
        self.FullName = "fake.xlsx"

    def Save(self):
        self.saved += 1


class FakeSheet:
    def __init__(self, wb: FakeWorkbook, name: str):
        self.wb = wb
        self.Name = name
        self.values: Dict[Tuple[int, int], Any] = {}
        self.formulas: Dict[Tuple[int, int], str] = {}
        self.fills: Dict[Tuple[int, int], int] = {}
        self.number_formats: Dict[str, str] = {}
        self.col_widths: Dict[str, float] = {}
        self.row_heights: Dict[str, float] = {}
        self.cf: Dict[str, List[Dict[str, Any]]] = {}
        self.Visible = -1
        self.active = False

    def Range(self, addr: str) -> "FakeRange":
        self.wb.app._tick()
        return FakeRange(self, addr)

    @property
    def Cells(self):
        return FakeRange(self, "*")

    def Activate(self):
        self.active = True


class _Interior:
    def __init__(self, rng):
        self.rng = rng

    def __setattr__(self, k, v):
        if k == "rng":
            object.__setattr__(self, k, v)
            return
        self.rng.sheet.wb.app._tick()
        for cell in self.rng.cells():
            if k == "Color":
                self.rng.sheet.fills[cell] = v
            elif k == "ColorIndex":
                self.rng.sheet.fills.pop(cell, None)


class _Font:
    def __init__(self):
        self.Bold = False
        self.Color = None


class _FC:
    def __init__(self, entry):
        self.entry = entry
        self.Formula1 = entry["formula1"]
        outer = self

        class I:
            def __setattr__(self_i, k, v):
                outer.entry["interior"] = v
        self.Interior = I()

        class F:
            def __setattr__(self_f, k, v):
                outer.entry["font"] = v
        self.Font = F()


class _FCs:
    def __init__(self, rng):
        self.rng = rng

    def _list(self):
        return self.rng.sheet.cf.setdefault(self.rng.addr, [])

    @property
    def Count(self):
        return len(self._list())

    def __call__(self, i):
        return _FC(self._list()[i - 1])

    def Add(self, type_, operator, formula1):
        assert (type_, operator) == (1, 3), "xlCellValue / xlEqual"
        e = {"formula1": formula1, "interior": None, "font": None}
        self._list().append(e)
        return _FC(e)

    def Delete(self):
        if self.rng.addr == "*":
            self.rng.sheet.cf.clear()
        else:
            self.rng.sheet.cf.pop(self.rng.addr, None)


class FakeRange:
    def __init__(self, sheet: FakeSheet, addr: str):
        self.__dict__["sheet"] = sheet
        self.__dict__["addr"] = addr
        self.__dict__["Interior"] = _Interior(self)
        self.__dict__["Font"] = _Font()
        self.__dict__["FormatConditions"] = _FCs(self)

    def areas(self):
        if self.addr == "*":
            return []
        if ":" in self.addr and all(p.replace("$", "").isdigit() for p in self.addr.split(":")):
            return []  # row range "4:13"
        return parse_address_list(self.addr)

    def cells(self):
        for r0, r1, c0, c1 in self.areas():
            for r in range(r0, r1 + 1):
                for c in range(c0, c1 + 1):
                    yield (r, c)

    def _shape(self):
        (r0, r1, c0, c1), = self.areas()
        return r0, r1, c0, c1

    @property
    def Value(self):
        r0, r1, c0, c1 = self._shape()
        v = self.sheet.values
        rows = tuple(tuple(v.get((r, c)) for c in range(c0, c1 + 1)) for r in range(r0, r1 + 1))
        return rows[0][0] if (r0, c0) == (r1, c1) else rows

    @property
    def Formula(self):
        r0, r1, c0, c1 = self._shape()
        def f(r, c):
            if (r, c) in self.sheet.formulas:
                return self.sheet.formulas[(r, c)]
            x = self.sheet.values.get((r, c))
            return "" if x is None else (str(int(x)) if isinstance(x, float) and x.is_integer() else str(x))
        rows = tuple(tuple(f(r, c) for c in range(c0, c1 + 1)) for r in range(r0, r1 + 1))
        return rows[0][0] if (r0, c0) == (r1, c1) else rows

    def Clear(self):
        s = self.sheet
        if self.addr == "*":
            s.values.clear(); s.formulas.clear(); s.fills.clear(); s.number_formats.clear()

    def __setattr__(self, k, v):
        s = self.sheet
        if k == "Value":
            r0, r1, c0, c1 = self._shape()
            if not isinstance(v, tuple):
                v = ((v,),)
            assert len(v) == r1 - r0 + 1 and all(len(row) == c1 - c0 + 1 for row in v), (self.addr, len(v))
            for i, row in enumerate(v):
                for j, x in enumerate(row):
                    s.values[(r0 + i, c0 + j)] = float(x) if isinstance(x, int) and not isinstance(x, bool) else x
                    s.formulas.pop((r0 + i, c0 + j), None)
        elif k == "Formula":
            for cell in self.cells():
                s.formulas[cell] = v
                s.values[cell] = None
        elif k == "NumberFormat":
            s.number_formats[self.addr] = v
        elif k == "ColumnWidth":
            s.col_widths[self.addr] = v
        elif k == "RowHeight":
            s.row_heights[self.addr] = v
        elif k in ("UseStandardWidth", "UseStandardHeight"):
            pass
        else:
            raise AttributeError(k)


def new_fake_excel():
    app = FakeApp()
    wb = FakeWorkbook(app)
    return app, wb
