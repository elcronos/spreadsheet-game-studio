/**
 * SGF1 wire protocol: compact binary frames for out-of-process spreadsheet
 * renderers (Excel bridge, LibreOffice bridge, recorders).
 *
 * Little-endian layout (see references/protocol.md):
 *   0  char[4] magic "SGF1"
 *   4  u32     frameId
 *   8  u16     width
 *   10 u16     height
 *   12 u8      flags  (bit0 keyframe, bit1 palette present)
 *   13 u8      reserved
 *   14 u16     paletteCount (0 when palette absent)
 *   16 u32     paletteVersion
 *   20 u32     runCount
 *   24 ...     palette: paletteCount * 3 bytes (R,G,B)
 *   .. ...     runs: { u16 row, u16 x0, u16 length, u8[length] indices }
 *
 * State and control messages travel as JSON text frames on the same socket:
 *   {"t":"hello", ...} {"t":"state", "values":{...}} {"t":"edit", "key":..., "value":...}
 *   {"t":"input", "action":..., "down":true} {"t":"ack", "frameId":n, "applyMs":x}
 */
import type { FrameDiff, IndexedFrame } from "../../engines/core/frame";

export const MAGIC = 0x31464753; // "SGF1" little-endian
export const FLAG_KEY = 1;
export const FLAG_PALETTE = 2;

export function encodeFrame(frame: IndexedFrame, diff: FrameDiff, includePalette: boolean): Uint8Array {
  const palN = includePalette ? frame.palette.length : 0;
  let size = 24 + palN * 3;
  for (const r of diff.runs) size += 6 + r.length;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, frame.id >>> 0, true);
  dv.setUint16(8, frame.width, true);
  dv.setUint16(10, frame.height, true);
  buf[12] = (diff.keyframe ? FLAG_KEY : 0) | (includePalette ? FLAG_PALETTE : 0);
  dv.setUint16(14, palN, true);
  dv.setUint32(16, frame.paletteVersion >>> 0, true);
  dv.setUint32(20, diff.runs.length, true);
  let o = 24;
  for (let i = 0; i < palN; i++) {
    const c = frame.palette[i];
    buf[o++] = (c >> 16) & 255;
    buf[o++] = (c >> 8) & 255;
    buf[o++] = c & 255;
  }
  const w = frame.width;
  for (const r of diff.runs) {
    dv.setUint16(o, r.row, true);
    dv.setUint16(o + 2, r.x0, true);
    dv.setUint16(o + 4, r.length, true);
    o += 6;
    buf.set(frame.indices.subarray(r.row * w + r.x0, r.row * w + r.x0 + r.length), o);
    o += r.length;
  }
  return buf;
}

export interface DecodedFrame {
  frameId: number;
  width: number;
  height: number;
  keyframe: boolean;
  palette: Uint32Array | null;
  paletteVersion: number;
  runs: { row: number; x0: number; indices: Uint8Array }[];
}

export function decodeFrame(buf: Uint8Array): DecodedFrame {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error("Bad magic");
  const width = dv.getUint16(8, true), height = dv.getUint16(10, true);
  const flags = buf[12];
  const palN = dv.getUint16(14, true);
  const paletteVersion = dv.getUint32(16, true);
  const runCount = dv.getUint32(20, true);
  let o = 24;
  let palette: Uint32Array | null = null;
  if (flags & FLAG_PALETTE) {
    palette = new Uint32Array(palN);
    for (let i = 0; i < palN; i++, o += 3) palette[i] = (buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2];
  }
  const runs: DecodedFrame["runs"] = [];
  for (let i = 0; i < runCount; i++) {
    const row = dv.getUint16(o, true), x0 = dv.getUint16(o + 2, true), len = dv.getUint16(o + 4, true);
    o += 6;
    if (row >= height || x0 + len > width) throw new Error("Run out of bounds");
    runs.push({ row, x0, indices: buf.subarray(o, o + len) });
    o += len;
  }
  return { frameId: dv.getUint32(4, true), width, height, keyframe: !!(flags & FLAG_KEY), palette, paletteVersion, runs };
}
