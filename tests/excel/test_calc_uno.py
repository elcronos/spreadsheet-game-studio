"""Integration: LibreOffice Calc (headless soffice) through UNO.

Renders known frames and reads back CellBackColor / cell values to verify the
exact pixel -> cell mapping for both strategies, conditional-format entries,
palette changes, real formula recalculation from defined names, edit and rule
polling, and saving. Skips if soffice cannot start.
"""
import asyncio
import os
import shutil
import tempfile
import unittest

import numpy as np

from helpers import BridgeThread, Client, free_port, load_hello, soffice_available
from sgs_bridge.layout import build_layout
from sgs_bridge.protocol import decode_frame, encode_frame, keyframe_runs
from sgs_bridge.sinks.base import SinkError
from sgs_bridge.sinks.uno_calc import UnoCalcSink
from sgs_bridge.state import FrameState
from sgs_bridge.sync import StateSync

W, H = 20, 9


def known_frame():
    y, x = np.mgrid[0:H, 0:W]
    return ((x * 7 + y * 3) % 64).astype(np.uint8)


class CalcCase(unittest.TestCase):
    strategy = "values-cf"

    @classmethod
    def setUpClass(cls):
        if not soffice_available():
            raise unittest.SkipTest("soffice / python uno not available")
        cls.tmp = tempfile.mkdtemp(prefix="sgs_calc_test_")
        cls.sink = UnoCalcSink(strategy=cls.strategy, uno_port=free_port(), profile_dir=os.path.join(cls.tmp, "profile"), workbook=os.path.join(cls.tmp, "out.xlsx"))
        try:
            cls.sink.open()
        except (SinkError, OSError) as e:
            shutil.rmtree(cls.tmp, ignore_errors=True)
            raise unittest.SkipTest(f"soffice could not start: {e}")
        cls.lay = build_layout(load_hello(W, H))
        cls.sink.layout(cls.lay)
        cls.pal = np.array(cls.lay.palette, dtype=np.int64)

    @classmethod
    def tearDownClass(cls):
        cls.sink.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def apply(self, fs, idx, runs, key, palette=None, version=0, fid=1):
        fs.apply(decode_frame(encode_frame(fid, idx, runs, key, palette, version)))
        return self.sink.apply_frame(fs)

    def check_cells(self, idx, pal):
        if self.strategy == "values-cf":
            vals = self.sink.read_back_values()
            np.testing.assert_array_equal(vals, idx.astype(float))
        else:
            colours = self.sink.read_back_colors()
            np.testing.assert_array_equal(colours, pal[idx])

    def test_1_keyframe_then_diff_exact_mapping(self):
        fs = FrameState(W, H, self.lay.palette)
        idx = known_frame()
        res = self.apply(fs, idx, keyframe_runs(W, H), True, self.lay.palette)
        self.assertEqual(res.cells, W * H)
        self.check_cells(idx, self.pal)
        # sprite moves: diff of two runs
        idx2 = idx.copy()
        idx2[2, 3:7] = 63
        idx2[8, 19] = 0
        res = self.apply(fs, idx2, [(2, 3, 4), (8, 19, 1)], False, fid=2)
        self.assertGreaterEqual(res.cells, 5)
        self.check_cells(idx2, self.pal)
        # cell addressing: pixel (0,0) is A4 and pixel (19,8) is T12
        g = self.sink.game
        if self.strategy == "values-cf":
            self.assertEqual(g.getCellRangeByName("A4").getValue(), float(idx2[0, 0]))
            self.assertEqual(g.getCellRangeByName("T12").getValue(), 0.0)
            self.assertEqual(g.getCellRangeByName("U12").getType().value, "EMPTY")
            self.assertEqual(g.getCellRangeByName("A13").getType().value, "EMPTY")
        else:
            self.assertEqual(g.getCellRangeByName("D6").CellBackColor, int(self.pal[63]))
            self.assertEqual(g.getCellRangeByName("U12").CellBackColor, -1)

    def test_2_palette_change(self):
        fs = FrameState(W, H, self.lay.palette)
        idx = known_frame()
        self.apply(fs, idx, keyframe_runs(W, H), True, self.lay.palette)
        pal2 = list(self.lay.palette)
        pal2[7] = 0x123456
        self.apply(fs, idx, [], False, pal2, 1, fid=2)
        self.check_cells(idx, np.array(pal2, np.int64))
        if self.strategy == "values-cf":
            entries = self.sink.cf_entries()
            self.assertEqual(len(entries), 64)
            self.assertEqual(entries[7], ("7", "sgs_p7", 0x123456))
            self.assertEqual(entries[0][2], self.lay.palette[0])

    def test_3_layout_names_and_formulas_recalculate(self):
        doc = self.sink.doc
        names = doc.NamedRanges
        bb = self.lay.vars_by_key["world.baseBudget"]
        self.assertEqual(names.getByName("BaseBudget").Content, f"$WORLD.$B${bb.row}")
        self.assertEqual(names.getByName("PoliceBudget").Content, "$RULES.$B$3")
        rules = doc.Sheets.getByName("RULES")
        world = doc.Sheets.getByName("WORLD")
        player = doc.Sheets.getByName("PLAYER")
        # user edits in the real spreadsheet; Calc recalculates the rule formulas itself
        world.getCellByPosition(1, bb.row - 1).setValue(2.0)
        player.getCellByPosition(1, self.lay.vars_by_key["player.alert"].row - 1).setValue(3.0)
        pr = self.lay.vars_by_key["world.policeResponse"]
        world.getCellByPosition(1, pr.row - 1).setValue(1.5)
        self.assertEqual(rules.getCellByPosition(1, 2).getValue(), 9.0)  # ROUND(2*3*1.5,0)
        self.assertEqual(rules.getCellByPosition(1, 4).getValue(), 13.5)  # 6+3*2.5
        # restore
        world.getCellByPosition(1, bb.row - 1).setValue(1.2)
        player.getCellByPosition(1, self.lay.vars_by_key["player.alert"].row - 1).setValue(0.0)
        world.getCellByPosition(1, pr.row - 1).setValue(1.0)

    def test_4_poll_edits_and_echo_suppression(self):
        sync = StateSync(self.sink, self.lay)
        self.assertEqual(sync.poll(), [])
        # bridge writes game state: never reported back
        sync.push({"player.health": 55.5, "player.invincible": True, "world.weather": "Fog"},
                  [{"name": "PoliceBudget", "formula": "=ROUND(BaseBudget * AlertLevel * PoliceResponse, 0)", "value": 0}])
        self.assertEqual(sync.poll(), [])
        player = self.sink.doc.Sheets.getByName("PLAYER")
        self.assertEqual(player.getCellByPosition(1, 1).getValue(), 55.5)
        # user edits
        player.getCellByPosition(1, self.lay.vars_by_key["player.stamina"].row - 1).setValue(42)
        rules = self.sink.doc.Sheets.getByName("RULES")
        rules.getCellByPosition(1, 2).setFormula("=MAX(BaseBudget*AlertLevel; 4)")
        out = sync.poll()
        self.assertIn('{"t":"edit","key":"player.stamina","value":42}', out)
        rule = [m for m in out if '"t":"rule"' in m]
        self.assertEqual(len(rule), 1)
        self.assertIn('"formula":"=MAX(BaseBudget*AlertLevel, 4)"', rule[0])  # Excel syntax back to the game
        self.assertIn('"value":4.0', rule[0])  # Calc's own computed value
        self.assertEqual(sync.poll(), [])
        # restore the rule for later tests
        sync.push({}, [{"name": "PoliceBudget", "formula": "=MAX(BaseBudget*AlertLevel, 4)", "value": 4}])
        self.assertEqual(sync.poll(), [])

    def test_5_hud_sheets_and_save(self):
        self.sink.write_hud("CASH: $250", "Deliver the van")
        self.sink.write_sheet("MISSIONS", ["#", "Mission", "Status"], [{"cells": [1, "Delivery", "active"], "style": "active"}])
        self.sink.write_telemetry([("sheetFps", 9.5), ("resolution", "20x9")])
        g = self.sink.game
        self.assertEqual(g.getCellByPosition(0, 0).getString(), "CASH: $250")
        m = self.sink.doc.Sheets.getByName("MISSIONS")
        self.assertEqual(m.getCellRangeByName("B2").getString(), "Delivery")
        self.sink.save()
        from openpyxl import load_workbook

        wb = load_workbook(self.sink.workbook)
        self.assertIn("GAME", wb.sheetnames)
        self.assertEqual(wb["MISSIONS"]["B2"].value, "Delivery")
        self.assertIn("PoliceBudget", list(wb.defined_names))


