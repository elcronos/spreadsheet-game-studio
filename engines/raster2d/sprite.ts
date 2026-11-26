/**
 * Pixel-art sprites authored as arrays of strings plus a char -> colour map:
 *
 *   spriteFromStrings([
 *     ".kk.",
 *     "kook",
 *   ], { k: 0x3a2418, o: 0xf08a2c })
 *
 * "." and " " are always transparent; a palette entry of null is transparent too.
 */
import type { Color } from "./color";

export const TRANSPARENT = -1;

export class Sprite {
  constructor(
    readonly w: number,
    readonly h: number,
    /** Row-major 0xRRGGBB, or TRANSPARENT (-1). */
    readonly px: Int32Array,
    /** Optional anchor (e.g. feet) used by callers; defaults to bottom-centre. */
    readonly ax = Math.floor(w / 2),
    readonly ay = h,
  ) {}

  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return TRANSPARENT;
    return this.px[y * this.w + x];
  }

  withAnchor(ax: number, ay: number): Sprite {
    return new Sprite(this.w, this.h, this.px, ax, ay);
  }
}

export type SpritePalette = Record<string, Color | null>;

export function spriteFromStrings(rows: readonly string[], palette: SpritePalette, name = "sprite"): Sprite {
  const h = rows.length;
  if (!h) throw new Error(`${name}: empty sprite`);
  const w = rows[0].length;
  const px = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    if (row.length !== w) throw new Error(`${name}: row ${y} has ${row.length} chars, expected ${w}`);
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      if (ch === "." || ch === " ") {
        px[y * w + x] = TRANSPARENT;
        continue;
      }
      if (!(ch in palette)) throw new Error(`${name}: unknown palette char "${ch}" at ${x},${y}`);
      const c = palette[ch];
      px[y * w + x] = c === null ? TRANSPARENT : c;
    }
  }
  return new Sprite(w, h, px);
}

/** Build many sprites sharing one palette. */
export function defineSprites<K extends string>(defs: Record<K, readonly string[]>, palette: SpritePalette): Record<K, Sprite> {
  const out = {} as Record<K, Sprite>;
  for (const k of Object.keys(defs) as K[]) out[k] = spriteFromStrings(defs[k], palette, k);
  return out;
}

/** Swap colours (exact matches) - palette swaps for seasons, variants, team colours. */
export function recolor(s: Sprite, map: Map<Color, Color> | Record<number, Color>): Sprite {
  const m = map instanceof Map ? map : new Map(Object.entries(map).map(([k, v]) => [Number(k), v]));
  const px = new Int32Array(s.px.length);
  for (let i = 0; i < px.length; i++) {
    const c = s.px[i];
    px[i] = c === TRANSPARENT ? c : (m.get(c) ?? c);
  }
  return new Sprite(s.w, s.h, px, s.ax, s.ay);
}

export function flipSpriteX(s: Sprite): Sprite {
  const px = new Int32Array(s.px.length);
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) px[y * s.w + x] = s.px[y * s.w + (s.w - 1 - x)];
  return new Sprite(s.w, s.h, px, s.w - s.ax, s.ay);
}

/** Stack sprites vertically (e.g. a shared torso over per-frame legs). Widths must match. */
export function stackSprites(parts: Sprite[]): Sprite {
  const w = parts[0].w;
  const h = parts.reduce((s, p) => s + p.h, 0);
  const px = new Int32Array(w * h);
  let y0 = 0;
  for (const p of parts) {
    if (p.w !== w) throw new Error("stackSprites: width mismatch");
    px.set(p.px, y0 * w);
    y0 += p.h;
  }
  return new Sprite(w, h, px);
}

/** Pick an animation frame for time t (seconds) at fps. */
export function animFrame<T>(frames: readonly T[], t: number, fps: number): T {
  return frames[Math.floor(t * fps) % frames.length];
}
