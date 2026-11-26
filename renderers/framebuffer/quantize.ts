/**
 * Colour quantisation: RGBA framebuffer -> palette indices, one per cell.
 *
 * - 15-bit lookup table (32768 entries) gives O(1) nearest-colour per cell.
 * - Fixed palettes are stable across frames (best for Excel conditional
 *   formatting, where changing the palette means rewriting format rules).
 * - Adaptive palettes use median cut on a sampled histogram and keep slot
 *   assignments stable between rebuilds to avoid whole-frame churn.
 * - Temporal hysteresis keeps a cell's previous index while the new colour
 *   is within a threshold of it: less flicker and far fewer changed cells.
 * - Optional 4x4 ordered dithering.
 */
import type { Palette } from "../../engines/core/frame";

export type PaletteMode = "fixed256" | "fixed64" | "adaptive";

export interface QuantizeOptions {
  mode: PaletteMode;
  /** Number of colours for adaptive mode (<= 256). */
  colours: number;
  /** Squared RGB distance below which the previous index is kept (0 disables). */
  hysteresis: number;
  dither: boolean;
  /** Rebuild adaptive palette every N frames. */
  adaptiveInterval: number;
  /** Input rows are bottom-up (WebGL readPixels). */
  flipY: boolean;
}

export const DEFAULT_QUANTIZE: QuantizeOptions = {
  mode: "adaptive",
  colours: 192,
  hysteresis: 140,
  dither: false,
  adaptiveInterval: 20,
  flipY: false,
};

/** 6 levels R x 7 levels G x 6 levels B = 252, plus 4 extra greys. */
export function fixedPalette256(): Palette {
  const p = new Uint32Array(256);
  let i = 0;
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 7; g++)
      for (let b = 0; b < 6; b++) p[i++] = (Math.round((r * 255) / 5) << 16) | (Math.round((g * 255) / 6) << 8) | Math.round((b * 255) / 5);
  for (const v of [32, 96, 160, 224]) p[i++] = (v << 16) | (v << 8) | v;
  return p;
}

/** 4x4x4 cube: 64 colours, fits comfortably in Excel conditional formatting rule budgets. */
export function fixedPalette64(): Palette {
  const p = new Uint32Array(64);
  let i = 0;
  for (let r = 0; r < 4; r++) for (let g = 0; g < 4; g++) for (let b = 0; b < 4; b++) p[i++] = ((r * 85) << 16) | ((g * 85) << 8) | (b * 85);
  return p;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v / 16 - 0.5) * 24);

export class Quantizer {
  palette: Palette;
  paletteVersion = 0;
  /** 15-bit colour -> palette index; 0xFFFF = not computed yet (filled lazily). */
  private lut = new Uint16Array(32768);
  lutMisses = 0;
  private pr = new Int32Array(256);
  private pg = new Int32Array(256);
  private pb = new Int32Array(256);
  private frameNo = 0;
  private prevIdx: Uint8Array | null = null;
  lastPaletteBuildMs = 0;

  constructor(public opts: QuantizeOptions = { ...DEFAULT_QUANTIZE }) {
    this.palette = opts.mode === "fixed64" ? fixedPalette64() : fixedPalette256();
    this.rebuildLut();
  }

  setOptions(o: Partial<QuantizeOptions>): void {
    const modeChanged = o.mode !== undefined && o.mode !== this.opts.mode;
    this.opts = { ...this.opts, ...o };
    if (modeChanged) {
      this.palette = this.opts.mode === "fixed64" ? fixedPalette64() : fixedPalette256();
      this.paletteVersion++;
      this.rebuildLut();
      this.prevIdx = null;
    }
  }

  reset(): void {
    this.prevIdx = null;
    this.frameNo = 0;
  }

