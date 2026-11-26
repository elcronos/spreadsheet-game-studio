"""FrameState, echo suppression, VBA input timing, key mapping."""
import unittest

import numpy as np

import helpers  # noqa: F401
from sgs_bridge.input_capture import KeyMapper, key_to_code
from sgs_bridge.layout import build_layout
from sgs_bridge.protocol import ProtocolError, decode_frame, encode_frame, keyframe_runs
from sgs_bridge.sinks.mock import MockSink
from sgs_bridge.state import EchoGuard, FrameState
from sgs_bridge.sync import InputTracker, StateSync


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class TestFrameState(unittest.TestCase):
    def test_apply_and_dirty(self):
        fs = FrameState(4, 2, [0, 0xFFFFFF])
        self.assertTrue(fs.dirty.all())
        idx = np.array([[1, 0, 1, 0], [0, 0, 0, 0]], np.uint8)
        fs.apply(decode_frame(encode_frame(1, idx, keyframe_runs(4, 2), True, [0, 0xFFFFFF])))
        np.testing.assert_array_equal(fs.target, idx)
        fs.dirty[:] = False
        idx2 = idx.copy()
        idx2[1, 2] = 1
        fs.apply(decode_frame(encode_frame(2, idx2, [(1, 2, 1)], False, None)))
        self.assertEqual(int(fs.dirty.sum()), 1)
        self.assertEqual(fs.rgb()[1, 2], 0xFFFFFF)

    def test_size_mismatch(self):
        fs = FrameState(4, 2)
        with self.assertRaises(ProtocolError):
            fs.apply(decode_frame(encode_frame(1, np.zeros((3, 3), np.uint8), [], True, None)))

    def test_palette_slots(self):
        fs = FrameState(3, 1, [1, 2, 3])
        fs.target[:] = [0, 1, 2]
        fs.dirty[:] = False
        fs.changed_slots.clear()
        changed = fs.set_palette(np.array([1, 9, 3], np.uint32), 1)
        self.assertEqual(changed, [1])
        self.assertEqual(fs.mark_slots_dirty(fs.changed_slots), 1)
        self.assertEqual(fs.dirty.tolist(), [[False, True, False]])


class TestEchoGuard(unittest.TestCase):
    def test_own_writes_are_not_edits(self):
        g = EchoGuard(clock=Clock())
        self.assertTrue(g.want_write("var:a", 5))
        g.wrote("var:a", 5, 5)
        self.assertFalse(g.observe("var:a", 5))
        self.assertFalse(g.want_write("var:a", 5))

    def test_user_edit_then_game_echo(self):
        c = Clock()
        g = EchoGuard(hold_s=1.0, clock=c)
        g.wrote("var:a", 5, 5)
        self.assertTrue(g.observe("var:a", 7))      # user typed 7
        self.assertFalse(g.observe("var:a", 7))     # reported once
        self.assertFalse(g.want_write("var:a", 5))  # stale game state must not overwrite the edit
        self.assertFalse(g.want_write("var:a", 7))  # game echoes the edit -> nothing to write
        self.assertFalse(g.held("var:a"))

    def test_rejected_edit_is_reverted_after_hold(self):
        c = Clock()
        g = EchoGuard(hold_s=1.0, clock=c)
        g.wrote("var:a", 5, 5)
        g.observe("var:a", 999)
        self.assertFalse(g.want_write("var:a", 5))
        c.t = 1.5
        self.assertTrue(g.want_write("var:a", 5))

    def test_formula_canonicalisation(self):
        g = EchoGuard(clock=Clock())
        g.wrote("rule:R", "=a * b", "=A*B")
        self.assertFalse(g.observe("rule:R", "=a*b"))
        self.assertFalse(g.want_write("rule:R", "=A*B"))
        self.assertTrue(g.observe("rule:R", "=a*b*2"))


