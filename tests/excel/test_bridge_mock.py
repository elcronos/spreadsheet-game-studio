"""Bridge end to end over a real WebSocket with the mock sink.

Covers: hello -> ready, TS-encoded fixture frames -> exact cells (both
strategies), acks/backpressure/coalescing, state writes, user edits and rule
edits with echo suppression, busy sink self-healing, VBA INPUT polling,
disconnect handling and reconnection, protocol errors, client replacement.
"""
import asyncio
import json
import os
import unittest

import numpy as np

from helpers import FIXTURES, BridgeThread, Client, load_hello
from sgs_bridge.protocol import encode_frame, keyframe_runs
from sgs_bridge.sinks.base import SinkBusy
from sgs_bridge.sinks.mock import MockSink

SGF = os.path.join(FIXTURES, "sgf1")
with open(os.path.join(SGF, "manifest.json")) as _fh:
    MANIFEST = json.load(_fh)["frames"]
SEQ = [e for e in MANIFEST if e["file"].startswith("seq")]


def fixture(e):
    with open(os.path.join(SGF, e["file"]), "rb") as fh:
        return fh.read()


def expected_rgb(i):
    e = SEQ[i]
    idx = np.frombuffer(bytes.fromhex(e["indices"]), np.uint8).reshape(e["height"], e["width"])
    pal = None
    for f in SEQ[: i + 1]:
        if f["palette"] is not None:
            pal = np.array(f["palette"], np.int64)
    return pal[idx]


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, 60))


class BridgeCase(unittest.TestCase):
    strategy = "values-cf"
    sink_kw: dict = {}

    def setUp(self):
        self.sink = MockSink(strategy=self.strategy, **self.sink_kw)
        self.bt = BridgeThread(self.sink, poll_ms=40, input_poll_ms=20, state_interval=0.02, hud_interval=0.02, sheet_interval=0.02, telemetry_interval=0.02, input_release_s=0.15).__enter__()

    def tearDown(self):
        self.bt.__exit__(None, None, None)

    async def connect_hello(self, w=24, h=10):
        c = await Client.connect(self.bt.url)
        await c.send_json(load_hello(w, h))
        ready = await c.recv_type("ready")
        return c, ready


