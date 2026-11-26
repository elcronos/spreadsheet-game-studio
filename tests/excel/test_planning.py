"""Write planning (bands, colour groups, Excel address strings) - pure logic."""
import unittest

import numpy as np

import helpers  # noqa: F401  (sys.path)
from sgs_bridge.layout import (
    build_layout, calc_to_excel_formula, column_name, excel_to_calc_formula, hud_lines, normalise_value,
    valid_defined_name,
)
from sgs_bridge.planning import (
    chunk_addresses, merge_gaps, parse_address_list, plan_bands, plan_colour_rects, rect_address, rects_cells,
    rgb_to_bgr, row_spans,
)


def random_mask(rng, h, w, p=0.05, blobs=8):
    m = rng.random((h, w)) < p
    for _ in range(blobs):
        y, x = rng.integers(0, h), rng.integers(0, w)
        m[y:y + rng.integers(1, 6), x:x + rng.integers(1, 12)] = True
    return m


class TestSpansAndBands(unittest.TestCase):
    def test_row_spans(self):
        m = np.zeros((3, 8), bool)
        m[0, 1:3] = True
        m[0, 5] = True
        m[2, :] = True
        self.assertEqual(row_spans(m), [(0, 1, 3), (0, 5, 6), (2, 0, 8)])
        self.assertEqual(row_spans(np.zeros((2, 2), bool)), [])
        self.assertEqual(merge_gaps(row_spans(m), 2), [(0, 1, 6), (2, 0, 8)])

    def test_bands_cover_every_dirty_cell(self):
        rng = np.random.default_rng(3)
        for trial in range(60):
            h, w = int(rng.integers(1, 40)), int(rng.integers(1, 60))
            m = random_mask(rng, h, w, p=float(rng.random() * 0.2))
            for cost in (0, 8, 100, 5000):
                cover = np.zeros_like(m)
                bands = plan_bands(row_spans(m), cost)
                for r0, r1, c0, c1 in bands:
                    self.assertTrue(0 <= r0 < r1 <= h and 0 <= c0 < c1 <= w)
                    cover[r0:r1, c0:c1] = True
                self.assertTrue((cover | ~m).all(), f"trial {trial} cost {cost}")
                if cost == 0:
                    self.assertEqual(rects_cells(bands), int(m.sum()), "cost 0 writes exactly the dirty cells")

    def test_keyframe_is_one_band(self):
        m = np.ones((90, 160), bool)
        self.assertEqual(plan_bands(row_spans(m), 600), [(0, 90, 0, 160)])

    def test_cost_model_merges_cheap_gaps(self):
        m = np.zeros((10, 100), bool)
        m[0, 0:10] = True
        m[0, 14:20] = True  # 4-cell gap
        m[5, 0:10] = True   # row gap
        self.assertEqual(len(plan_bands(row_spans(m), 0)), 3)
        self.assertEqual(plan_bands(row_spans(m), 10_000), [(0, 6, 0, 20)])


class TestColourRects(unittest.TestCase):
    def test_exact_partition_with_colours(self):
        rng = np.random.default_rng(7)
        for trial in range(60):
            h, w = int(rng.integers(1, 30)), int(rng.integers(1, 50))
            target = rng.integers(0, int(rng.integers(1, 6)), (h, w)).astype(np.uint8)
            m = random_mask(rng, h, w, p=float(rng.random() * 0.6))
            groups = plan_colour_rects(target, m)
            paint = np.full((h, w), -1, np.int64)
            count = np.zeros((h, w), np.int64)
            for c, rects in groups.items():
                for r0, r1, c0, c1 in rects:
                    paint[r0:r1, c0:c1] = c
                    count[r0:r1, c0:c1] += 1
            np.testing.assert_array_equal(count, m.astype(np.int64), err_msg=f"trial {trial}: each dirty cell exactly once")
            np.testing.assert_array_equal(paint[m], target[m].astype(np.int64))

    def test_vertical_merge(self):
        t = np.zeros((6, 6), np.uint8)
        t[1:5, 2:4] = 9
        g = plan_colour_rects(t, np.ones((6, 6), bool))
        self.assertIn((1, 5, 2, 4), g[9])
        self.assertEqual(len(g[9]), 1)

    def test_empty(self):
        self.assertEqual(plan_colour_rects(np.zeros((2, 2), np.uint8), np.zeros((2, 2), bool)), {})