class CalcInterior(CalcCase):
    strategy = "interior"


class CalcInteriorRuns(CalcCase):
    strategy = "interior-runs"


class CalcThroughBridge(unittest.TestCase):
    """The full bridge (websocket + UnoCalcSink) on a real Calc document."""

    def test_bridge_frames_and_edits(self):
        if not soffice_available():
            self.skipTest("soffice not available")
        tmp = tempfile.mkdtemp(prefix="sgs_calc_bridge_")
        sink = UnoCalcSink(strategy="values-cf", uno_port=free_port(), profile_dir=os.path.join(tmp, "p"))
        try:
            with BridgeThread(sink, poll_ms=50, state_interval=0.02) as bt:
                async def go():
                    c = await Client.connect(bt.url)
                    await c.send_json(load_hello(W, H))
                    r = await c.recv_type("ready", 60)
                    self.assertEqual(r["sink"], "calc-uno")
                    self.assertTrue(r["appVersion"].startswith("LibreOffice"))
                    idx = known_frame()
                    await c.ws.send(encode_frame(1, idx, keyframe_runs(W, H), True, build_layout(load_hello(W, H)).palette))
                    ack = await c.recv_type("ack", 30)
                    self.assertEqual(ack["cells"], W * H)
                    np.testing.assert_array_equal(sink.read_back_values(), idx.astype(float))
                    lay = sink.layout_
                    world = sink.doc.Sheets.getByName("WORLD")
                    world.getCellByPosition(1, lay.vars_by_key["world.gravity"].row - 1).setValue(3.5)
                    e = await c.recv_type("edit", 10)
                    self.assertEqual((e["key"], e["value"]), ("world.gravity", 3.5))
                    await c.close()
                    for _ in range(40):
                        if sink.game.getCellByPosition(0, 0).getString().startswith("DISCONNECTED"):
                            break
                        await asyncio.sleep(0.05)
                    self.assertTrue(sink.game.getCellByPosition(0, 0).getString().startswith("DISCONNECTED"))
                asyncio.run(asyncio.wait_for(go(), 120))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