  private rebuildLut(): void {
    const t0 = performance.now();
    const n = this.palette.length;
    for (let i = 0; i < n; i++) {
      const c = this.palette[i];
      this.pr[i] = (c >> 16) & 255;
      this.pg[i] = (c >> 8) & 255;
      this.pb[i] = c & 255;
    }
    // Slots beyond the palette can never satisfy hysteresis (indices from an older, larger palette).
    for (let i = n; i < 256; i++) this.pr[i] = this.pg[i] = this.pb[i] = -100000;
    // Lazy LUT: entries are computed the first time a colour bucket is seen (a frame uses a few
    // thousand of the 32768 buckets), instead of 32768 x palette distance tests up front.
    this.lut.fill(0xffff);
    this.lastPaletteBuildMs = performance.now() - t0;
  }

  private nearest(k: number): number {
    const r = ((k >> 10) << 3) | 4, g = (((k >> 5) & 31) << 3) | 4, b = ((k & 31) << 3) | 4;
    const pr = this.pr, pg = this.pg, pb = this.pb, n = this.palette.length;
    let best = 0, bd = 1e9;
    for (let i = 0; i < n; i++) {
      const dr = r - pr[i], dg = g - pg[i], db = b - pb[i];
      // weighted distance, roughly perceptual
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    this.lut[k] = best;
    this.lutMisses++;
    return best;
  }

  /** Median-cut on a 15-bit histogram, then re-order to match previous slots. */
  private buildAdaptive(src: Uint8Array | Uint8ClampedArray, cells: number): void {
    const hist = new Uint32Array(32768);
    const step = Math.max(1, Math.floor(cells / 20000));
    for (let i = 0; i < cells; i += step) {
      const o = i * 4;
      hist[((src[o] >> 3) << 10) | ((src[o + 1] >> 3) << 5) | (src[o + 2] >> 3)]++;
    }
    const keys: number[] = [];
    for (let k = 0; k < 32768; k++) if (hist[k]) keys.push(k);
    type Box = { keys: number[] };
    const boxes: Box[] = [{ keys }];
    const target = Math.min(256, Math.max(8, this.opts.colours));
    const ch = (k: number, c: number) => (c === 0 ? k >> 10 : c === 1 ? (k >> 5) & 31 : k & 31);
    while (boxes.length < target) {
      // split box with greatest (range * population)
      let bi = -1, bestScore = -1, bestC = 0;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.keys.length < 2) continue;
        let pop = 0;
        const lo = [31, 31, 31], hi = [0, 0, 0];
        for (const k of b.keys) {
          pop += hist[k];
          for (let c = 0; c < 3; c++) {
            const v = ch(k, c);
            if (v < lo[c]) lo[c] = v;
            if (v > hi[c]) hi[c] = v;
          }
        }
        for (let c = 0; c < 3; c++) {
          const s = (hi[c] - lo[c]) * Math.sqrt(pop);
          if (s > bestScore) {
            bestScore = s;
            bi = i;
            bestC = c;
          }
        }
      }
      if (bi < 0 || bestScore <= 0) break;
      const b = boxes[bi];
      b.keys.sort((x, y) => ch(x, bestC) - ch(y, bestC));
      let total = 0;
      for (const k of b.keys) total += hist[k];
      let acc = 0, cut = 1;
      for (let i = 0; i < b.keys.length; i++) {
        acc += hist[b.keys[i]];
        if (acc >= total / 2) {
          cut = Math.max(1, Math.min(b.keys.length - 1, i + 1));
          break;
        }
      }
      boxes.splice(bi, 1, { keys: b.keys.slice(0, cut) }, { keys: b.keys.slice(cut) });
    }
    const cols: number[] = boxes.map((b) => {
      let r = 0, g = 0, bl = 0, w = 0;
      for (const k of b.keys) {
        const h = hist[k];
        r += ((k >> 10) * 8 + 4) * h;
        g += (((k >> 5) & 31) * 8 + 4) * h;
        bl += ((k & 31) * 8 + 4) * h;
        w += h;
      }
      return w ? (Math.round(r / w) << 16) | (Math.round(g / w) << 8) | Math.round(bl / w) : 0;
    });
    // Stable slot assignment: each old slot keeps its nearest new colour.
    const old = this.palette;
    const next = new Uint32Array(Math.max(cols.length, 1));
    const used = new Uint8Array(cols.length);
    const dist = (a: number, b: number) => {
      const dr = ((a >> 16) & 255) - ((b >> 16) & 255), dg = ((a >> 8) & 255) - ((b >> 8) & 255), db = (a & 255) - (b & 255);
      return dr * dr + dg * dg + db * db;
    };
    const free: number[] = [];
    for (let s = 0; s < next.length; s++) {
      if (s >= old.length) {
        free.push(s);
        continue;
      }
      let bi = -1, bd = 1e9;
      for (let j = 0; j < cols.length; j++)
        if (!used[j]) {
          const d = dist(old[s], cols[j]);
          if (d < bd) {
            bd = d;
            bi = j;
          }
        }
      if (bi >= 0 && bd < 2500) {
        next[s] = cols[bi];
        used[bi] = 1;
      } else free.push(s);
    }
    let f = 0;
    for (let j = 0; j < cols.length; j++) if (!used[j]) next[free[f++]] = cols[j];
    this.palette = next;
    this.paletteVersion++;
    this.rebuildLut();
  }

  /**
   * Quantise into `out` (length w*h). Returns the indices array.
   * Hysteresis compares against the previous frame's indices.
   */
  quantize(src: Uint8Array | Uint8ClampedArray, w: number, h: number, out: Uint8Array): Uint8Array {
    const cells = w * h;
    if (this.opts.mode === "adaptive" && this.frameNo % this.opts.adaptiveInterval === 0) this.buildAdaptive(src, cells);
    this.frameNo++;
    const prev = this.prevIdx && this.prevIdx.length === cells ? this.prevIdx : null;
    const lut = this.lut, pr = this.pr, pg = this.pg, pb = this.pb;
    const hyst = this.opts.hysteresis;
    const dither = this.opts.dither;
    const flip = this.opts.flipY;
    for (let y = 0; y < h; y++) {
      const sy = flip ? h - 1 - y : y;
      let o = sy * w * 4;
      let d = y * w;
      for (let x = 0; x < w; x++, o += 4, d++) {
        let r = src[o], g = src[o + 1], b = src[o + 2];
        if (dither) {
          const t = BAYER4[((y & 3) << 2) | (x & 3)];
          r = r + t < 0 ? 0 : r + t > 255 ? 255 : (r + t) | 0;
          g = g + t < 0 ? 0 : g + t > 255 ? 255 : (g + t) | 0;
          b = b + t < 0 ? 0 : b + t > 255 ? 255 : (b + t) | 0;
        }
        if (prev !== null && hyst > 0) {
          const pi = prev[d];
          const dr = r - pr[pi], dg = g - pg[pi], db = b - pb[pi];
          if (dr * dr + dg * dg + db * db <= hyst) {
            out[d] = pi;
            continue;
          }
        }
        const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const e = lut[k];
        out[d] = e !== 0xffff ? e : this.nearest(k);
      }
    }
    if (!this.prevIdx || this.prevIdx.length !== cells) this.prevIdx = new Uint8Array(cells);
    this.prevIdx.set(out);
    return out;
  }

  /** Mean squared error of indices vs source (quality metric for evals). */
  static mse(src: Uint8Array | Uint8ClampedArray, idx: Uint8Array, pal: Palette, flipY = false, w = 0, h = 0): number {
    let e = 0;
    const n = idx.length;
    for (let i = 0; i < n; i++) {
      let o = i * 4;
      if (flipY && w) {
        const y = Math.floor(i / w), x = i % w;
        o = ((h - 1 - y) * w + x) * 4;
      }
      const c = pal[idx[i]];
      const dr = src[o] - ((c >> 16) & 255), dg = src[o + 1] - ((c >> 8) & 255), db = src[o + 2] - (c & 255);
      e += (dr * dr + dg * dg + db * db) / 3;
    }
    return e / n;
  }
}
