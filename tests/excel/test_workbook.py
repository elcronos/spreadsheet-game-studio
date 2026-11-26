"""scripts/excel/build_workbook.py: openpyxl output, and LibreOffice recalculating the RULES formulas."""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest

import numpy as np

from helpers import FIXTURES, ROOT, load_hello, soffice_available
from sgs_bridge.layout import build_layout

spec = importlib.util.spec_from_file_location("build_workbook", os.path.join(ROOT, "scripts", "excel", "build_workbook.py"))
bw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bw)


class TestBuildWorkbook(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="sgs_wb_test_")
        cls.path = os.path.join(cls.tmp, "game.xlsx")
        frame = os.path.join(FIXTURES, "sgf1", "seq_00.sgf1")
        # the fixture frame is 24x10: override the manifest size to match it
        cls.rc = bw.main([os.path.join(FIXTURES, "sample_hello.json"), "--out", cls.path, "--width", "24", "--height", "10", "--frame", frame])
        cls.lay = build_layout(load_hello(24, 10))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_reopens_with_contract_layout(self):
        from openpyxl import load_workbook

        self.assertEqual(self.rc, 0)
        wb = load_workbook(self.path)
        self.assertEqual(wb.sheetnames[:5], ["GAME", "PLAYER", "VEHICLES", "WORLD", "RULES"])
        for s in ("MISSIONS", "TELEMETRY", "README", "INPUT", "_SGS"):
            self.assertIn(s, wb.sheetnames)
        self.assertEqual(wb["INPUT"].sheet_state, "hidden")
        self.assertEqual([c.value for c in wb["PLAYER"][1]], ["Variable", "Value", "Min", "Max", "Unit", "Description", "Key"])
        self.assertEqual([c.value for c in wb["RULES"][1]], ["Rule", "Formula (live)", "Value", "Min", "Max", "Description"])
        self.assertEqual(wb["RULES"]["B3"].value, "=ROUND(BaseBudget*AlertLevel*PoliceResponse, 0)")
        self.assertEqual(wb["_SGS"]["B1"].value, self.lay.signature())
        self.assertEqual(wb["MISSIONS"]["B1"].value, "Mission")

    def test_defined_names_point_at_value_cells(self):
        from openpyxl import load_workbook

        wb = load_workbook(self.path)
        names = {n: wb.defined_names[n].attr_text for n in wb.defined_names}
        self.assertEqual(len(names), len(self.lay.defined_names()))
        bb = self.lay.vars_by_key["world.baseBudget"]
        self.assertEqual(names["BaseBudget"], f"WORLD!$B${bb.row}")
        self.assertEqual(names["PoliceBudget"], "RULES!$B$3")
        self.assertEqual(wb["WORLD"].cell(bb.row, 7).value, "world.baseBudget")

    def test_game_sheet_cf_and_prefilled_frame(self):
        from openpyxl import load_workbook

        wb = load_workbook(self.path)
        ws = wb["GAME"]
        rules = [r for cf in ws.conditional_formatting for r in cf.rules]
        self.assertEqual(len(rules), 64)
        self.assertEqual([str(cf.sqref) for cf in ws.conditional_formatting], ["A4:X13"])
        r17 = next(r for r in rules if r.formula == ["17"])
        pal = self.lay.palette
        self.assertEqual(r17.dxf.fill.fgColor.rgb[-6:], f"{pal[17]:06X}")
        with open(os.path.join(FIXTURES, "sgf1", "manifest.json")) as fh:
            e = json.load(fh)["frames"][0]
        idx = np.frombuffer(bytes.fromhex(e["indices"]), np.uint8).reshape(10, 24)
        got = np.array([[ws.cell(4 + y, 1 + x).value for x in range(24)] for y in range(10)])
        np.testing.assert_array_equal(got, idx)
        self.assertEqual(ws.row_dimensions[4].height, 4.5)
        self.assertEqual(ws.cell(4, 1).number_format, ";;;")

    @unittest.skipUnless(soffice_available(), "LibreOffice not installed")
    def test_libreoffice_recalculates_rules_from_names(self):
        hello = load_hello(16, 8)
        for v in hello["variables"]:
            if v.get("name") == "AlertLevel":
                v["default"] = 3
            if v.get("name") == "BaseBudget":
                v["default"] = 1.5
            if v.get("name") == "PoliceResponse":
                v["default"] = 2
            if v.get("name") == "RushHourMultiplier":
                v["default"] = 1.75
        hello["rules"].append({"name": "Chained", "formula": "=PoliceBudget*2+MAX(EscapeTime, 1)", "min": 0, "max": 999, "description": "rule referencing rules"})
        mpath = os.path.join(self.tmp, "m.json")
        with open(mpath, "w") as fh:
            json.dump(hello, fh)
        out = os.path.join(self.tmp, "recalc.xlsx")
        self.assertEqual(bw.main([mpath, "--out", out]), 0)
        rep = bw.verify(out, build_layout(hello))
        self.assertEqual(rep["libreoffice"], "recalculated", rep)
        got = {r["rule"]: r["libreoffice"] for r in rep["recalc"]}
        self.assertEqual(got["PoliceBudget"], 9)        # ROUND(1.5*3*2, 0)
        self.assertEqual(got["TrafficDensity"], 1.75)   # 1 * 1.75
        self.assertEqual(got["EscapeTime"], 13.5)       # 6 + 3*2.5
        self.assertEqual(got["Chained"], 31.5)          # 9*2 + 13.5
        self.assertTrue(rep["recalcOk"], rep)
        self.assertTrue(rep["namesSurvivedRoundTrip"])


if __name__ == "__main__":
    unittest.main()
