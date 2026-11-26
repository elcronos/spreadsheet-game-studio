"""ComSink call sequences against a FAKE Excel object model (tests/excel/fake_excel.py).

This checks addresses, BGR colour conversion, 2D value arrays, CF rules,
defined names, batching and busy handling of the Excel code path on Linux.
It does not (and cannot) verify real Excel behaviour or performance.
"""
import unittest

import numpy as np

from fake_excel import new_fake_excel
from helpers import load_hello
from sgs_bridge.layout import build_layout
from sgs_bridge.planning import rgb_to_bgr
from sgs_bridge.protocol import decode_frame, encode_frame, keyframe_runs
from sgs_bridge.sinks.base import SinkBusy
from sgs_bridge.sinks.excel_com import ComSink
from sgs_bridge.state import FrameState
from sgs_bridge.sync import StateSync

W, H = 12, 5


class FakeComCase(unittest.TestCase):
    strategy = "values-cf"

    def setUp(self):
        self.app, self.wb = new_fake_excel()
        self.sink = ComSink(strategy=self.strategy, app=self.app, book=self.wb)
        self.sink.thread_init()
        info = self.sink.open()
        self.assertEqual(info["excelVersion"], "16.0 (fake)")
        self.lay = build_layout(load_hello(W, H))
        self.sink.layout(self.lay)
        self.game = self.wb.Worksheets("GAME")

    def frame(self, fs, idx, runs, key, pal=None, ver=0, fid=1):
        fs.apply(decode_frame(encode_frame(fid, idx, runs, key, pal, ver)))
        return self.sink.apply_frame(fs)

    def shown(self):
        """Colour Excel would display per pixel: CF (value -> rule colour) or direct fill (BGR)."""
        out = np.full((H, W), -1, np.int64)
        rules = {e["formula1"]: e["interior"] for e in self.game.cf.get(self.lay.frame_range_a1(), [])}
        for y in range(H):
            for x in range(W):
                cell = (4 + y, 1 + x)
                if self.strategy == "values-cf":
                    v = self.game.values.get(cell)
                    if v is not None:
                        out[y, x] = rules.get(f"={int(v)}", -1)
                else:
                    out[y, x] = self.game.fills.get(cell, -1)
        return out


class TestFakeComValuesCf(FakeComCase):
    def test_layout(self):
        names = [s.Name for s in self.wb._sheets]
        for s in ("GAME", "PLAYER", "VEHICLES", "WORLD", "RULES", "MISSIONS", "TELEMETRY", "INPUT", "_SGS"):
            self.assertIn(s, names)
        self.assertEqual(self.wb.names["PoliceBudget"], "=RULES!$B$3")
        self.assertEqual(self.wb.names["BaseBudget"], f"=WORLD!$B${self.lay.vars_by_key['world.baseBudget'].row}")
        rules = self.wb.Worksheets("RULES")
        self.assertEqual(rules.formulas[(3, 2)], "=ROUND(BaseBudget*AlertLevel*PoliceResponse, 0)")
        self.assertEqual(self.game.col_widths["A:L"], 0.58)
        self.assertEqual(self.game.row_heights["4:8"], 4.5)
        self.assertEqual(self.game.number_formats["A4:L8"], ";;;")
        self.assertEqual(self.wb.Worksheets("INPUT").Visible, 0)
        self.assertEqual(self.wb.Worksheets("_SGS").values[(1, 2)], self.lay.signature())
        if self.strategy == "values-cf":
            cf = self.game.cf["A4:L8"]
            self.assertEqual(len(cf), 64)
            self.assertEqual(cf[17]["formula1"], "=17")
            self.assertEqual(cf[17]["interior"], rgb_to_bgr(self.lay.palette[17]))

    def test_frames_exact_and_batched(self):
        fs = FrameState(W, H, self.lay.palette)
        y, x = np.mgrid[0:H, 0:W]
        idx = ((x * 5 + y * 11) % 64).astype(np.uint8)
        pal = np.array(self.lay.palette, np.int64)
        res = self.frame(fs, idx, keyframe_runs(W, H), True, self.lay.palette)
        expect = np.vectorize(rgb_to_bgr)(pal[idx])
        np.testing.assert_array_equal(self.shown(), expect)
        self.assertEqual(self.app.ScreenUpdating, True)
        self.assertGreaterEqual(self.app.screen_toggles, 2)
        self.assertEqual(self.app.Calculation, -4105, "calculation restored after the batch")
        idx2 = idx.copy()
        idx2[1, 2:5] = 3
        res = self.frame(fs, idx2, [(1, 2, 3)], False, fid=2)
        np.testing.assert_array_equal(self.shown(), np.vectorize(rgb_to_bgr)(pal[idx2]))
        self.assertGreater(res.calls, 0)

    def test_busy_raises_sinkbusy_and_heals(self):
        fs = FrameState(W, H, self.lay.palette)
        idx = np.full((H, W), 5, np.uint8)
        self.app.busy = 1
        fs.apply(decode_frame(encode_frame(1, idx, keyframe_runs(W, H), True, self.lay.palette)))
        with self.assertRaises(SinkBusy):
            self.sink.apply_frame(fs)
        self.assertTrue(fs.dirty.all())
        self.sink.apply_frame(fs)
        pal = np.array(self.lay.palette, np.int64)
        np.testing.assert_array_equal(self.shown(), np.vectorize(rgb_to_bgr)(pal[idx]))

    def test_state_sync_and_busy_poll(self):
        sync = StateSync(self.sink, self.lay)
        self.assertEqual(sync.poll(), [])
        sync.push({"player.health": 33, "player.invincible": True}, [])
        p = self.wb.Worksheets("PLAYER")
        self.assertEqual(p.values[(2, 2)], 33.0)
        self.assertEqual(sync.poll(), [])
        p.values[(2, 2)] = 99.0  # user typed
        self.assertEqual(sync.poll(), ['{"t":"edit","key":"player.health","value":99}'])
        self.app.busy = 1
        with self.assertRaises(SinkBusy):
            sync.poll()

    def test_attach_prebuilt_signature(self):
        # second layout with the same hello: signature matches -> attach (CF reused, not rebuilt)
        before = self.app.calls
        self.sink.layout(self.lay)
        self.assertTrue(self.sink.attached_prebuilt)
        self.assertLess(self.app.calls - before, 20)


class TestFakeComInterior(TestFakeComValuesCf):
    strategy = "interior"

    def test_multi_area_addresses_short(self):
        fs = FrameState(W, H, self.lay.palette)
        rng = np.random.default_rng(2)
        idx = rng.integers(0, 3, (H, W)).astype(np.uint8)
        seen = []
        orig = self.game.Range

        def spy(addr):
            seen.append(addr)
            return orig(addr)

        self.game.Range = spy
        self.frame(fs, idx, keyframe_runs(W, H), True, self.lay.palette)
        self.assertTrue(seen)
        self.assertTrue(all(len(a) <= 255 for a in seen))
        self.assertTrue(any("," in a for a in seen), "same-colour cells grouped into multi-area ranges")


if __name__ == "__main__":
    unittest.main()