class TestStateSyncWithMock(unittest.TestCase):
    def setUp(self):
        self.lay = build_layout(helpers.load_hello(8, 4))
        self.sink = MockSink()
        self.sink.layout(self.lay)
        self.sync = StateSync(self.sink, self.lay)

    def test_no_edits_after_layout_and_writes(self):
        self.assertEqual(self.sync.poll(), [])
        self.assertEqual(self.sync.push({"player.health": 50, "world.weather": "Rain", "player.invincible": True}, []), [])
        self.assertEqual(self.sink.cell("PLAYER", 2, 2), 50.0)
        self.assertEqual(self.sync.poll(), [])

    def test_edit_detected_before_write(self):
        self.sink.user_edit("PLAYER", 2, 2, 77)
        out = self.sync.push({"player.health": 100}, [])  # stale game value
        self.assertEqual(out, ['{"t":"edit","key":"player.health","value":77}'])
        self.assertEqual(self.sink.cell("PLAYER", 2, 2), 77)  # not overwritten

    def test_read_only_reverted(self):
        row = self.lay.vars_by_key["player.inVehicle"].row
        self.sink.user_edit("PLAYER", row, 2, "tank")
        self.assertEqual(self.sync.poll(), [])
        self.sync.push({"player.inVehicle": "on foot"}, [])
        self.assertEqual(self.sink.cell("PLAYER", row, 2), "on foot")

    def test_selected_cell_not_overwritten(self):
        self.sink.selected = ("PLAYER", 2, 2)
        self.sync.push({"player.health": 12}, [])
        self.assertEqual(self.sink.cell("PLAYER", 2, 2), 100.0)
        self.sink.selected = None
        self.sync.push({"player.health": 12}, [])
        self.assertEqual(self.sink.cell("PLAYER", 2, 2), 12.0)

    def test_rules(self):
        rr = self.lay.rules_by_name["PoliceBudget"]
        self.sink.user_edit("RULES", rr.row, 2, "=BaseBudget*AlertLevel*3")
        out = self.sync.poll()
        self.assertEqual(len(out), 1)
        self.assertIn('"t":"rule"', out[0])
        self.assertIn('"formula":"=BaseBudget*AlertLevel*3"', out[0])
        # game accepts: state carries the same formula -> no rewrite, value column updated
        self.sync.push({}, [{"name": "PoliceBudget", "formula": "=BaseBudget*AlertLevel*3", "value": 4}])
        self.assertEqual(self.sink.cell("RULES", rr.row, 3), 4)
        self.assertEqual(self.sync.poll(), [])


class TestInputTracker(unittest.TestCase):
    def test_press_hold_release(self):
        t = InputTracker(release_s=0.6)
        self.assertEqual(t.update({"up": 0}, 0.0), [])
        self.assertEqual(t.update({"up": 1}, 0.1), [("up", True)])
        self.assertEqual(t.update({"up": 1}, 0.5), [])
        self.assertEqual(t.update({"up": 5}, 0.65), [])  # auto-repeat keeps it held
        self.assertEqual(t.update({"up": 5}, 1.2), [])
        self.assertEqual(t.update({"up": 5}, 1.3), [("up", False)])

    def test_baseline_from_saved_workbook(self):
        t = InputTracker()
        self.assertEqual(t.update({"up": 42}, 0.0), [])


class TestKeyMapper(unittest.TestCase):
    def test_mapping_and_repeat(self):
        m = KeyMapper()
        self.assertEqual(m.event("KeyW", True), ("up", True))
        self.assertIsNone(m.event("KeyW", True))  # auto-repeat
        self.assertIsNone(m.event("ArrowUp", True))  # same action already down
        self.assertIsNone(m.event("KeyW", False))
        self.assertEqual(m.event("ArrowUp", False), ("up", False))
        self.assertIsNone(m.event("KeyZ", True))

    def test_key_to_code(self):
        class K:
            def __init__(self, char=None, name=None):
                self.char, self.name = char, name
        self.assertEqual(key_to_code(K(char="w")), "KeyW")
        self.assertEqual(key_to_code(K(name="up")), "ArrowUp")
        self.assertEqual(key_to_code(K(name="shift_r")), "ShiftRight")
        self.assertEqual(key_to_code(K(name="space")), "Space")


if __name__ == "__main__":
    unittest.main()
