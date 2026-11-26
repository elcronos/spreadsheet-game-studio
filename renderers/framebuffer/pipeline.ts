/**
 * FramePipeline: RGBA framebuffer -> IndexedFrame + FrameDiff, with timings.
 * Owns double-buffered index arrays (no per-frame allocation).
 */
import type { FrameDiff, IndexedFrame } from "../../engines/core/frame";
import { Quantizer, QuantizeOptions, DEFAULT_QUANTIZE } from "./quantize";
import { diffFrames } from "./diff";

export interface PipelineTimings {
  quantizeMs: number;
  diffMs: number;
}

export class FramePipeline {
  readonly quantizer: Quantizer;
  private bufA: Uint8Array;
  private bufB: Uint8Array;
  private havePrev = false;
  private frameId = 0;
  private forceKey = true;
  private lastPaletteVersion = -1;
  mergeGap = 4;
  /** Per-slot colour at the time cells using it were last emitted. */
  private prevPalette: Uint32Array | null = null;
  private forceBaseline = true;
  /** Palette slots whose colour changed at the last rebuild. */
  paletteSlotsChanged = 0;
  timings: PipelineTimings = { quantizeMs: 0, diffMs: 0 };

  constructor(public width: number, public height: number, opts: Partial<QuantizeOptions> = {}) {
    this.quantizer = new Quantizer({ ...DEFAULT_QUANTIZE, ...opts });
    this.bufA = new Uint8Array(width * height);
    this.bufB = new Uint8Array(width * height);
  }

  resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.bufA = new Uint8Array(w * h);
    this.bufB = new Uint8Array(w * h);
    this.havePrev = false;
    this.forceKey = true;
    this.forceBaseline = true;
    this.quantizer.reset();
  }

  requestKeyframe(): void {
    this.forceKey = true;
    this.forceBaseline = true;
  }

  process(rgba: Uint8Array | Uint8ClampedArray): { frame: IndexedFrame; diff: FrameDiff } {
    const t0 = performance.now();
    const next = this.bufB;
    this.quantizer.quantize(rgba, this.width, this.height, next);
    const t1 = performance.now();
    const pal = this.quantizer.palette;
    let slotDirty: Uint8Array | null = null;
    if (this.quantizer.paletteVersion !== this.lastPaletteVersion && this.prevPalette) {
      // A rebuilt adaptive palette may move a slot's colour: cells using that slot must be rewritten
      // even when their index is unchanged. Each slot is compared with the colour it had when its
      // cells were last emitted (not just the previous palette), so small moves cannot accumulate.
      slotDirty = new Uint8Array(256);
      let any = false;
      for (let i = 0; i < pal.length; i++) {
        const a = pal[i], b = i < this.prevPalette.length ? this.prevPalette[i] : -1;
        if (b < 0) { slotDirty[i] = 1; any = true; continue; }
        const dr = ((a >> 16) & 255) - ((b >> 16) & 255), dg = ((a >> 8) & 255) - ((b >> 8) & 255), db = (a & 255) - (b & 255);
        // threshold 12 (squared): any cell is then within 2*sqrt(12) of its slot colour, i.e. squared drift <= 48
        if (dr * dr + dg * dg + db * db > 12) { slotDirty[i] = 1; any = true; this.prevPalette[i] = a; }
      }
      if (!any) slotDirty = null;
      this.paletteSlotsChanged = slotDirty ? slotDirty.reduce((s, v) => s + v, 0) : 0;
    }
    const diff = diffFrames(this.havePrev ? this.bufA : null, next, this.width, this.height, this.mergeGap, this.forceKey, slotDirty);
    if (!this.prevPalette || this.prevPalette.length !== pal.length || this.forceBaseline) {
      this.prevPalette = pal.slice();
      this.forceBaseline = false;
    }
    const t2 = performance.now();
    this.timings = { quantizeMs: t1 - t0, diffMs: t2 - t1 };
    this.lastPaletteVersion = this.quantizer.paletteVersion;
    this.forceKey = false;
    // swap
    this.bufB = this.bufA;
    this.bufA = next;
    this.havePrev = true;
    const frame: IndexedFrame = {
      id: ++this.frameId,
      width: this.width,
      height: this.height,
      indices: next,
      palette: this.quantizer.palette,
      paletteVersion: this.quantizer.paletteVersion,
    };
    return { frame, diff };
  }
}