class TestFramesValuesCf(BridgeCase):
    strategy = "values-cf"

    def test_ts_fixture_sequence_exact_cells(self):
        async def go():
            c, ready = await self.connect_hello()
            self.assertEqual((ready["sink"], ready["strategy"], ready["width"], ready["height"]), ("mock", self.strategy, 24, 10))
            for i, e in enumerate(SEQ):
                await c.ws.send(fixture(e))
                ack = await c.recv_type("ack")
                self.assertEqual(ack["frameId"], e["frameId"])
                self.assertGreaterEqual(ack["applyMs"], 0)
                np.testing.assert_array_equal(self.sink.rendered(), expected_rgb(i), err_msg=e["file"])
                if not e["runs"]:
                    self.assertEqual(ack["cells"], 0)
            await c.close()
        run(go())

    def test_backpressure_coalescing_and_all_acked(self):
        self.sink.call_ms = 30  # slow sink

        async def go():
            c, _ = await self.connect_hello(16, 8)
            rng = np.random.default_rng(0)
            pal = list(range(0, 64 * 1000, 1000))
            frames = [rng.integers(0, 64, (8, 16)).astype(np.uint8) for _ in range(8)]
            for i, f in enumerate(frames):  # no waiting: ignore the ack window on purpose
                await c.ws.send(encode_frame(i + 1, f, keyframe_runs(16, 8), True, pal))
            acks = [await c.recv_type("ack") for _ in frames]
            self.assertEqual(sorted(a["frameId"] for a in acks), list(range(1, 9)))
            self.assertTrue(any(a.get("coalesced") for a in acks), acks)
            self.assertLess(self.sink.frames_applied, 8)
            np.testing.assert_array_equal(self.sink.rendered(), np.array(pal)[frames[-1]])
            await c.close()
        run(go())

    def test_busy_sink_self_heals(self):
        prim = "_write_band" if self.strategy == "values-cf" else "_fill_rects"
        orig = getattr(self.sink, prim)
        state = {"busy": 1}

        def flaky(*a):
            if state["busy"]:
                state["busy"] -= 1
                raise SinkBusy("cell edit mode")
            return orig(*a)

        setattr(self.sink, prim, flaky)

        async def go():
            c, _ = await self.connect_hello(8, 4)
            pal = [0x000000, 0xFFFFFF]
            a = np.zeros((4, 8), np.uint8)
            a[1, 2] = 1
            await c.ws.send(encode_frame(1, a, keyframe_runs(8, 4), True, pal))
            ack = await c.recv_type("ack")
            self.assertTrue(ack.get("busy"))
            b = a.copy()
            b[3, 7] = 1
            await c.ws.send(encode_frame(2, b, [(3, 7, 1)], False, None))  # only one run
            ack = await c.recv_type("ack")
            self.assertFalse(ack.get("busy", False))
            # the keyframe content that failed earlier was rewritten too
            np.testing.assert_array_equal(self.sink.rendered(), np.array(pal)[b])
            await c.close()
        run(go())

    def test_frames_before_hello_and_size_change(self):
        async def go():
            c = await Client.connect(self.bt.url)
            f = np.arange(12, dtype=np.uint8).reshape(3, 4)
            pal = list(range(12))
            await c.ws.send(encode_frame(1, f, keyframe_runs(4, 3), True, pal))
            await c.recv_type("ready")
            await c.recv_type("ack")
            np.testing.assert_array_equal(self.sink.rendered(), np.array(pal)[f])
            g = np.ones((2, 5), np.uint8)
            await c.ws.send(encode_frame(2, g, keyframe_runs(5, 2), True, pal))
            r = await c.recv_type("ready")
            self.assertEqual((r["width"], r["height"]), (5, 2))
            await c.recv_type("ack")
            np.testing.assert_array_equal(self.sink.rendered(), np.full((2, 5), 1))
            await c.close()
        run(go())

    def test_protocol_errors_are_reported(self):
        async def go():
            c, _ = await self.connect_hello(8, 4)
            await c.ws.send(b"JUNKJUNKJUNKJUNKJUNKJUNKJUNK")
            self.assertIn("bad frame", (await c.recv_type("error"))["message"])
            await c.ws.send("not json")
            await c.recv_type("error")
            await c.send_json({"t": "wat"})
            self.assertIn("unknown", (await c.recv_type("error"))["message"])
            # still alive
            await c.ws.send(encode_frame(9, np.zeros((4, 8), np.uint8), keyframe_runs(8, 4), True, [0]))
            self.assertEqual((await c.recv_type("ack"))["frameId"], 9)
            await c.close()
        run(go())


class TestFramesInterior(TestFramesValuesCf):
    """Same suite through the Excel multi-area address path (<= 255 chars) of the mock."""
    strategy = "interior"

    def test_address_strings_used(self):
        async def go():
            c, _ = await self.connect_hello()
            await c.ws.send(fixture(SEQ[0]))
            await c.recv_type("ack")
            self.assertGreater(self.sink.address_strings, 0)
            await c.close()
        run(go())


