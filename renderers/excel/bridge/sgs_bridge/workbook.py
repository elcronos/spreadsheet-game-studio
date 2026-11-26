"""Build a contract-conformant .xlsx with openpyxl (no Excel needed).

Used by scripts/excel/build_workbook.py (prebuilt workbook for Excel), the
snapshot sink, and the Excel sinks when the target workbook does not exist.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

import numpy as np

from .layout import (
    EXCEL_ROW_HEIGHT_PT, GAME, INPUT, INPUT_HEADER, META, README, RULES, RULES_HEADER, TELEMETRY, TELEMETRY_HEADER,
    VARIABLE_HEADER, Layout, column_name, display_value, quote_sheet,
)

# openpyxl stores the raw OOXML width. ~0.85 is a 6 px column at the default
# 7 px max digit width (OOXML: width = trunc((px)/7*256)/256); LibreOffice
# imports it as ~1.6 mm (checked in tests/excel/test_workbook.py).
XLSX_COL_WIDTH = 0.85
EDITABLE_FILL = "FFF8E1"


def _hex(c: int) -> str:
    return f"{int(c) & 0xFFFFFF:06X}"


def readme_lines(lay: Layout) -> List[str]:
    lines = [
        f"{lay.title} - Spreadsheet Game Studio workbook",
        "",
        "This workbook is a live game display and control panel.",
        "GAME: one cell per pixel from A4. Rows 1-2 show the HUD. Do not type in the frame area.",
        "PLAYER / VEHICLES / WORLD: edit column B (Value) while the game runs; the game validates every edit.",
        "RULES: column B holds real formulas over the defined names (e.g. =BaseBudget*AlertLevel). Edit them to change game rules.",
        "MISSIONS / TELEMETRY: written by the game.",
        "",
        "Setup (Windows Excel):",
        "  1. pip install websockets numpy openpyxl pywin32 xlwings",
        "  2. Open this workbook in Excel (keep it open).",
        "  3. cd renderers/excel/bridge && python -m sgs_bridge --sink excel-com --workbook <this file>",
        "  4. Serve the game from localhost and open it with ?bridge=ws://127.0.0.1:8765/sgs",
        "  5. Optional keyboard capture in Excel: import renderers/excel/vba/SGSInput.bas, run SGS_Start (F12 toggles).",
        "",
        "Controls:",
    ]
    lines += [f"  {c[0]}  -  {c[1] if len(c) > 1 else ''}" for c in lay.controls if c] if lay.controls else ["  (see game)"]
    lines += ["", f"Frame: {lay.width}x{lay.height} cells, palette {lay.palette_mode} ({len(lay.palette)} colours)", f"Layout signature: {lay.signature()}"]
    return lines


def build_workbook(lay: Layout, indices: Optional[np.ndarray] = None, palette: Optional[Iterable[int]] = None,
                   fills: bool = False, conditional_formats: bool = True, strategy: str = "values-cf",
                   values: Optional[Dict[str, Any]] = None, sheets: Optional[Dict[str, List[List[Any]]]] = None,
                   hud: Optional[List[str]] = None):
    """Return an openpyxl Workbook laid out per the contract.

    indices: optional (h, w) frame to pre-fill. ``fills`` paints each frame
    cell with its pixel colour (snapshot); otherwise the palette index is
    written as the cell value (values-cf).
    """
    from openpyxl import Workbook
    from openpyxl.formatting.rule import CellIsRule
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.workbook.defined_name import DefinedName
    from openpyxl.worksheet.datavalidation import DataValidation

    pal = [int(c) for c in (palette if palette is not None else lay.palette)]
    values = values or {}
    wb = Workbook()
    ws = wb.active
    ws.title = GAME
    # ---- GAME -----------------------------------------------------------------
    for x in range(lay.width):
        ws.column_dimensions[column_name(lay.origin_col0 + x)].width = XLSX_COL_WIDTH
    for y in range(lay.height):
        ws.row_dimensions[lay.frame_first_row + y].height = EXCEL_ROW_HEIGHT_PT
    h1, h2 = (hud or [f"{lay.title} - start the bridge and the game", "Objective appears here"])[:2]
    ws.cell(1, 1, h1).font = Font(bold=True)
    ws.cell(2, 1, h2)
    ws.sheet_view.showGridLines = False
    ws.sheet_view.zoomScale = 100
    frame_ref = lay.frame_range_a1()
    if conditional_formats and pal:
        for i, c in enumerate(pal):
            hx = _hex(c)
            ws.conditional_formatting.add(frame_ref, CellIsRule(operator="equal", formula=[str(i)], fill=PatternFill(start_color=hx, end_color=hx, fill_type="solid"), font=Font(color=hx)))
    if indices is not None:
        h, w = indices.shape
        fill_cache: Dict[int, Any] = {}
        hide = ";;;"
        for y in range(h):
            r = lay.frame_first_row + y
            for x in range(w):
                i = int(indices[y, x])
                cell = ws.cell(r, lay.frame_first_col + x)
                if fills:
                    f = fill_cache.get(i)
                    if f is None:
                        hx = _hex(pal[i] if i < len(pal) else 0)
                        f = fill_cache[i] = PatternFill(start_color=hx, end_color=hx, fill_type="solid")
                    cell.fill = f
                if not fills or conditional_formats:
                    cell.value = i
                    cell.number_format = hide
    # ---- variable sheets ---------------------------------------------------------
    bold = Font(bold=True)
    ed_fill = PatternFill(start_color=EDITABLE_FILL, end_color=EDITABLE_FILL, fill_type="solid")
    for sheet, rows in lay.var_sheets.items():
        vs = wb.create_sheet(sheet)
        vs.append(VARIABLE_HEADER)
        for c in vs[1]:
            c.font = bold
        for v in rows:
            val = display_value(v, values.get(v.key, v.default))
            vs.append([v.label, val, v.min, v.max, v.unit, v.description, v.key])
            b = vs.cell(v.row, 2)
            b.fill = ed_fill
            if v.read_only:
                b.font = Font(italic=True, color="808080")
            if v.type == "enum" and v.options:
                dv = DataValidation(type="list", formula1='"' + ",".join(v.options) + '"', allow_blank=False, showErrorMessage=True, errorTitle=v.label, error="Choose one of: " + ", ".join(v.options))
                vs.add_data_validation(dv)
                dv.add(b.coordinate)
            elif v.type == "bool":
                dv = DataValidation(type="list", formula1='"TRUE,FALSE"', showErrorMessage=True, error="TRUE or FALSE")
                vs.add_data_validation(dv)
                dv.add(b.coordinate)
            elif v.type in ("number", "int") and v.min is not None and v.max is not None:
                dv = DataValidation(type="whole" if v.type == "int" else "decimal", operator="between", formula1=str(v.min), formula2=str(v.max), showErrorMessage=True, errorTitle=v.label, error=f"{v.label} must be between {v.min:g} and {v.max:g}")
                vs.add_data_validation(dv)
                dv.add(b.coordinate)
        vs.column_dimensions["A"].width = 38
        vs.column_dimensions["B"].width = 14
        vs.column_dimensions["F"].width = 50
        vs.column_dimensions["G"].width = 22
        vs.freeze_panes = "A2"
    # ---- RULES -----------------------------------------------------------------
    rs = wb.create_sheet(RULES)
    rs.append(RULES_HEADER)
    for c in rs[1]:
        c.font = bold
    for r in lay.rules:
        rs.append([r.name, r.formula, None, r.min, r.max, r.description])
        rs.cell(r.row, 2).fill = ed_fill
    rs.column_dimensions["A"].width = 18
    rs.column_dimensions["B"].width = 46
    rs.column_dimensions["F"].width = 50
    rs.freeze_panes = "A2"
    # ---- custom sheets / telemetry / readme / input / meta ----------------------
    for s in lay.custom_sheets:
        cs = wb.create_sheet(s["name"])
        table = (sheets or {}).get(s["name"])
        if table:
            for row in table:
                cs.append(row)
        elif s["columns"]:
            cs.append(s["columns"])
        for c in cs[1] if cs.max_row >= 1 and cs.max_column >= 1 else []:
            c.font = bold
    ts = wb.create_sheet(TELEMETRY)
    for row in (sheets or {}).get(TELEMETRY) or [TELEMETRY_HEADER]:
        ts.append(list(row))
    ts["A1"].font = bold
    ts["B1"].font = bold
    ts.column_dimensions["A"].width = 28
    rd = wb.create_sheet(README)
    for line in readme_lines(lay):
        rd.append([line])
    rd["A1"].font = Font(bold=True, size=14)
    rd.column_dimensions["A"].width = 110
    for cell in rd["A"]:
        cell.alignment = Alignment(wrap_text=False)
    ins = wb.create_sheet(INPUT)
    ins.append(INPUT_HEADER)
    for a, keys in lay.input_actions():
        ins.append([a, 0, 0, "|".join(keys)])
    ins.sheet_state = "hidden"
    meta = wb.create_sheet(META)
    for row in (["signature", lay.signature()], ["width", lay.width], ["height", lay.height], ["strategy", strategy], ["paletteMode", lay.palette_mode], ["game", lay.game]):
        meta.append(row)
    meta.sheet_state = "hidden"
    # ---- defined names ------------------------------------------------------------
    for name, (sheet, row, col) in lay.defined_names().items():
        ref = f"{quote_sheet(sheet)}!${column_name(col - 1)}${row}"
        wb.defined_names[name] = DefinedName(name, attr_text=ref)
    return wb
