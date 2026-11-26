/**
 * Frame data types shared by every renderer backend.
 *
 * A game renders into an RGBA framebuffer (one texel per spreadsheet cell).
 * The framebuffer pipeline converts it into an IndexedFrame: one palette index
 * per cell. Backends receive IndexedFrames (plus a diff) so that they never
 * have to do per-pixel colour work themselves.
 */

/** Packed 0xRRGGBB colours. Max 256 entries. */
export type Palette = Uint32Array;

export interface RGBAFrame {
  width: number;
  height: number;
  /** Row-major, top row first, 4 bytes per cell. */
  data: Uint8Array | Uint8ClampedArray;
}

export interface IndexedFrame {
  id: number;
  width: number;
  height: number;
  /** Row-major, top row first, one palette index per cell. Valid only during submitFrame():
   * the pipeline reuses this buffer two frames later, so backends that keep it must copy it. */
  indices: Uint8Array;
  palette: Palette;
  /** Incremented whenever palette entries change meaning. */
  paletteVersion: number;
}

/** A horizontal span of changed cells on one row. */
export interface DirtyRun {
  row: number;
  x0: number;
  length: number;
}

export interface FrameDiff {
  /** True when every cell must be (re)written, e.g. first frame or resize. */
  keyframe: boolean;
  changedCells: number;
  runs: DirtyRun[];
  /** Bounding rectangle of all changes, inclusive-exclusive. null when nothing changed. */
  bounds: { x0: number; y0: number; x1: number; y1: number } | null;
}

export const RESOLUTION_PRESETS = [
  { id: "80x45", width: 80, height: 45 },
  { id: "160x90", width: 160, height: 90 },
  { id: "240x135", width: 240, height: 135 },
  { id: "320x180", width: 320, height: 180 },
  { id: "480x270", width: 480, height: 270 },
  { id: "640x360", width: 640, height: 360 },
] as const;

export type ResolutionId = (typeof RESOLUTION_PRESETS)[number]["id"];

export function hex(c: number): string {
  return "#" + (c & 0xffffff).toString(16).padStart(6, "0").toUpperCase();
}

/** Spreadsheet column name for a 0-based column index: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnName(i: number): string {
  let s = "";
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

/** A1-style address of a framebuffer cell given the sheet origin of the GAME range. */
export function cellAddress(x: number, y: number, originCol = 0, originRow = 0): string {
  return columnName(x + originCol) + String(y + originRow + 1);
}

export function parseCellAddress(addr: string): { col: number; row: number } | null {
  const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(addr.trim().toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}
