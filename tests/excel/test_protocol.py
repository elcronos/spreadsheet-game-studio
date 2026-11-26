"""SGF1: the Python decoder must match the TypeScript encoder byte for byte.

Fixtures are produced by tests/excel/gen_fixtures.ts with the real
renderers/framebuffer/protocol.ts encoder and FramePipeline.
"""
import json
import os
import unittest

import numpy as np

from helpers import FIXTURES, node_available, run_node  # noqa: F401  (sets sys.path)
from sgs_bridge.protocol import (
    FLAG_KEY, FLAG_PALETTE, HEADER, ProtocolError, decode_frame, encode_frame, keyframe_runs, msg_ack, parse_text,
)
from sgs_bridge.state import FrameState

SGF = os.path.join(FIXTURES, "sgf1")


def manifest():
    with open(os.path.join(SGF, "manifest.json")) as fh:
        return json.load(fh)["frames"]


def read(name):
    with open(os.path.join(SGF, name), "rb") as fh:
        return fh.read()


class TestDecodeTsFixtures(unittest.TestCase):
    def test_header_fields_and_runs(self):
        for e in manifest():
            with self.subTest(e["file"]):
                f = decode_frame(read(e["file"]))
                self.assertEqual(f.frame_id, e["frameId"])
                self.assertEqual((f.width, f.height), (e["width"], e["height"]))
                self.assertEqual(f.keyframe, e["keyframe"])
                self.assertEqual(f.palette_version, e["paletteVersion"])
                self.assertEqual(f.nbytes, e["bytes"])
                if e["palette"] is None:
                    self.assertIsNone(f.palette)
                else:
                    self.assertEqual(f.palette.tolist(), e["palette"])
                self.assertEqual([[r.row, r.x0, r.length] for r in f.runs], e["runs"])

    def test_applying_sequence_reconstructs_every_frame(self):
        frames = [e for e in manifest() if e["file"].startswith("seq")]
        fs = FrameState(frames[0]["width"], frames[0]["height"])
        for e in frames:
            fs.apply(decode_frame(read(e["file"])))
            exp = np.frombuffer(bytes.fromhex(e["indices"]), dtype=np.uint8).reshape(e["height"], e["width"])
            np.testing.assert_array_equal(fs.target, exp, err_msg=e["file"])
        # palette kept from the last frame that carried one (fixed256 after the mode switch)
        self.assertEqual(fs.palette_count, 256)

    def test_python_encoder_is_byte_identical(self):
        prev = None
        for e in manifest():
            with self.subTest(e["file"]):
                idx = np.frombuffer(bytes.fromhex(e["indices"]), dtype=np.uint8).reshape(e["height"], e["width"])
                buf = encode_frame(e["frameId"], idx, [tuple(r) for r in e["runs"]], e["keyframe"], e["palette"], e["paletteVersion"])
                self.assertEqual(buf, read(e["file"]))
                prev = idx

    def test_zero_copy_views(self):
        f = decode_frame(read("seq_00.sgf1"))
        self.assertEqual(f.runs[0].indices.dtype, np.uint8)
        self.assertFalse(f.runs[0].indices.flags.owndata)


class TestDecodeErrors(unittest.TestCase):
    def test_bad_magic(self):
        b = bytearray(read("seq_00.sgf1"))
        b[0:4] = b"XXXX"
        with self.assertRaisesRegex(ProtocolError, "magic"):
            decode_frame(bytes(b))

    def test_truncated(self):
        b = read("seq_00.sgf1")
        for n in (10, 24 + 5, len(b) - 1):
            with self.assertRaises(ProtocolError):
                decode_frame(b[:n])

    def test_run_out_of_bounds(self):
        idx = np.zeros((2, 4), np.uint8)
        b = bytearray(encode_frame(1, idx, [(0, 0, 4)], True, None))
        # patch run x0 to 2 -> 2+4 > width
        b[24 + 2] = 2
        with self.assertRaisesRegex(ProtocolError, "out of bounds"):
            decode_frame(bytes(b))
        b = bytearray(encode_frame(1, idx, [(1, 0, 4)], True, None))
        b[24] = 5  # row 5 >= height
        with self.assertRaisesRegex(ProtocolError, "out of bounds"):
            decode_frame(bytes(b))

    def test_flags(self):
        idx = np.arange(6, dtype=np.uint8).reshape(2, 3)
        b = encode_frame(7, idx, keyframe_runs(3, 2), True, [0x112233, 0xFFFFFF], 9)
        magic, fid, w, h, flags, _r, pn, pv, rc = HEADER.unpack_from(b, 0)
        self.assertEqual((fid, w, h, flags, pn, pv, rc), (7, 3, 2, FLAG_KEY | FLAG_PALETTE, 2, 9, 2))
        f = decode_frame(b)
        self.assertEqual(f.palette.tolist(), [0x112233, 0xFFFFFF])

    def test_json_messages(self):
        self.assertEqual(parse_text('{"t":"hello"}')["t"], "hello")
        for bad in ("nope", "[1]", '{"x":1}', '{"t":3}'):
            with self.assertRaises(ProtocolError):
                parse_text(bad)
        a = json.loads(msg_ack(np.int64(5), 1.23456, 10, 2, bytes=99))
        self.assertEqual(a, {"t": "ack", "frameId": 5, "applyMs": 1.235, "cells": 10, "calls": 2, "bytes": 99})


@unittest.skipUnless(node_available(), "node + tsx not available")
class TestFixturesAreFresh(unittest.TestCase):
    def test_regenerating_fixtures_is_deterministic(self):
        before = {e["file"]: read(e["file"]) for e in manifest()}
        p = run_node(["tests/excel/gen_fixtures.ts"])
        self.assertEqual(p.returncode, 0, p.stderr)
        after = {e["file"]: read(e["file"]) for e in manifest()}
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
