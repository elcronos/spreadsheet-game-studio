#!/usr/bin/env python3
"""Build a contract-conformant Excel workbook from a hello manifest.

    python3 scripts/excel/build_workbook.py tests/excel/fixtures/sample_hello.json \
        --out gridlock.xlsx [--frame first.sgf1 ...] [--verify]

* GAME: square cells, HUD rows 1-3, frame at A4, one conditional-format rule
  per palette entry over the frame range (cell value = palette index).
  ``--frame`` pre-fills the frame from SGF1 files (applied in order).
* PLAYER / VEHICLES / WORLD (any variable sheet), RULES with real formulas in
  column B, workbook defined names for every named variable and rule.
* MISSIONS, TELEMETRY, README, hidden INPUT (for SGSInput.bas) and _SGS meta.

``--verify`` reopens the file with openpyxl and has LibreOffice (headless)
recalculate it, then checks that every RULES formula computes the value the
game's own formula semantics give for the manifest defaults.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "renderers", "excel", "bridge"))

import numpy as np  # noqa: E402

from sgs_bridge.layout import GAME, RULES, Layout, build_layout  # noqa: E402
from sgs_bridge.protocol import decode_frame  # noqa: E402
from sgs_bridge.state import FrameState  # noqa: E402
from sgs_bridge.workbook import build_workbook  # noqa: E402


def load_frames(lay: Layout, paths: List[str]) -> Optional[FrameState]:
    if not paths:
        return None
    fs = FrameState(lay.width, lay.height, lay.palette)
    for p in paths:
        with open(p, "rb") as fh:
            fs.apply(decode_frame(fh.read()))
    return fs


# ---- reference evaluation of rule formulas (Excel semantics, the formula.ts subset) ----

def _excel_round(a: float, d: float = 0) -> float:
    m = 10 ** int(d)
    return math.copysign(math.floor(abs(a) * m + 0.5) / m, a)


FUNCS = {
    "ROUND": _excel_round, "MIN": min, "MAX": max, "ABS": abs, "SQRT": math.sqrt, "INT": math.floor,
    "FLOOR": math.floor, "CEILING": math.ceil, "POWER": pow, "MOD": lambda a, b: a - b * math.floor(a / b),
    "PI": lambda: math.pi, "SUM": lambda *a: sum(a), "AVERAGE": lambda *a: sum(a) / len(a),
    "IF": lambda c, a, b=0: a if c else b,
}


def reference_rule_values(lay: Layout, values: Optional[Dict[str, Any]] = None) -> Dict[str, float]:
    """Evaluate RULES formulas in Python over variable defaults (rules may reference rules)."""
    import re

    env: Dict[str, Any] = {}
    for v in lay.vars_by_key.values():
        if v.name:
            val = (values or {}).get(v.key, v.default)
            env[v.name.upper()] = float(val) if isinstance(val, (int, float, bool)) else 0.0
    out: Dict[str, float] = {}
    pending = list(lay.rules)
    for _ in range(len(pending) + 1):
        nxt = []
        for r in pending:
            expr = r.formula.lstrip("=")
            expr = re.sub(r"\^", "**", expr)
            expr = re.sub(r"(?<![<>=!])=(?!=)", "==", expr).replace("<>", "!=")
            names = {k: v for k, v in env.items()}
            names.update(FUNCS)
            try:
                code = re.sub(r"[A-Za-z_][A-Za-z0-9_.]*", lambda m: m.group(0).upper() if m.group(0).upper() in names else m.group(0), expr)
                val = float(eval(code, {"__builtins__": {}}, names))  # noqa: S307 - formulas from our own manifest
            except NameError:
                nxt.append(r)
                continue
            out[r.name] = val
            env[r.name.upper()] = val
        pending = nxt
        if not pending:
            break
    return out


def verify(path: str, lay: Layout, soffice: Optional[str] = None, timeout: float = 120) -> Dict[str, Any]:
    """Reopen with openpyxl, recalc with LibreOffice headless, compare RULES values."""
    from openpyxl import load_workbook

    report: Dict[str, Any] = {"file": path}
    wb = load_workbook(path)
    ws = wb[GAME]
    report["sheets"] = wb.sheetnames
    report["definedNames"] = len(wb.defined_names)
    report["cfRules"] = sum(len(r.rules) for r in ws.conditional_formatting)
    report["formulas"] = {wb[RULES].cell(r.row, 1).value: wb[RULES].cell(r.row, 2).value for r in lay.rules}
    soffice = soffice or shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        report["libreoffice"] = "not installed - recalculation not verified"
        return report
    out_dir = tempfile.mkdtemp(prefix="sgs_recalc_")
    profile = tempfile.mkdtemp(prefix="sgs_lo_profile_")
    try:
        src = os.path.join(out_dir, "in.xlsx")
        shutil.copy(path, src)
        conv = os.path.join(out_dir, "out")
        os.makedirs(conv)
        cmd = [soffice, "--headless", "--nologo", "--norestore", f"-env:UserInstallation=file://{profile}", "--convert-to", "xlsx", "--outdir", conv, src]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        outp = os.path.join(conv, "in.xlsx")
        if p.returncode != 0 or not os.path.exists(outp):
            report["libreoffice"] = f"convert failed: {p.returncode} {p.stderr.strip()[:300]}"
            return report
        calc = load_workbook(outp, data_only=True)
        got = {calc[RULES].cell(r.row, 1).value: calc[RULES].cell(r.row, 2).value for r in lay.rules}
        exp = reference_rule_values(lay)
        rows = []
        ok = True
        for r in lay.rules:
            g, e = got.get(r.name), exp.get(r.name)
            match = isinstance(g, (int, float)) and e is not None and abs(float(g) - e) <= 1e-9 * max(1, abs(e))
            ok &= bool(match)
            rows.append({"rule": r.name, "formula": r.formula, "libreoffice": g, "expected": e, "ok": bool(match)})
        report["recalc"] = rows
        report["recalcOk"] = ok
        names_after = {n for n in calc.defined_names}
        report["namesSurvivedRoundTrip"] = sorted(set(lay.defined_names()) - names_after) == []
        report["libreoffice"] = "recalculated"
        return report
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("manifest", help="hello manifest JSON (same shape as the hello message)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--frame", action="append", default=[], help="SGF1 file to pre-fill GAME (repeatable, applied in order)")
    ap.add_argument("--width", type=int, help="override manifest width")
    ap.add_argument("--height", type=int, help="override manifest height")
    ap.add_argument("--fills", action="store_true", help="paint frame cells with direct fills instead of CF values")
    ap.add_argument("--verify", action="store_true")
    a = ap.parse_args(argv)
    with open(a.manifest) as fh:
        hello = json.load(fh)
    if a.width:
        hello["width"] = a.width
    if a.height:
        hello["height"] = a.height
    lay = build_layout(hello)
    for w in lay.warnings:
        print("warning:", w, file=sys.stderr)
    fs = load_frames(lay, a.frame)
    wb = build_workbook(lay, indices=fs.target if fs else None, palette=fs.palette[:fs.palette_count].tolist() if fs else None, fills=a.fills, strategy="interior" if a.fills else "values-cf")
    wb.save(a.out)
    print(f"wrote {a.out}: {lay.width}x{lay.height}, {len(lay.vars_by_key)} variables on {list(lay.var_sheets)}, {len(lay.rules)} rules, {len(lay.defined_names())} defined names")
    if a.verify:
        rep = verify(a.out, lay)
        print(json.dumps(rep, indent=1, default=str))
        if rep.get("recalcOk") is False:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
