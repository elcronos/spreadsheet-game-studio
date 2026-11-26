/**
 * SheetCanvasBackend: the browser spreadsheet renderer.
 *
 * Holds the GAME sheet's cell store: one palette index per cell (exactly the
 * value a native workbook would hold) plus the palette. Dirty runs from the
 * frame diff update the store and a 1-pixel-per-cell bitmap of its fills; the
 * GridView draws cells from that bitmap (or with fillRect per cell run).
 */
import type { BackendCapabilities, BackendInit, BackendStats, RenderBackend } from "../../engines/core/renderer";
import { RateCounter, Ema, emptyStats } from "../../engines/core/renderer";
import type { FrameDiff, IndexedFrame } from "../../engines/core/frame";
import type { StateSnapshot } from "../../engines/core/variables";

export class CellStore {
  width = 0;
  height = 0;
  indices = new Uint8Array(0);
  palette = new Uint32Array(256);
  paletteVersion = -1;
  frameId = 0;
  bitmap: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(w: number, h: number) {
    this.bitmap = document.createElement("canvas");
    this.ctx = this.bitmap.getContext("2d")!;
    this.image = new ImageData(1, 1);
    this.resize(w, h);
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.indices = new Uint8Array(w * h);
    this.bitmap.width = w;
    this.bitmap.height = h;
    this.image = this.ctx.createImageData(w, h);
    this.dirty = { x0: 0, y0: 0, x1: w, y1: h };
  }

  /** Write one cell (user edit): updates the value, the pixel buffer and the bitmap together. */
  setCell(x: number, y: number, v: number): void {
    const i = y * this.width + x;
    this.indices[i] = v;
    const c = this.palette[v], o = i * 4, px = this.image.data;
    px[o] = (c >> 16) & 255;
    px[o + 1] = (c >> 8) & 255;
    px[o + 2] = c & 255;
    px[o + 3] = 255;
    this.ctx.putImageData(this.image, 0, 0, x, y, 1, 1);
  }

  /** Fill colour (0xRRGGBB) of a cell. */
  fill(x: number, y: number): number {
    return this.palette[this.indices[y * this.width + x]] ?? 0;
  }

  value(x: number, y: number): number {
    return this.indices[y * this.width + x];
  }

  apply(frame: IndexedFrame, diff: FrameDiff): number {
    if (frame.width !== this.width || frame.height !== this.height) this.resize(frame.width, frame.height);
    const paletteChanged = frame.paletteVersion !== this.paletteVersion;
    let movedSlots: Uint8Array | null = null;
    if (paletteChanged) {
      // any slot whose colour changed at all must be repainted wherever it is used, even when
      // the cell's index did not change (the diff only carries cells whose index changed or whose
      // slot moved visibly) - otherwise drawn colours drift from the inspected value
      movedSlots = new Uint8Array(256);
      let any = false;
      for (let i = 0; i < frame.palette.length; i++)
        if (frame.palette[i] !== this.palette[i]) {
          movedSlots[i] = 1;
          any = true;
        }
      this.palette = frame.palette.slice();
      this.paletteVersion = frame.paletteVersion;
      if (!any) movedSlots = null;
    }
    this.frameId = frame.id;
    const w = this.width, src = frame.indices, dst = this.indices, px = this.image.data, pal = this.palette;
    let written = 0;
    for (const r of diff.runs) {
      const base = r.row * w;
      for (let x = r.x0; x < r.x0 + r.length; x++) {
        const i = base + x;
        const v = src[i];
        dst[i] = v;
        const c = pal[v];
        const o = i * 4;
        px[o] = (c >> 16) & 255;
        px[o + 1] = (c >> 8) & 255;
        px[o + 2] = c & 255;
        px[o + 3] = 255;
      }
      written += r.length;
    }
    if (movedSlots) {
      const n = this.indices.length;
      for (let i = 0; i < n; i++) {
        const v = dst[i];
        if (movedSlots[v]) {
          const c = pal[v], o = i * 4;
          px[o] = (c >> 16) & 255;
          px[o + 1] = (c >> 8) & 255;
          px[o + 2] = c & 255;
          px[o + 3] = 255;
        }
      }
      this.dirty = { x0: 0, y0: 0, x1: this.width, y1: this.height };
    }
    if (diff.bounds) {
      const b = diff.bounds;
      if (!this.dirty) this.dirty = { ...b };
      else this.dirty = { x0: Math.min(this.dirty.x0, b.x0), y0: Math.min(this.dirty.y0, b.y0), x1: Math.max(this.dirty.x1, b.x1), y1: Math.max(this.dirty.y1, b.y1) };
    }
    return written;
  }

  /** Push dirty pixels of the cell bitmap to its canvas. */
  flush(): void {
    const d = this.dirty;
    if (!d) return;
    this.ctx.putImageData(this.image, 0, 0, d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
    this.dirty = null;
  }
}

export class SheetCanvasBackend implements RenderBackend {
  readonly id = "sheet-canvas";
  readonly label = "Browser spreadsheet grid";
  readonly capabilities: BackendCapabilities = { cellFrames: true, directCanvas: false, measuredCellBudget: 0, input: true, stateEdit: true };
  readonly store: CellStore;
  private rate = new RateCounter();
  private ema = new Ema(0.15);
  private s: BackendStats = emptyStats();
  /** Called after a frame is applied so the view can redraw. */
  onPresent: () => void = () => {};
  onState: (s: StateSnapshot) => void = () => {};
  init!: (i: BackendInit) => Promise<void>;

  constructor(w: number, h: number) {
    this.store = new CellStore(w, h);
    this.init = async () => {};
  }

  resize(w: number, h: number): void {
    this.store.resize(w, h);
  }

  submitFrame(frame: IndexedFrame, diff: FrameDiff): boolean {
    const t0 = performance.now();
    const n = this.store.apply(frame, diff);
    this.store.flush();
    this.onPresent();
    this.rate.tick();
    this.s.lastChangedCells = n;
    this.s.presentMs = this.ema.push(performance.now() - t0);
    return true;
  }

  syncState(s: StateSnapshot): void {
    this.onState(s);
  }

  stats(): BackendStats {
    return { ...this.s, presentedFps: this.rate.rate };
  }

  async shutdown(): Promise<void> {}
}
