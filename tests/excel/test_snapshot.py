"""SnapshotSink: a real .xlsx where every GAME cell has the fill of its pixel."""
import os
import shutil
import tempfile
import unittest

import numpy as np

from helpers import load_hello
from sgs_bridge.layout import build_layout
from sgs_bridge.protocol import decode_frame, encode_frame, keyframe_runs
from sgs_bridge.sinks.snapshot import SnapshotSink
from sgs_bridge.state import FrameState


class TestSnapshot(unittest.TestCase):
    def test_fills_match_pixels(self):
        from openpyxl import load_workbook

        tmp = tempfile.mkdtemp(prefix="sgs_snap_")
        try:
            path = os.path.join(tmp, "snap.xlsx")
            s = SnapshotSink(workbook=path, every_s=1000)
            s.open()
            lay = build_layout(load_hello(10, 4))
            s.layout(lay)
            fs = FrameState(10, 4, lay.palette)
            idx = (np.arange(40).reshape(4, 10) % 64).astype(np.uint8)
            fs.apply(decode_frame(encode_frame(1, idx, keyframe_runs(10, 4), True, lay.palette)))
            s.apply_frame(fs)
            s.write_values([(lay.vars_by_key["player.health"], 12)])
            s.write_hud("CASH: $1", "Go")
            s.close()
            wb = load_workbook(path)
            g = wb["GAME"]
            for y in range(4):
                for x in range(10):
                    self.assertEqual(g.cell(4 + y, 1 + x).fill.fgColor.rgb[-6:], f"{lay.palette[idx[y, x]]:06X}")
            self.assertEqual(g["A1"].value, "CASH: $1")
            self.assertEqual(wb["PLAYER"]["B2"].value, 12)
            self.assertEqual(wb["RULES"]["B3"].value, "=ROUND(BaseBudget*AlertLevel*PoliceResponse, 0)")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
