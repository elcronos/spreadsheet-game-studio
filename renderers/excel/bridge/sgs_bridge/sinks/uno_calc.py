"""LibreOffice Calc sink over UNO (a real desktop spreadsheet application).

Starts (or attaches to) ``soffice --accept=socket,...;urp;`` and writes a
real Calc document. Strategies:

* ``values-cf``: palette index per cell written with ``setDataArray`` over
  band rectangles; one conditional-format entry per palette index
  (``EQUAL i`` -> cell style ``sgs_p<i>`` with that background). A palette
  change only updates the 64-256 cell styles.
* ``interior``: ``CellBackColor`` set once per colour on an
  ``XSheetCellRanges`` container holding every rectangle of that colour.
* ``interior-runs`` (benchmark only): one ``CellBackColor`` call per rectangle.

``uno`` is imported lazily so the package imports on machines without
LibreOffice.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from ..layout import (
    CALC_COL_WIDTH_100MM, CALC_ROW_HEIGHT_100MM, GAME, INPUT, INPUT_HEADER, META, README, RULES, RULES_HEADER,
    TELEMETRY, TELEMETRY_HEADER, VARIABLE_HEADER, Layout, RuleRow, VarRow, calc_to_excel_formula, display_value,
    excel_to_calc_formula,
)
from ..planning import Rect
from ..state import FrameState
from .base import ROW_STYLE_RGB, Sink, SinkError, pad_rows

LOGICAL = 1024  # com.sun.star.util.NumberFormat.LOGICAL
CLEAR_ALL = 1023  # com.sun.star.sheet.CellFlags: everything


def _file_url(path: str) -> str:
    import uno

    return uno.systemPathToFileUrl(os.path.abspath(path))


def _pv(name: str, value: Any):
    from com.sun.star.beans import PropertyValue

    p = PropertyValue()
    p.Name, p.Value = name, value
    return p


def _filter_for(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    return {".xlsx": "Calc Office Open XML", ".xlsm": "Calc Office Open XML", ".xls": "MS Excel 97", ".ods": "calc8"}.get(ext, "calc8")


class UnoCalcSink(Sink):
    name = "calc-uno"
    # values-cf measured fastest for Calc in this repo's benchmarks (see references/excel-backend.md)
    default_strategy = "values-cf"
    extra_strategies = ("interior-runs",)
    # Measured here: each setDataArray costs ~1.5-2 ms fixed (+0.8 ms to create the range
    # object) vs ~0.6 us per cell, so one extra call is worth ~3000 redundant cells.
    call_cost_cells = 3000

    def __init__(self, strategy: str = "auto", workbook: Optional[str] = None, uno_host: str = "127.0.0.1", uno_port: int = 2002,
                 spawn: bool = True, visible: bool = False, soffice: Optional[str] = None, profile_dir: Optional[str] = None,
                 connect_timeout: float = 45.0, lock_controllers: bool = True, **opts: Any):
        super().__init__(strategy, workbook, **opts)
        self.uno_host, self.uno_port = uno_host, uno_port
        self.spawn, self.visible = spawn, visible
        self.soffice = soffice or shutil.which("soffice") or shutil.which("libreoffice") or "soffice"
        self.profile_dir = profile_dir
        self._own_profile = False
        self.connect_timeout = connect_timeout
        self.lock_controllers = lock_controllers
        self.proc: Optional[subprocess.Popen] = None
        self.ctx = self.desktop = self.doc = None
        self.game = None
        self.game_index = 0
        self.cf_count = 0
        self.styles: Dict[int, Any] = {}
        self.var_sheet_objs: Dict[str, Tuple[Any, int]] = {}
        self.rules_sheet = None
        self.input_actions: List[str] = []
        self.sheet_sizes: Dict[str, Tuple[int, int]] = {}
        self.app_version = "LibreOffice"
        self._uno = None

    # ---- connection -----------------------------------------------------------------
    def _resolve(self):
        import uno

        local = uno.getComponentContext()
        res = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
        return res.resolve(f"uno:socket,host={self.uno_host},port={self.uno_port};urp;StarOffice.ComponentContext")

    def open(self) -> Dict[str, Any]:
        import uno  # noqa: F401  (raises ImportError with a clear message if pyuno is missing)

        self._uno = uno
        ctx = None
        try:
            ctx = self._resolve()
        except Exception:
            if not self.spawn:
                raise SinkError(f"no soffice listening on {self.uno_host}:{self.uno_port} (start it with --accept or drop --no-spawn-soffice)")
        if ctx is None:
            if self.profile_dir is None:
                self.profile_dir = tempfile.mkdtemp(prefix="sgs_lo_profile_")
                self._own_profile = True
            args = [self.soffice, "--invisible", "--nologo", "--norestore", "--nodefault", "--nolockcheck",
                    f"-env:UserInstallation={_file_url(self.profile_dir)}",
                    f"--accept=socket,host={self.uno_host},port={self.uno_port};urp;"]
            if not self.visible:
                args.insert(1, "--headless")
            self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + self.connect_timeout
            while True:
                try:
                    ctx = self._resolve()
                    break
                except Exception:
                    if self.proc.poll() is not None:
                        raise SinkError(f"soffice exited with code {self.proc.returncode}")
                    if time.monotonic() > deadline:
                        self._kill()
                        raise SinkError("timed out connecting to soffice")
                    time.sleep(0.25)
        self.ctx = ctx
        self.desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        hidden = (_pv("Hidden", not self.visible),)
        if self.workbook and os.path.exists(self.workbook):
            self.doc = self.desktop.loadComponentFromURL(_file_url(self.workbook), "_blank", 0, hidden)
        else:
            self.doc = self.desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, hidden)
        if self.doc is None:
            raise SinkError("Calc could not open the document")
        try:
            cp = ctx.ServiceManager.createInstanceWithContext("com.sun.star.configuration.ConfigurationProvider", ctx)
            node = cp.createInstanceWithArguments("com.sun.star.configuration.ConfigurationAccess", (_pv("nodepath", "/org.openoffice.Setup/Product"),))
            self.app_version = f"{node.getByName('ooName')} {node.getByName('ooSetupVersionAboutBox')}"
        except Exception:
            pass
        return {"appVersion": self.app_version}

    def _kill(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(5)
        self.proc = None

    # ---- layout ---------------------------------------------------------------------
    def layout(self, lay: Layout) -> None:
        super().layout(lay)
        uno = self._uno
        doc = self.doc
        sheets = doc.Sheets
        try:
            # automatic optimal row heights are recomputed after every write; GAME rows have fixed
            # heights anyway. Measured: ~35% faster setDataArray with this off.
            doc.IsAdjustHeightEnabled = False
        except Exception:
            pass
        owned = lay.all_sheets()
        tmp = "_sgs_tmp"
        if not sheets.hasByName(tmp):
            sheets.insertNewByName(tmp, sheets.Count)
        # drop names we own, then our sheets, then recreate in contract order
        names = doc.NamedRanges
        for nm in list(lay.defined_names()) + list(getattr(self, "_prev_names", [])):
            if names.hasByName(nm):
                names.removeByName(nm)
        for nm in owned:
            if nm != README and sheets.hasByName(nm):
                sheets.removeByName(nm)
        # leave non-owned sheets (e.g. Calc's default "Sheet1") alone unless it is the blank default
        for nm in list(sheets.ElementNames):
            if nm not in owned and nm != tmp and nm.lower() in ("sheet1", "tabelle1", "feuil1", "hoja1"):
                sh = sheets.getByName(nm)
                if not sh.queryContentCells(1023).Count:
                    sheets.removeByName(nm)
        for i, nm in enumerate(owned):
            if not sheets.hasByName(nm):
                sheets.insertNewByName(nm, min(i, sheets.Count))
        sheets.removeByName(tmp)
        self.game = sheets.getByName(GAME)
        self.game_index = owned.index(GAME)
        for i in range(sheets.Count):
            if sheets.getByIndex(i).Name == GAME:
                self.game_index = i
        self._layout_game(lay)
        self._layout_variables(lay)
        self._layout_rules(lay)
        for s in lay.custom_sheets:
            if s["columns"]:
                self.write_sheet(s["name"], s["columns"], [])
        self._table(sheets.getByName(TELEMETRY), [TELEMETRY_HEADER], header=True)
        self._layout_input(lay)
        meta = sheets.getByName(META)
        self._table(meta, [["signature", lay.signature()], ["width", float(lay.width)], ["height", float(lay.height)], ["strategy", self.strategy]])
        meta.IsVisible = False
        if sheets.hasByName(README) and not sheets.getByName(README).queryContentCells(1023).Count:
            self._table(sheets.getByName(README), [["Spreadsheet Game Studio - LibreOffice Calc bridge"], ["GAME is written live by the bridge (python -m sgs_bridge --sink calc-uno)."], ["Edit column B on PLAYER/VEHICLES/WORLD, or formulas in RULES!B, while the game runs."]])
        self._prev_names = list(lay.defined_names())
        self.sheet_sizes = {}
        ctrl = doc.getCurrentController()
        if ctrl is not None:
            try:
                ctrl.setActiveSheet(self.game)
            except Exception:
                pass

    def _locale(self):
        return self._uno.createUnoStruct("com.sun.star.lang.Locale")

    def _numfmt(self, code: str) -> int:
        nf = self.doc.NumberFormats
        loc = self._locale()
        k = nf.queryKey(code, loc, False)
        if k == -1:
            k = nf.addNew(code, loc)
        return k

    def _layout_game(self, lay: Layout) -> None:
        g = self.game
        oc, orow = lay.origin_col0, lay.origin_row0
        g.getCellRangeByPosition(oc, 0, oc + lay.width - 1, 0).getColumns().Width = CALC_COL_WIDTH_100MM
        g.getCellRangeByPosition(0, orow, 0, orow + lay.height - 1).getRows().Height = CALC_ROW_HEIGHT_100MM
        frame = g.getCellRangeByPosition(oc, orow, oc + lay.width - 1, orow + lay.height - 1)
        frame.NumberFormat = self._numfmt(";;;")
        self.frame_range = frame
        g.getCellByPosition(0, 0).setString(f"{lay.title} - waiting for first frame")
        g.getCellByPosition(0, 1).setString("")
        self.cf_count = 0
        self.styles = {}
        if self.strategy == "values-cf":
            pal = lay.palette or [0]
            self._ensure_styles(pal)
            self._add_cf_entries(len(pal))

    def _ensure_styles(self, pal: Sequence[int]) -> int:
        fam = self.doc.StyleFamilies.getByName("CellStyles")
        calls = 0
        for i, c in enumerate(pal):
            nm = f"sgs_p{i}"
            st = self.styles.get(i)
            if st is None:
                if fam.hasByName(nm):
                    st = fam.getByName(nm)
                else:
                    st = self.doc.createInstance("com.sun.star.style.CellStyle")
                    fam.insertByName(nm, st)
                    calls += 2
                self.styles[i] = st
            st.CellBackColor = int(c)
            st.CharColor = int(c)
            calls += 2
        return calls

    def _add_cf_entries(self, count: int) -> int:
        if count <= self.cf_count:
            return 0
        eq = self._uno.Enum("com.sun.star.sheet.ConditionOperator", "EQUAL")
        cf = self.frame_range.ConditionalFormat
        for i in range(self.cf_count, count):
            cf.addNew((_pv("Operator", eq), _pv("Formula1", str(i)), _pv("StyleName", f"sgs_p{i}")))
        self.frame_range.ConditionalFormat = cf
        n = count - self.cf_count
        self.cf_count = count
        return n + 2

    def _table(self, sheet, rows: List[List[Any]], r0: int = 0, c0: int = 0, header: bool = False):
        if not rows:
            return
        w = max(len(r) for r in rows)
        data = tuple(tuple(_cell(v) for v in (list(r) + [""] * (w - len(r)))) for r in rows)
        rng = sheet.getCellRangeByPosition(c0, r0, c0 + w - 1, r0 + len(rows) - 1)
        rng.setDataArray(data)
        if header:
            sheet.getCellRangeByPosition(c0, r0, c0 + w - 1, r0).CharWeight = 150.0  # BOLD
        return rng

    def _layout_variables(self, lay: Layout) -> None:
        from com.sun.star.table import CellAddress

        sheets = self.doc.Sheets
        names = self.doc.NamedRanges
        logical = self.doc.NumberFormats.getStandardFormat(LOGICAL, self._locale())
        self.var_sheet_objs = {}
        for sheet_name, rows in lay.var_sheets.items():
            sh = sheets.getByName(sheet_name)
            table = [VARIABLE_HEADER]
            for v in rows:
                val = display_value(v, v.default)
                table.append([v.label, (1.0 if val else 0.0) if v.type == "bool" else val, _opt(v.min), _opt(v.max), v.unit, v.description + (f" ({', '.join(v.options)})" if v.options else ""), v.key])
            self._table(sh, table, header=True)
            for v in rows:
                if v.type == "bool":
                    sh.getCellByPosition(1, v.row - 1).NumberFormat = logical
            sh.getCellRangeByPosition(1, 1, 1, len(rows)).CellBackColor = 0xFFF8E1  # editable column tint
            sh.getColumns().getByIndex(0).Width = 7000
            sh.getColumns().getByIndex(1).Width = 2800
            sh.getColumns().getByIndex(5).Width = 9000
            self.var_sheet_objs[sheet_name] = (sh, len(rows))
            for v in rows:
                if v.name and v.name in lay.defined_names():
                    names.addNewByName(v.name, f"${sheet_name}.$B${v.row}", CellAddress(0, 0, 0), 0)

    def _layout_rules(self, lay: Layout) -> None:
        from com.sun.star.table import CellAddress

        sh = self.doc.Sheets.getByName(RULES)
        self.rules_sheet = sh
        table = [RULES_HEADER] + [[r.name, "", "", r.min, r.max, r.description] for r in lay.rules]
        self._table(sh, table, header=True)
        names = self.doc.NamedRanges
        for r in lay.rules:
            if r.name in lay.defined_names():
                names.addNewByName(r.name, f"${RULES}.$B${r.row}", CellAddress(0, 0, 0), 0)
        for r in lay.rules:  # formulas after all names exist
            sh.getCellByPosition(1, r.row - 1).setFormula(excel_to_calc_formula(r.formula))
        if lay.rules:
            sh.getCellRangeByPosition(1, 1, 1, len(lay.rules)).CellBackColor = 0xFFF8E1
        sh.getColumns().getByIndex(0).Width = 4500
        sh.getColumns().getByIndex(1).Width = 9000
        sh.getColumns().getByIndex(5).Width = 9000

    def _layout_input(self, lay: Layout) -> None:
        sh = self.doc.Sheets.getByName(INPUT)
        acts = lay.input_actions()
        self.input_actions = [a for a, _ in acts]
        self._table(sh, [INPUT_HEADER] + [[a, 0.0, 0.0, "|".join(k)] for a, k in acts], header=True)
        sh.IsVisible = False
        self.input_sheet = sh

    # ---- frames ---------------------------------------------------------------------
    def _begin_frame(self) -> int:
        if self.lock_controllers:
            self.doc.lockControllers()
            return 1
        return 0

    def _end_frame(self) -> int:
        if self.lock_controllers:
            self.doc.unlockControllers()
            return 1
        return 0

    def _apply_palette(self, fs: FrameState) -> int:
        pal = [int(c) for c in fs.palette[:fs.palette_count]]
        changed = sorted(i for i in fs.changed_slots if i < len(pal))
        calls = 0
        missing = [i for i in changed if i not in self.styles]
        if missing:
            calls += self._ensure_styles(pal)  # creates the new ones too
        else:
            for i in changed:
                st = self.styles[i]
                st.CellBackColor = pal[i]
                st.CharColor = pal[i]
                calls += 2
        calls += self._add_cf_entries(len(pal))
        return calls

    def _write_band(self, rect: Rect, values: np.ndarray) -> int:
        r0, r1, c0, c1 = rect
        lay = self.layout_
        rng = self.game.getCellRangeByPosition(c0 + lay.origin_col0, r0 + lay.origin_row0, c1 - 1 + lay.origin_col0, r1 - 1 + lay.origin_row0)
        rng.setDataArray(tuple(map(tuple, values.astype(np.float64).tolist())))
        return 2

    def _fill_rects(self, rgb: int, rects: Sequence[Rect]) -> int:
        from com.sun.star.table import CellRangeAddress

        lay = self.layout_
        oc, orow, si = lay.origin_col0, lay.origin_row0, self.game_index
        if self.strategy == "interior-runs":
            g = self.game
            for r0, r1, c0, c1 in rects:
                g.getCellRangeByPosition(c0 + oc, r0 + orow, c1 - 1 + oc, r1 - 1 + orow).CellBackColor = rgb
            return 2 * len(rects)
        if len(rects) == 1:
            r0, r1, c0, c1 = rects[0]
            self.game.getCellRangeByPosition(c0 + oc, r0 + orow, c1 - 1 + oc, r1 - 1 + orow).CellBackColor = rgb
            return 2
        ranges = self.doc.createInstance("com.sun.star.sheet.SheetCellRanges")
        ranges.addRangeAddresses(tuple(CellRangeAddress(si, c0 + oc, r0 + orow, c1 - 1 + oc, r1 - 1 + orow) for r0, r1, c0, c1 in rects), False)
        ranges.CellBackColor = rgb
        return 3

    # ---- HUD / state ------------------------------------------------------------------
    def write_hud(self, line1: str, line2: str) -> None:
        self.game.getCellByPosition(0, 0).setString(line1)
        self.game.getCellByPosition(0, 1).setString(line2)

    def read_editables(self):
        lay = self.layout_
        vars_: Dict[str, Any] = {}
        for sheet_name, rows in lay.var_sheets.items():
            sh, n = self.var_sheet_objs[sheet_name]
            if n == 0:
                continue
            data = sh.getCellRangeByPosition(1, 1, 1, n).getDataArray()
            for v, (val,) in zip(rows, data):
                vars_[v.key] = val
        rules: Dict[str, Tuple[str, Any]] = {}
        if lay.rules:
            rng = self.rules_sheet.getCellRangeByPosition(1, 1, 1, len(lay.rules))
            forms = rng.getFormulaArray()
            vals = rng.getDataArray()
            for r, (f,), (val,) in zip(lay.rules, forms, vals):
                rules[r.name] = (calc_to_excel_formula(f), val if isinstance(val, float) else None)
        return vars_, rules

    def write_values(self, writes: Sequence[Tuple[VarRow, Any]]) -> None:
        for v, val in writes:
            sh = self.var_sheet_objs[v.sheet][0]
            cell = sh.getCellByPosition(1, v.row - 1)
            d = display_value(v, val)
            if isinstance(d, bool):
                cell.setValue(1.0 if d else 0.0)
            elif isinstance(d, (int, float)):
                cell.setValue(float(d))
            else:
                cell.setString(str(d))

    def write_rule_values(self, writes: Sequence[Tuple[RuleRow, Any]]) -> None:
        for r, val in writes:
            cell = self.rules_sheet.getCellByPosition(2, r.row - 1)
            if isinstance(val, (int, float)) and not isinstance(val, bool):
                cell.setValue(float(val))
            else:
                cell.setString("" if val is None else str(val))

    def write_rule_formulas(self, writes: Sequence[Tuple[RuleRow, str]]) -> Dict[str, str]:
        out = {}
        for r, f in writes:
            f = f.strip()
            if not f.startswith("="):
                f = "=" + f
            cell = self.rules_sheet.getCellByPosition(1, r.row - 1)
            cell.setFormula(excel_to_calc_formula(f))
            out[r.name] = calc_to_excel_formula(cell.getFormula())
        return out

    def _sheet(self, name: str):
        sheets = self.doc.Sheets
        if not sheets.hasByName(name):
            sheets.insertNewByName(name, sheets.Count)
        return sheets.getByName(name)

    def write_sheet(self, name: str, columns: List[str], rows: List[Dict[str, Any]]) -> None:
        sh = self._sheet(name)
        table, styles = pad_rows(columns, rows)
        prev = self.sheet_sizes.get(name)
        h, w = len(table), len(table[0])
        if prev and (prev[0] > h or prev[1] > w):
            sh.getCellRangeByPosition(0, 0, max(prev[1], w) - 1, max(prev[0], h) - 1).clearContents(CLEAR_ALL)
        self._table(sh, table, header=True)
        for i, st in enumerate(styles):
            if i == 0:
                continue
            rgb = ROW_STYLE_RGB.get(st or "", -1)
            sh.getCellRangeByPosition(0, i, w - 1, i).CellBackColor = rgb
        self.sheet_sizes[name] = (h, w)

    def write_telemetry(self, items: List[Tuple[str, Any]]) -> None:
        sh = self._sheet(TELEMETRY)
        table = [TELEMETRY_HEADER] + [[k, v] for k, v in items]
        prev = self.sheet_sizes.get(TELEMETRY)
        if prev and prev[0] > len(table):
            sh.getCellRangeByPosition(0, len(table), 1, prev[0] - 1).clearContents(CLEAR_ALL)
        self._table(sh, table, header=True)
        self.sheet_sizes[TELEMETRY] = (len(table), 2)

    def active_cell(self):
        try:
            ctrl = self.doc.getCurrentController()
            if ctrl is None:
                return None
            sel = ctrl.getSelection()
            if sel is None or not sel.supportsService("com.sun.star.sheet.SheetCell"):
                return None
            a = sel.getCellAddress()
            return (self.doc.Sheets.getByIndex(a.Sheet).Name, a.Row + 1, a.Column + 1)
        except Exception:
            return None

    def read_input(self):
        if not self.input_actions:
            return None
        data = self.input_sheet.getCellRangeByPosition(0, 1, 1, len(self.input_actions)).getDataArray()
        return {str(a): (b if isinstance(b, float) else 0.0) for a, b in data if a}

    # ---- readback for tests / inspection ------------------------------------------------
    def read_back_colors(self) -> np.ndarray:
        """(h, w) CellBackColor of the GAME range (one UNO call per cell; tests only)."""
        lay = self.layout_
        out = np.zeros((lay.height, lay.width), dtype=np.int64)
        g = self.game
        for y in range(lay.height):
            for x in range(lay.width):
                out[y, x] = g.getCellByPosition(x + lay.origin_col0, y + lay.origin_row0).CellBackColor
        return out

    def read_back_values(self) -> np.ndarray:
        lay = self.layout_
        data = self.frame_range.getDataArray()
        return np.array([[np.nan if v == "" or v is None else v for v in row] for row in data], dtype=float)

    def cf_entries(self) -> List[Tuple[str, str, int]]:
        """[(Formula1, StyleName, style CellBackColor)] of the GAME range conditional format."""
        cf = self.frame_range.ConditionalFormat
        fam = self.doc.StyleFamilies.getByName("CellStyles")
        out = []
        for i in range(cf.Count):
            e = cf.getByIndex(i)
            out.append((e.getFormula1(), e.getStyleName(), fam.getByName(e.getStyleName()).CellBackColor))
        return out

    # ---- save / close -------------------------------------------------------------------
    def save(self) -> None:
        if self.doc is None or not self.workbook:
            return
        self.doc.storeToURL(_file_url(self.workbook), (_pv("FilterName", _filter_for(self.workbook)), _pv("Overwrite", True)))

    def close(self) -> None:
        try:
            if self.doc is not None:
                self.doc.close(True)
        except Exception:
            pass
        self.doc = None
        if self.proc is not None:
            try:
                self.desktop.terminate()
            except Exception:
                pass
            try:
                self.proc.wait(8)
            except subprocess.TimeoutExpired:
                pass
            self._kill()
        if self._own_profile and self.profile_dir:
            shutil.rmtree(self.profile_dir, ignore_errors=True)


def _cell(v: Any) -> Any:
    if v is None:
        return ""
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float, np.integer, np.floating)):
        return float(v)
    return str(v)


def _opt(v: Optional[float]) -> Any:
    return "" if v is None else v
