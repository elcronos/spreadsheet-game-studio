"""Workbook layout contract (references/protocol.md, "Workbook layout").

One pure-data description of where everything lives, computed from a
``hello`` manifest. Used by every sink and by scripts/excel/build_workbook.py
so the bridge and the prebuilt workbook always agree on addresses.

All row/column numbers here are 1-based worksheet coordinates unless a name
ends in ``0`` (0-based framebuffer coordinates).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

VARIABLE_HEADER = ["Variable", "Value", "Min", "Max", "Unit", "Description", "Key"]
RULES_HEADER = ["Rule", "Formula (live)", "Value", "Min", "Max", "Description"]
TELEMETRY_HEADER = ["Metric", "Value"]
INPUT_HEADER = ["Action", "Presses", "LastPress", "OnKey keys (| separated)"]

GAME = "GAME"
RULES = "RULES"
TELEMETRY = "TELEMETRY"
README = "README"
INPUT = "INPUT"
META = "_SGS"

HUD_STATS_ROW = 1
HUD_OBJECTIVE_ROW = 2
HUD_SPACER_ROW = 3

# Contract: columns ~0.58 char (~6 px), rows 4.5 pt.
EXCEL_COL_WIDTH_CHARS = 0.58
EXCEL_ROW_HEIGHT_PT = 4.5
CALC_COL_WIDTH_100MM = 159  # 4.5 pt == 1.5875 mm
CALC_ROW_HEIGHT_100MM = 159

# Default binding table, KeyboardEvent.code -> action. A hello may override it
# with an optional ``keyBindings`` object (same shape as SpreadsheetGame.keyBindings).
DEFAULT_KEY_BINDINGS: Dict[str, str] = {  # Gridlock City's SpreadsheetGame.keyBindings
    "KeyW": "up", "ArrowUp": "up", "KeyS": "down", "ArrowDown": "down",
    "KeyA": "left", "ArrowLeft": "left", "KeyD": "right", "ArrowRight": "right",
    "ShiftLeft": "sprint", "ShiftRight": "sprint", "Space": "handbrake",
    "KeyF": "enter", "Enter": "enter", "KeyH": "horn", "KeyR": "restart",
    "KeyC": "lookback", "KeyQ": "camLeft", "KeyE": "camRight", "KeyV": "walk",
}

# KeyboardEvent.code -> Excel Application.OnKey key strings (used by SGSInput.bas).
ONKEY_CODES: Dict[str, List[str]] = {
    "KeyW": ["w"], "KeyA": ["a"], "KeyS": ["s"], "KeyD": ["d"],
    "KeyF": ["f"], "KeyE": ["e"], "KeyR": ["r"], "KeyQ": ["q"], "KeyH": ["h"], "KeyC": ["c"], "KeyV": ["v"],
    "Enter": ["~"],
    "ArrowUp": ["{UP}"], "ArrowDown": ["{DOWN}"], "ArrowLeft": ["{LEFT}"], "ArrowRight": ["{RIGHT}"],
    "Space": [" "],
    # Shift alone cannot be bound with OnKey. "+" marks the action as a Shift modifier:
    # SGSInput.bas binds Shift+<every other key> to press both actions.
    "ShiftLeft": ["+"], "ShiftRight": ["+"],
}

_CELL_LIKE = re.compile(r"^[A-Za-z]{1,3}[0-9]+$")
_R1C1_LIKE = re.compile(r"^([Rr][0-9]*([Cc][0-9]*)?|[Cc][0-9]*)$")
_NAME_OK = re.compile(r"^[A-Za-z_\\][A-Za-z0-9_.]*$")


def valid_defined_name(name: str) -> bool:
    """Excel/Calc defined-name rules (subset): no cell-like or R1C1-like names."""
    return bool(name) and len(name) <= 255 and bool(_NAME_OK.match(name)) and not _CELL_LIKE.match(name) and not _R1C1_LIKE.match(name)


def column_name(i: int) -> str:
    """0-based column index -> letters (0 -> A, 26 -> AA)."""
    s = ""
    i += 1
    while i > 0:
        i, m = divmod(i - 1, 26)
        s = chr(65 + m) + s
    return s


def a1(row: int, col: int, absolute: bool = False) -> str:
    """1-based row/col -> A1."""
    if absolute:
        return f"${column_name(col - 1)}${row}"
    return f"{column_name(col - 1)}{row}"


def rect_a1(r0: int, c0: int, r1: int, c1: int) -> str:
    """Inclusive 1-based rectangle -> 'A4:B5' (or 'A4' for one cell)."""
    if r0 == r1 and c0 == c1:
        return a1(r0, c0)
    return f"{a1(r0, c0)}:{a1(r1, c1)}"


def quote_sheet(name: str) -> str:
    return name if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name) else "'" + name.replace("'", "''") + "'"


@dataclass
class VarRow:
    key: str
    sheet: str
    row: int
    label: str
    type: str
    default: Any
    name: Optional[str] = None
    min: Optional[float] = None
    max: Optional[float] = None
    unit: str = ""
    description: str = ""
    options: Optional[List[str]] = None
    read_only: bool = False
    live: bool = False


@dataclass
class RuleRow:
    name: str
    row: int
    formula: str
    min: float
    max: float
    description: str = ""


@dataclass
class Layout:
    game: str
    title: str
    width: int
    height: int
    origin_col0: int
    origin_row0: int
    palette: List[int]
    palette_mode: str
    var_sheets: Dict[str, List[VarRow]]
    rules: List[RuleRow]
    custom_sheets: List[Dict[str, Any]]
    controls: List[List[str]]
    key_bindings: Dict[str, str]
    warnings: List[str] = field(default_factory=list)
    vars_by_key: Dict[str, VarRow] = field(default_factory=dict)
    rules_by_name: Dict[str, RuleRow] = field(default_factory=dict)

    # ---- GAME frame range ---------------------------------------------------
    @property
    def frame_first_row(self) -> int:
        return self.origin_row0 + 1

    @property
    def frame_first_col(self) -> int:
        return self.origin_col0 + 1

    def frame_range_a1(self) -> str:
        return rect_a1(self.frame_first_row, self.frame_first_col, self.frame_first_row + self.height - 1, self.frame_first_col + self.width - 1)

    def cell_of_pixel(self, x: int, y: int) -> Tuple[int, int]:
        """0-based pixel -> 1-based (row, col)."""
        return (y + self.origin_row0 + 1, x + self.origin_col0 + 1)

    # ---- names -------------------------------------------------------------
    def defined_names(self) -> Dict[str, Tuple[str, int, int]]:
        """name -> (sheet, row, col) for every named variable and rule (valid names only)."""
        out: Dict[str, Tuple[str, int, int]] = {}
        for rows in self.var_sheets.values():
            for v in rows:
                if v.name and valid_defined_name(v.name):
                    out[v.name] = (v.sheet, v.row, 2)
        for r in self.rules:
            if valid_defined_name(r.name):
                out[r.name] = (RULES, r.row, 2)
        return out

    def all_sheets(self) -> List[str]:
        names = [GAME, *self.var_sheets.keys(), RULES]
        for s in self.custom_sheets:
            if s["name"] not in names:
                names.append(s["name"])
        for s in (TELEMETRY, README, INPUT, META):
            if s not in names:
                names.append(s)
        return names

    def input_actions(self) -> List[Tuple[str, List[str]]]:
        """[(action, [OnKey key strings])] in a stable order, for the INPUT sheet."""
        acts: Dict[str, List[str]] = {}
        for code, action in self.key_bindings.items():
            acts.setdefault(action, [])
            for k in ONKEY_CODES.get(code, []):
                if k not in acts[action]:
                    acts[action].append(k)
        return list(acts.items())

    def signature(self) -> str:
        """Identifies a prebuilt workbook that matches this hello (stored in _SGS!B1)."""
        import hashlib

        h = hashlib.sha1()
        h.update(f"{self.width}x{self.height}@{self.origin_col0},{self.origin_row0};".encode())
        h.update(",".join(f"{c:06X}" for c in self.palette).encode())
        h.update(";".join(f"{v.sheet}!{v.row}={v.key}" for rows in self.var_sheets.values() for v in rows).encode())
        h.update(";".join(f"{r.name}@{r.row}" for r in self.rules).encode())
        return h.hexdigest()[:16]


def _num(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def build_layout(hello: Dict[str, Any]) -> Layout:
    """Compute the workbook layout for a hello manifest. Tolerates missing optional fields."""
    width = int(hello.get("width") or 0)
    height = int(hello.get("height") or 0)
    if not (1 <= width <= 16384 - 1 and 1 <= height <= 1048576 - 4):
        raise ValueError(f"invalid frame size {width}x{height}")
    origin = hello.get("origin") or {"col": 0, "row": 3}
    oc, orow = int(origin.get("col", 0)), int(origin.get("row", 3))
    warnings: List[str] = []
    if (oc, orow) != (0, 3):
        warnings.append(f"non-standard GAME origin {oc},{orow} (contract says A4)")
    var_sheets: Dict[str, List[VarRow]] = {}
    seen_names: Dict[str, str] = {}
    for d in hello.get("variables") or []:
        sheet = str(d.get("sheet") or "WORLD").upper()[:31]
        rows = var_sheets.setdefault(sheet, [])
        name = d.get("name")
        if name:
            if not valid_defined_name(name):
                warnings.append(f"variable {d.get('key')}: '{name}' is not a valid defined name; no name created")
            elif name.lower() in seen_names:
                warnings.append(f"duplicate defined name {name}")
        v = VarRow(
            key=str(d["key"]), sheet=sheet, row=len(rows) + 2, label=str(d.get("label") or d["key"]),
            type=str(d.get("type") or "number"), default=d.get("default"), name=name,
            min=_num(d.get("min")), max=_num(d.get("max")), unit=str(d.get("unit") or ""),
            description=str(d.get("description") or ""), options=d.get("options"),
            read_only=bool(d.get("readOnly")), live=bool(d.get("live")),
        )
        if name:
            seen_names[name.lower()] = v.key
        rows.append(v)
    rules: List[RuleRow] = []
    for i, r in enumerate(hello.get("rules") or []):
        f = str(r.get("formula") or "=0").strip()
        if not f.startswith("="):
            f = "=" + f
        if not valid_defined_name(r["name"]):
            warnings.append(f"rule '{r['name']}' is not a valid defined name")
        rules.append(RuleRow(name=str(r["name"]), row=i + 2, formula=f, min=float(r.get("min", 0)), max=float(r.get("max", 0)), description=str(r.get("description") or "")))
    custom = []
    for s in hello.get("sheets") or []:
        nm = str(s.get("name") or "").upper()[:31]
        if nm and nm not in var_sheets and nm not in (GAME, RULES):
            custom.append({"name": nm, "columns": list(s.get("columns") or [])})
    if not any(s["name"] == "MISSIONS" for s in custom):
        custom.append({"name": "MISSIONS", "columns": []})
    kb = hello.get("keyBindings")
    key_bindings = dict(kb) if isinstance(kb, dict) and kb else dict(DEFAULT_KEY_BINDINGS)
    palette = [int(c) & 0xFFFFFF for c in (hello.get("palette") or [])]
    lay = Layout(
        game=str(hello.get("game") or "game"), title=str(hello.get("title") or hello.get("game") or "Spreadsheet game"),
        width=width, height=height, origin_col0=oc, origin_row0=orow, palette=palette,
        palette_mode=str(hello.get("paletteMode") or ("fixed64" if len(palette) == 64 else "custom")),
        var_sheets=var_sheets, rules=rules, custom_sheets=custom,
        controls=[list(map(str, c)) for c in (hello.get("controls") or [])], key_bindings=key_bindings, warnings=warnings,
    )
    lay.vars_by_key = {v.key: v for rows in var_sheets.values() for v in rows}
    lay.rules_by_name = {r.name: r for r in rules}
    return lay


def minimal_hello(width: int, height: int, palette: Optional[List[int]] = None) -> Dict[str, Any]:
    """Used when frames arrive before any hello (robustness)."""
    return {"t": "hello", "game": "unknown", "title": "Unknown game", "width": width, "height": height, "origin": {"col": 0, "row": 3}, "palette": palette or [], "paletteMode": "custom", "variables": [], "rules": [], "sheets": [], "controls": []}


# ---- value normalisation ---------------------------------------------------

def normalise_value(v: VarRow, raw: Any) -> Any:
    """Spreadsheet cell value -> value to send in an `edit` message (game re-validates)."""
    if raw is None:
        return "" if v.type in ("text", "enum") else raw
    t = v.type
    if t in ("number", "int"):
        if isinstance(raw, bool):
            return 1 if raw else 0
        if isinstance(raw, (int, float)):
            f = float(raw)
            return int(f) if f.is_integer() else f
        s = str(raw).strip()
        try:
            f = float(s.replace(",", "").replace("$", "").replace("%", ""))
            return int(f) if f.is_integer() else f
        except ValueError:
            return s
    if t == "bool":
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, (int, float)):
            return bool(raw)
        s = str(raw).strip().upper()
        if s in ("TRUE", "1", "YES", "ON", "WAHR", "VRAI"):
            return True
        if s in ("FALSE", "0", "NO", "OFF", "FALSCH", "FAUX", ""):
            return False
        return str(raw)
    if isinstance(raw, float) and raw.is_integer():
        return str(int(raw))
    return str(raw)


def display_value(v: VarRow, value: Any) -> Any:
    """Game value -> what a sink writes into the B cell."""
    if v.type == "bool":
        return bool(value) if not isinstance(value, str) else value.strip().upper() in ("TRUE", "1", "YES", "ON")
    if v.type in ("number", "int"):
        if isinstance(value, bool):
            return 1 if value else 0
        try:
            return float(value)
        except (TypeError, ValueError):
            return value
    return "" if value is None else str(value)


def hud_lines(hud: Dict[str, Any]) -> Tuple[str, str]:
    stats = hud.get("stats") or []
    parts =[f"{s[0]}: {s[1]}" for s in stats if isinstance(s, (list, tuple)) and len(s) >= 2]
    meter = hud.get("meter")
    if isinstance(meter, (int, float)) and meter >= 0:
        m = int(round(meter))
        parts.append("ALERT " + "★" * m + "☆" * max(0, 5 - m))
    line1 = "   ".join(parts)
    obj = str(hud.get("objective") or "")
    extras = [str(hud[k]) for k in ("banner", "hint") if hud.get(k)]
    line2 = obj + ("   |   " + "   |   ".join(extras) if extras else "")
    return line1, line2


def excel_to_calc_formula(f: str) -> str:
    """Excel formula text -> LibreOffice API grammar (';' argument separators)."""
    return _swap_outside_quotes(f, ",", ";")


def calc_to_excel_formula(f: str) -> str:
    return _swap_outside_quotes(f, ";", ",")


def _swap_outside_quotes(f: str, a: str, b: str) -> str:
    out = []
    q = False
    for ch in f:
        if ch == '"':
            q = not q
        out.append(b if (ch == a and not q) else ch)
    return "".join(out)