class TestStateAndEdits(BridgeCase):
    def test_state_hud_sheet_telemetry_written(self):
        async def go():
            c, _ = await self.connect_hello(8, 4)
            await c.send_json({"t": "state", "values": {"player.health": 42, "world.weather": "Rain", "player.invincible": True},
                               "rules": [{"name": "PoliceBudget", "formula": "=ROUND(BaseBudget*AlertLevel*PoliceResponse, 0)", "value": 3}]})
            await c.send_json({"t": "hud", "stats": [["CASH", "$250"]], "objective": "Deliver the van", "meter": 1})
            await c.send_json({"t": "sheet", "name": "MISSIONS", "columns": ["#", "Mission"], "rows": [{"cells": [1, "Delivery"], "style": "active"}]})
            await c.send_json({"t": "telemetry", "sheetFps": 12.5, "resolution": "8x4"})
            await asyncio.sleep(0.3)
            lay = self.sink.layout_
            self.assertEqual(self.sink.cell("PLAYER", lay.vars_by_key["player.health"].row, 2), 42.0)
            self.assertEqual(self.sink.cell("WORLD", lay.vars_by_key["world.weather"].row, 2), "Rain")
            self.assertEqual(self.sink.cell("RULES", lay.rules_by_name["PoliceBudget"].row, 3), 3)
            self.assertEqual(self.sink.hud, ["CASH: $250   ALERT ★☆☆☆☆", "Deliver the van"])
            self.assertEqual(self.sink.sheet_tables["MISSIONS"], [["#", "Mission"], [1, "Delivery"]])
            tel = dict(map(tuple, self.sink.sheet_tables["TELEMETRY"][1:]))
            self.assertEqual(tel["sheetFps"], 12.5)
            self.assertIn("bridge.frames", tel)
            # nothing the bridge wrote may come back as an edit
            await asyncio.sleep(0.2)
            self.assertFalse([m for m in c.inbox if m["t"] in ("edit", "rule")], c.inbox)
            await c.close()
        run(go())

    def test_user_edit_and_rule_edit_roundtrip(self):
        async def go():
            c, _ = await self.connect_hello(8, 4)
            lay = self.sink.layout_
            bb = lay.vars_by_key["world.baseBudget"]
            self.sink.user_edit("WORLD", bb.row, 2, 2.5)
            e = await c.recv_type("edit")
            self.assertEqual((e["key"], e["value"]), ("world.baseBudget", 2.5))
            # stale state from the game (sent before it applied the edit) must not clobber the cell
            await c.send_json({"t": "state", "values": {"world.baseBudget": 1.2}})
            await asyncio.sleep(0.15)
            self.assertEqual(self.sink.cell("WORLD", bb.row, 2), 2.5)
            # game confirms -> no further edit messages
            await c.send_json({"t": "state", "values": {"world.baseBudget": 2.5}})
            await asyncio.sleep(0.2)
            self.assertFalse([m for m in c.inbox if m["t"] == "edit"], c.inbox)
            pb = lay.rules_by_name["PoliceBudget"]
            al = lay.vars_by_key["player.alert"]
            self.sink.user_edit("PLAYER", al.row, 2, 2)
            await c.recv_type("edit")
            self.sink.user_edit("RULES", pb.row, 2, "=BaseBudget*AlertLevel")
            r = await c.recv_type("rule")
            self.assertEqual((r["name"], r["formula"]), ("PoliceBudget", "=BaseBudget*AlertLevel"))
            self.assertAlmostEqual(r["value"], 5.0)  # mock evaluates 2.5 * 2
            await c.close()
        run(go())

    def test_vba_input_sheet_polling(self):
        async def go():
            c, _ = await self.connect_hello(8, 4)
            self.sink.input_counts = {"up": 0, "left": 0}
            await asyncio.sleep(0.1)  # baseline
            self.sink.user_press("up")
            m = await c.recv_type("input")
            self.assertEqual((m["action"], m["down"]), ("up", True))
            m = await c.recv_type("input", timeout=2)
            self.assertEqual((m["action"], m["down"]), ("up", False))
            await c.close()
        run(go())


class TestConnections(BridgeCase):
    def test_disconnect_marks_hud_and_reconnect_works(self):
        async def go():
            c, _ = await self.connect_hello(8, 4)
            await c.ws.send(encode_frame(1, np.ones((4, 8), np.uint8), keyframe_runs(8, 4), True, [0, 0xFF]))
            await c.recv_type("ack")
            await c.close()
            for _ in range(50):
                if self.sink.hud[0].startswith("DISCONNECTED"):
                    break
                await asyncio.sleep(0.05)
            self.assertTrue(self.sink.hud[0].startswith("DISCONNECTED"), self.sink.hud)
            # workbook state kept
            np.testing.assert_array_equal(self.sink.rendered(), np.full((4, 8), 0xFF))
            c2, ready = await self.connect_hello(8, 4)
            await c2.ws.send(encode_frame(1, np.zeros((4, 8), np.uint8), keyframe_runs(8, 4), True, [0, 0xFF]))
            await c2.recv_type("ack")
            np.testing.assert_array_equal(self.sink.rendered(), np.zeros((4, 8)))
            await c2.send_json({"t": "bye"})
            await asyncio.sleep(0.2)
        run(go())

    def test_second_client_replaces_first(self):
        async def go():
            c1, _ = await self.connect_hello(8, 4)
            c2, _ = await self.connect_hello(8, 4)
            err = await c1.recv_type("error")
            self.assertIn("replaced", err["message"])
            await c2.ws.send(encode_frame(5, np.zeros((4, 8), np.uint8), keyframe_runs(8, 4), True, [0]))
            self.assertEqual((await c2.recv_type("ack"))["frameId"], 5)
            await c2.close()
        run(go())

    def test_wrong_path_rejected(self):
        async def go():
            import websockets

            ws = await websockets.connect(self.bt.url.replace("/sgs", "/other"))
            with self.assertRaises(websockets.ConnectionClosed):
                await asyncio.wait_for(ws.recv(), 5)
            self.assertEqual(ws.close_code, 4404)
            await ws.close()
        run(go())


if __name__ == "__main__":
    unittest.main()