class TestExcelAddresses(unittest.TestCase):
    def test_rect_address(self):
        self.assertEqual(rect_address((0, 1, 0, 1), 3, 0), "A4")
        self.assertEqual(rect_address((0, 2, 0, 3), 3, 0), "A4:C5")
        self.assertEqual(rect_address((269, 270, 479, 480), 3, 0), "RL273")

    def test_chunks_limit_and_roundtrip(self):
        rng = np.random.default_rng(1)
        rects = []
        for _ in range(500):
            r0, c0 = int(rng.integers(0, 270)), int(rng.integers(0, 480))
            rects.append((r0, r0 + int(rng.integers(1, 3)), c0, min(480, c0 + int(rng.integers(1, 5)))))
        chunks = chunk_addresses(rects, 3, 0, 255)
        self.assertTrue(all(len(c) <= 255 for c in chunks))
        back = [a for c in chunks for a in parse_address_list(c)]
        want = [(r0 + 4, r1 + 3, c0 + 1, c1) for r0, r1, c0, c1 in rects]
        self.assertEqual(back, want)

    def test_bgr(self):
        self.assertEqual(rgb_to_bgr(0x112233), 0x332211)
        self.assertEqual(rgb_to_bgr(0xFF0000), 255)


class TestLayout(unittest.TestCase):
    def test_sample_layout(self):
        lay = build_layout(helpers.load_hello())
        self.assertEqual(list(lay.var_sheets), ["PLAYER", "VEHICLES", "WORLD"])
        self.assertEqual(lay.frame_range_a1(), "A4:CB48")
        self.assertEqual(lay.vars_by_key["player.health"].row, 2)
        names = lay.defined_names()
        self.assertEqual(names["PoliceBudget"], ("RULES", 3, 2))
        self.assertEqual(names["BaseBudget"][0], "WORLD")
        self.assertIn("RULES", lay.all_sheets())
        self.assertEqual(lay.all_sheets()[0], "GAME")
        self.assertEqual(lay.warnings, [])
        acts = dict(lay.input_actions())
        self.assertIn("{UP}", acts["up"])

    def test_names(self):
        for n in ("AlertLevel", "PosX", "BaseBudget", "_x"):
            self.assertTrue(valid_defined_name(n), n)
        for n in ("A1", "XFD1", "R1C1", "R", "C", "1abc", "has space", ""):
            self.assertFalse(valid_defined_name(n), n)
        self.assertEqual(column_name(479), "RL")

    def test_formula_separators(self):
        self.assertEqual(excel_to_calc_formula('=ROUND(A*B, 0)&","'), '=ROUND(A*B; 0)&","')
        self.assertEqual(calc_to_excel_formula("=MAX(1;2)"), "=MAX(1,2)")

    def test_normalise(self):
        lay = build_layout(helpers.load_hello())
        v = lay.vars_by_key
        self.assertEqual(normalise_value(v["player.cash"], 250.0), 250)
        self.assertEqual(normalise_value(v["player.health"], "1,234.5"), 1234.5)
        self.assertEqual(normalise_value(v["player.invincible"], 1.0), True)
        self.assertEqual(normalise_value(v["player.invincible"], "FALSE"), False)
        self.assertEqual(normalise_value(v["world.weather"], "Rain"), "Rain")
        self.assertEqual(normalise_value(v["player.health"], "abc"), "abc")

    def test_hud(self):
        l1, l2 = hud_lines({"stats": [["CASH", "$1"], ["HP", "9"]], "objective": "Go", "banner": "BUSTED", "meter": 2})
        self.assertEqual(l1, "CASH: $1   HP: 9   ALERT ★★☆☆☆")
        self.assertEqual(l2, "Go   |   BUSTED")


if __name__ == "__main__":
    unittest.main()
