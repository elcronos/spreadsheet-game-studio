/**
 * Generates SGF1 protocol fixtures with the real TypeScript encoder
 * (renderers/framebuffer/protocol.ts) and FramePipeline, for the Python
 * decoder tests (tests/excel/test_protocol.py).
 *
 *   node --import tsx tests/excel/gen_fixtures.ts
 *
 * Writes tests/excel/fixtures/sgf1/*.sgf1 + manifest.json.
 * Deterministic: re-running produces identical bytes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FramePipeline } from "../../renderers/framebuffer/pipeline";
import { encodeFrame } from "../../renderers/framebuffer/protocol";
import type { FrameDiff, IndexedFrame } from "../../engines/core/frame";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "fixtures", "sgf1");
mkdirSync(out, { recursive: true });

function scene(w: number, h: number, t: number, rgba: Uint8Array): void {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = (x * 255) / Math.max(1, w - 1);
      rgba[o + 1] = (y * 255) / Math.max(1, h - 1);
      rgba[o + 2] = 90;
      rgba[o + 3] = 255;
      const sx = 3 + t * 2, sy = 2 + (t % 3);
      if (x >= sx && x < sx + 4 && y >= sy && y < sy + 3) {
        rgba[o] = 250; rgba[o + 1] = 250; rgba[o + 2] = 20;
      }
    }
}

interface Entry {
  file: string;
  frameId: number;
  width: number;
  height: number;
  keyframe: boolean;
  paletteVersion: number;
  palette: number[] | null;
  runs: [number, number, number][];
  bytes: number;
  /** Full frame indices after this frame, hex string row-major. */
  indices: string;
}

function emit(seq: string, n: number, frame: IndexedFrame, diff: FrameDiff, includePalette: boolean, list: Entry[]): void {
  const buf = encodeFrame(frame, diff, includePalette);
  const file = `${seq}_${String(n).padStart(2, "0")}.sgf1`;
  writeFileSync(join(out, file), buf);
  list.push({
    file,
    frameId: frame.id,
    width: frame.width,
    height: frame.height,
    keyframe: diff.keyframe,
    paletteVersion: frame.paletteVersion,
    palette: includePalette ? Array.from(frame.palette) : null,
    runs: diff.runs.map((r) => [r.row, r.x0, r.length]),
    bytes: buf.byteLength,
    indices: Buffer.from(frame.indices).toString("hex"),
  });
}

const entries: Entry[] = [];
{
  const w = 24, h = 10;
  const p = new FramePipeline(w, h, { mode: "fixed64", hysteresis: 0 });
  const rgba = new Uint8Array(w * h * 4);
  let lastVer = -1;
  for (let t = 0; t < 4; t++) {
    scene(w, h, t, rgba);
    const { frame, diff } = p.process(rgba);
    emit("seq", t, frame, diff, diff.keyframe || frame.paletteVersion !== lastVer, entries);
    lastVer = frame.paletteVersion;
  }
  // palette mode change -> paletteVersion bump -> palette included on a diff frame
  p.quantizer.setOptions({ mode: "fixed256" });
  scene(w, h, 4, rgba);
  {
    const { frame, diff } = p.process(rgba);
    emit("seq", 4, frame, diff, frame.paletteVersion !== lastVer, entries);
    lastVer = frame.paletteVersion;
  }
  // identical input -> empty diff (0 runs)
  {
    const { frame, diff } = p.process(rgba);
    emit("seq", 5, frame, diff, false, entries);
  }
}
{
  // odd tiny frame: 1 column wide
  const p = new FramePipeline(1, 3, { mode: "fixed64", hysteresis: 0 });
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  const { frame, diff } = p.process(rgba);
  emit("tiny", 0, frame, diff, true, entries);
}
writeFileSync(join(out, "manifest.json"), JSON.stringify({ generator: "tests/excel/gen_fixtures.ts", frames: entries }, null, 1));
console.log(`wrote ${entries.length} frames to ${out}`);
