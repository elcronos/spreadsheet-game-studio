/**
 * GridView: a canvas-backed virtual spreadsheet grid.
 *
 * Draws only visible cells. Works for ordinary table sheets (variable sheets,
 * rules, telemetry) and for the GAME sheet, whose frame range is a block of
 * uniform cells whose fills come from the CellStore (one palette index per
 * cell). Selection, the name box and the formula bar read the same store.
 */
import { columnName } from "../../engines/core/frame";

export interface CellView {
  text?: string;
  fill?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "right" | "center";
  editable?: boolean;
  /** Small coloured marker in the corner (e.g. validation error). */
  flag?: string;
}

export interface Merge {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface FrameRegion {
  /** Top-left cell of the frame range (0-based). */
  row: number;
  col: number;
  width: number;
  height: number;
  /** Cell bitmap: one canvas pixel per cell (the cell store's fills). */
  bitmap: HTMLCanvasElement | OffscreenCanvas;
  /** Draw each cell with fillRect from the store instead of blitting the bitmap. */
  drawMode: "blit" | "rects";
  cellFill: (x: number, y: number) => number;
}

export interface SheetModel {
  name: string;
  rows(): number;
  cols(): number;
  colWidth(c: number): number;
  rowHeight(r: number): number;
  /** Rows with a fixed on-screen height in CSS px that ignores zoom (e.g. HUD rows). */
  fixedRowPx?(r: number): number | undefined;
  cell(r: number, c: number): CellView | null;
  merges?(): Merge[];
  /** Text for the formula bar. */
  raw?(r: number, c: number): string;
  /** Commit an edit; return an error message or null. */
  edit?(r: number, c: number, text: string): string | null;
  frame?: FrameRegion;
  /** Number of header rows to keep frozen at the top. */
  frozenRows?: number;
  /** Extra line for the status bar about the selected cell. */
  describe?(r: number, c: number): string;
}

const HEADER_W = 46;
const HEADER_H = 22;

export class GridView {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  model: SheetModel;
  zoom = 1;
  scrollX = 0;
  scrollY = 0;
  gridlines = true;
  /** Gridlines over the GAME frame range (separately toggleable). */
  frameGridlines = false;
  /** 0..1 fraction of frame columns drawn (intro reveal). */
  reveal = 1;
  sel = { r: 0, c: 0 };
  private colX: number[] = [];
  private rowY: number[] = [];
  private dpr = 1;
  private w = 0;
  private h = 0;
  onSelect: (r: number, c: number) => void = () => {};
  onEditRequest: (r: number, c: number, initial?: string) => void = () => {};
  lastDrawMs = 0;

  constructor(parent: HTMLElement, model: SheetModel) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cf-grid";
    this.canvas.tabIndex = 0;
    parent.appendChild(this.canvas);
    this.g = this.canvas.getContext("2d", { alpha: false })!;
    this.model = model;
    this.layout();
    this.canvas.addEventListener("pointerdown", (e) => {
      const hit = this.hit(e.offsetX, e.offsetY);
      if (hit) this.select(hit.r, hit.c);
      this.canvas.focus();
    });
    this.canvas.addEventListener("dblclick", (e) => {
      const hit = this.hit(e.offsetX, e.offsetY);
      if (hit) this.onEditRequest(hit.r, hit.c);
    });
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          this.setZoom(this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.offsetX, e.offsetY);
        } else {
          this.scrollX += e.shiftKey ? e.deltaY : e.deltaX;
          this.scrollY += e.shiftKey ? 0 : e.deltaY;
          this.clampScroll();
        }
        this.draw();
      },
      { passive: false },
    );
    // touch pan / pinch
    let touches = new Map<number, { x: number; y: number }>();
    let pinch0 = 0, zoom0 = 1;
    this.canvas.addEventListener("touchstart", (e) => {
      for (const t of Array.from(e.changedTouches)) touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
        zoom0 = this.zoom;
      }
    }, { passive: true });
    this.canvas.addEventListener("touchmove", (e) => {
      if (touches.size === 2 && e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        this.setZoom(zoom0 * (d / pinch0));
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        const p = touches.get(t.identifier);
        if (p) {
          this.scrollX -= t.clientX - p.x;
          this.scrollY -= t.clientY - p.y;
          this.clampScroll();
        }
        touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
      this.draw();
    }, { passive: true });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) touches.delete(t.identifier);
    };
    this.canvas.addEventListener("touchend", end);
    this.canvas.addEventListener("touchcancel", end);
    new ResizeObserver(() => {
      this.resize();
      this.draw();
    }).observe(parent);
    this.resize();
  }

  setModel(m: SheetModel): void {
    this.model = m;
    this.scrollX = this.scrollY = 0;
    this.sel = { r: Math.min(this.sel.r, m.rows() - 1), c: Math.min(this.sel.c, m.cols() - 1) };
    this.layout();
    this.draw();
  }

  /** Recompute column/row offsets (call after zoom or model size change). */
  layout(): void {
    const m = this.model;
    const nc = m.cols(), nr = m.rows();
    this.colX = new Array(nc + 1);
    this.rowY = new Array(nr + 1);
    this.colX[0] = 0;
    for (let c = 0; c < nc; c++) this.colX[c + 1] = this.colX[c] + m.colWidth(c) * this.zoom;
    this.rowY[0] = 0;
    for (let r = 0; r < nr; r++) this.rowY[r + 1] = this.rowY[r] + (m.fixedRowPx?.(r) ?? m.rowHeight(r) * this.zoom);
  }

  resize(): void {
    const p = this.canvas.parentElement!;
    this.dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    this.w = p.clientWidth;
    this.h = p.clientHeight;
    this.canvas.width = Math.max(1, Math.round(this.w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.h * this.dpr));
    this.canvas.style.width = this.w + "px";
    this.canvas.style.height = this.h + "px";
    this.clampScroll();
  }

  setZoom(z: number, ax = this.w / 2, ay = this.h / 2): void {
    z = Math.max(0.15, Math.min(12, z));
    const cx = (this.scrollX + ax - HEADER_W) / this.zoom, cy = (this.scrollY + ay - HEADER_H) / this.zoom;
    this.zoom = z;
    this.layout();
    this.scrollX = cx * z - (ax - HEADER_W);
    this.scrollY = cy * z - (ay - HEADER_H);
    this.clampScroll();
  }

  /** Zoom so the frame region fits the viewport. */
  fitFrame(): void {
    const f = this.model.frame;
    if (!f) return;
    this.zoom = 1;
    this.layout();
    const fw = this.colX[f.col + f.width] - this.colX[f.col];
    const fh = this.rowY[f.row + f.height] - this.rowY[f.row];
    const top = this.rowY[f.row];
    const z = Math.min((this.w - HEADER_W - 4) / fw, (this.h - HEADER_H - 4 - top) / fh);
    this.zoom = Math.max(0.15, z);
    this.layout();
    this.scrollX = 0;
    this.scrollY = 0;
    this.clampScroll();
  }

  private clampScroll(): void {
    const maxX = Math.max(0, (this.colX[this.colX.length - 1] ?? 0) - (this.w - HEADER_W) + 40);
    const maxY = Math.max(0, (this.rowY[this.rowY.length - 1] ?? 0) - (this.h - HEADER_H) + 40);
    this.scrollX = Math.max(0, Math.min(maxX, this.scrollX));
    this.scrollY = Math.max(0, Math.min(maxY, this.scrollY));
  }

  private find(arr: number[], v: number): number {
    let lo = 0, hi = arr.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid] <= v) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  hit(px: number, py: number): { r: number; c: number } | null {
    if (px < HEADER_W || py < HEADER_H) return null;
    const x = px - HEADER_W + this.scrollX;
    const fr = this.model.frozenRows ?? 0;
    const frozenH = this.rowY[fr];
    const y = py - HEADER_H < frozenH ? py - HEADER_H : py - HEADER_H + this.scrollY;
    const c = this.find(this.colX, x), r = this.find(this.rowY, y);
    if (c >= this.model.cols() || r >= this.model.rows()) return null;
    return { r, c };
  }

  select(r: number, c: number): void {
    this.sel = { r: Math.max(0, Math.min(this.model.rows() - 1, r)), c: Math.max(0, Math.min(this.model.cols() - 1, c)) };
    this.ensureVisible();
    this.onSelect(this.sel.r, this.sel.c);
    this.draw();
  }

  private ensureVisible(): void {
    const { r, c } = this.sel;
    const x0 = this.colX[c], x1 = this.colX[c + 1], y0 = this.rowY[r], y1 = this.rowY[r + 1];
    const vw = this.w - HEADER_W, vh = this.h - HEADER_H;
    if (x0 < this.scrollX) this.scrollX = x0;
    if (x1 > this.scrollX + vw) this.scrollX = x1 - vw;
    if (r >= (this.model.frozenRows ?? 0)) {
      if (y0 < this.scrollY + this.rowY[this.model.frozenRows ?? 0]) this.scrollY = y0 - this.rowY[this.model.frozenRows ?? 0];
      if (y1 > this.scrollY + vh) this.scrollY = y1 - vh;
    }
    this.clampScroll();
  }

  /** Screen rectangle of a cell (CSS px) for editor overlays. */
  cellRect(r: number, c: number): { x: number; y: number; w: number; h: number } {
    const fr = this.model.frozenRows ?? 0;
    const y = r < fr ? this.rowY[r] : this.rowY[r] - this.scrollY;
    return { x: HEADER_W + this.colX[c] - this.scrollX, y: HEADER_H + y, w: this.colX[c + 1] - this.colX[c], h: this.rowY[r + 1] - this.rowY[r] };
  }

  draw(): void {
    const t0 = performance.now();
    const g = this.g, m = this.model, dpr = this.dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, this.w, this.h);
    const nr = m.rows(), nc = m.cols();
    const vw = this.w - HEADER_W, vh = this.h - HEADER_H;
    const c0 = this.find(this.colX, this.scrollX), c1 = Math.min(nc - 1, this.find(this.colX, this.scrollX + vw));
    const fr = m.frozenRows ?? 0;
    const frozenH = this.rowY[fr];
    const r0 = Math.max(fr, this.find(this.rowY, this.scrollY + frozenH)), r1 = Math.min(nr - 1, this.find(this.rowY, this.scrollY + vh));
    const X = (c: number) => HEADER_W + this.colX[c] - this.scrollX;
    const Y = (r: number) => HEADER_H + (r < fr ? this.rowY[r] : this.rowY[r] - this.scrollY);
    const f = m.frame;
    const inFrame = (r: number, c: number) => !!f && r >= f.row && r < f.row + f.height && c >= f.col && c < f.col + f.width;

    // frame region
    g.save();
    g.beginPath();
    g.rect(HEADER_W, HEADER_H + frozenH, vw, vh - frozenH);
    g.clip();
    if (f) {
      const fx0 = X(f.col), fy0 = Y(f.row);
      const cw = this.colX[f.col + 1] - this.colX[f.col];
      const ch = this.rowY[f.row + 1] - this.rowY[f.row];
      if (f.drawMode === "blit" || cw < 1.5) {
        g.imageSmoothingEnabled = false;
        // crop to the visible cells so huge zooms stay cheap
        const vx0 = Math.max(0, Math.floor((HEADER_W - fx0) / cw)), vy0 = Math.max(0, Math.floor((HEADER_H + frozenH - fy0) / ch));
        const vx1 = Math.min(Math.ceil(f.width * this.reveal), Math.ceil((this.w - fx0) / cw)), vy1 = Math.min(f.height, Math.ceil((this.h - fy0) / ch));
        if (vx1 > vx0 && vy1 > vy0) g.drawImage(f.bitmap as CanvasImageSource, vx0, vy0, vx1 - vx0, vy1 - vy0, fx0 + vx0 * cw, fy0 + vy0 * ch, (vx1 - vx0) * cw, (vy1 - vy0) * ch);
      } else {
        const vx0 = Math.max(0, Math.floor((HEADER_W - fx0) / cw)), vy0 = Math.max(0, Math.floor((HEADER_H + frozenH - fy0) / ch));
        const vx1 = Math.min(Math.ceil(f.width * this.reveal), Math.ceil((this.w - fx0) / cw)), vy1 = Math.min(f.height, Math.ceil((this.h - fy0) / ch));
        for (let y = vy0; y < vy1; y++) {
          let x = vx0;
          while (x < vx1) {
            const col = f.cellFill(x, y);
            let x2 = x + 1;
            while (x2 < vx1 && f.cellFill(x2, y) === col) x2++;
            g.fillStyle = "#" + col.toString(16).padStart(6, "0");
            g.fillRect(fx0 + x * cw, fy0 + y * ch, (x2 - x) * cw + 0.5, ch + 0.5);
            x = x2;
          }
        }
      }
      if (this.frameGridlines && cw >= 3) {
        g.strokeStyle = cw >= 10 ? "rgba(0,0,0,0.28)" : "rgba(0,0,0,0.18)";
        g.lineWidth = 1 / dpr;
        g.beginPath();
        const vx0 = Math.max(0, Math.floor((HEADER_W - fx0) / cw)), vx1 = Math.min(f.width, Math.ceil((this.w - fx0) / cw));
        const vy0 = Math.max(0, Math.floor((HEADER_H - fy0) / ch)), vy1 = Math.min(f.height, Math.ceil((this.h - fy0) / ch));
        for (let x = vx0; x <= vx1; x++) {
          const px = Math.round((fx0 + x * cw) * dpr) / dpr + 0.5 / dpr;
          g.moveTo(px, fy0 + vy0 * ch);
          g.lineTo(px, fy0 + vy1 * ch);
        }
        for (let y = vy0; y <= vy1; y++) {
          const py = Math.round((fy0 + y * ch) * dpr) / dpr + 0.5 / dpr;
          g.moveTo(fx0 + vx0 * cw, py);
          g.lineTo(fx0 + vx1 * cw, py);
        }
        g.stroke();
      }
    }
    g.restore();

    // ordinary cells (frozen rows first, then scrolled rows)
    const merges = m.merges?.() ?? [];
    const covered = (r: number, c: number) => merges.find((mm) => r >= mm.r0 && r <= mm.r1 && c >= mm.c0 && c <= mm.c1);
    const drawRows = (ra: number, rb: number) => {
      g.font = `${Math.max(9, Math.round(12.5 * Math.min(1.6, Math.max(0.8, this.zoom))))}px "Segoe UI", system-ui, sans-serif`;
      g.textBaseline = "middle";
      for (let r = ra; r <= rb; r++) {
        const y = Y(r), h = this.rowY[r + 1] - this.rowY[r];
        for (let c = c0; c <= c1; c++) {
          if (inFrame(r, c)) continue;
          const mg = covered(r, c);
          if (mg && (mg.r0 !== r || mg.c0 !== c)) {
            if (!(c === c0 && mg.c0 < c0 && mg.r0 === r)) continue;
          }
          const cell = m.cell(mg ? mg.r0 : r, mg ? mg.c0 : c);
          const x = X(mg ? mg.c0 : c);
          const w = mg ? this.colX[mg.c1 + 1] - this.colX[mg.c0] : this.colX[c + 1] - this.colX[c];
          const hh = mg ? this.rowY[mg.r1 + 1] - this.rowY[mg.r0] : h;
          if (cell?.fill) {
            g.fillStyle = cell.fill;
            g.fillRect(x, y, w, hh);
          }
          if (this.gridlines && !mg) {
            g.strokeStyle = "#e2e2e2";
            g.lineWidth = 1;
            g.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, w, h);
          }
          if (cell?.text && w > 6 && hh > 6) {
            g.save();
            g.beginPath();
            g.rect(x + 1, y, w - 2, hh);
            g.clip();
            g.fillStyle = cell.color ?? "#1f2328";
            g.font = `${cell.italic ? "italic " : ""}${cell.bold ? "600 " : ""}${Math.max(9, Math.round(12.5 * Math.min(1.6, Math.max(0.8, this.zoom))))}px "Segoe UI", system-ui, sans-serif`;
            const al = cell.align ?? "left";
            g.textAlign = al;
            const tx = al === "left" ? x + 5 : al === "right" ? x + w - 5 : x + w / 2;
            g.fillText(cell.text, tx, y + hh / 2 + 0.5);
            g.restore();
          }
          if (cell?.flag) {
            g.fillStyle = cell.flag;
            g.beginPath();
            g.moveTo(x + w - 7, y);
            g.lineTo(x + w, y);
            g.lineTo(x + w, y + 7);
            g.fill();
          }
        }
      }
    };
    g.save();
    g.beginPath();
    g.rect(HEADER_W, HEADER_H + frozenH, vw, vh);
    g.clip();
    if (r0 <= r1) drawRows(r0, r1);
    g.restore();
    if (fr > 0) {
      g.save();
      g.beginPath();
      g.rect(HEADER_W, HEADER_H, vw, frozenH);
      g.clip();
      g.fillStyle = "#ffffff";
      g.fillRect(HEADER_W, HEADER_H, vw, frozenH);
      drawRows(0, fr - 1);
      g.strokeStyle = "#b8bcc4";
      g.beginPath();
      g.moveTo(HEADER_W, HEADER_H + frozenH - 0.5);
      g.lineTo(this.w, HEADER_H + frozenH - 0.5);
      g.stroke();
      g.restore();
    }

    // headers
    g.fillStyle = "#f4f5f7";
    g.fillRect(0, 0, this.w, HEADER_H);
    g.fillRect(0, 0, HEADER_W, this.h);
    g.strokeStyle = "#d4d7dd";
    g.lineWidth = 1;
    g.font = `11px "Segoe UI", system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    let lastLabel = -1e9;
    // the selected column's label always shows; others are skipped if they would collide with it or each other
    const selX = X(this.sel.c), selW = g.measureText(columnName(this.sel.c)).width + 8;
    for (let c = c0; c <= c1; c++) {
      const x = X(c), w = this.colX[c + 1] - this.colX[c];
      const selected = c === this.sel.c;
      if (selected) {
        g.fillStyle = "#dfe3f5";
        g.fillRect(x, 0, w, HEADER_H);
      }
      if (w >= 4) {
        g.beginPath();
        g.moveTo(Math.round(x + w) + 0.5, 0);
        g.lineTo(Math.round(x + w) + 0.5, HEADER_H);
        g.stroke();
      }
      const label = columnName(c);
      const lw = g.measureText(label).width + 8;
      const cx = x + w / 2;
      const clashSel = !selected && Math.abs(cx - (selX + (this.colX[this.sel.c + 1] - this.colX[this.sel.c]) / 2)) < (lw + selW) / 2;
      if (selected || (cx - lw / 2 >= lastLabel && !clashSel)) {
        g.fillStyle = selected ? "#283593" : "#5f6670";
        g.fillText(label, cx, HEADER_H / 2);
        lastLabel = cx + lw / 2;
      }
    }
    lastLabel = -1e9;
    const drawRowHdr = (r: number) => {
      const y = Y(r), h = this.rowY[r + 1] - this.rowY[r];
      const selected = r === this.sel.r;
      if (selected) {
        g.fillStyle = "#dfe3f5";
        g.fillRect(0, y, HEADER_W, h);
      }
      if (h >= 4) {
        g.beginPath();
        g.moveTo(0, Math.round(y + h) + 0.5);
        g.lineTo(HEADER_W, Math.round(y + h) + 0.5);
        g.stroke();
      }
      const cy = y + h / 2;
      const selY = Y(this.sel.r) + (this.rowY[this.sel.r + 1] - this.rowY[this.sel.r]) / 2;
      if (selected || (cy - 7 >= lastLabel && Math.abs(cy - selY) >= 14)) {
        g.fillStyle = selected ? "#283593" : "#5f6670";
        g.fillText(String(r + 1), HEADER_W / 2, cy);
        lastLabel = cy + 7;
      }
    };
    for (let r = 0; r < fr; r++) drawRowHdr(r);
    g.save();
    g.beginPath();
    g.rect(0, HEADER_H + frozenH, HEADER_W, vh);
    g.clip();
    for (let r = r0; r <= r1; r++) drawRowHdr(r);
    g.restore();
    g.fillStyle = "#e9ebef";
    g.fillRect(0, 0, HEADER_W, HEADER_H);
    g.beginPath();
    g.moveTo(HEADER_W - 0.5, 0);
    g.lineTo(HEADER_W - 0.5, this.h);
    g.moveTo(0, HEADER_H - 0.5);
    g.lineTo(this.w, HEADER_H - 0.5);
    g.stroke();

    // selection
    const { r, c } = this.sel;
    const mg = covered(r, c);
    const sr0 = mg ? mg.r0 : r, sc0 = mg ? mg.c0 : c, sr1 = mg ? mg.r1 : r, sc1 = mg ? mg.c1 : c;
    const sx = X(sc0), sy = Y(sr0), sw = this.colX[sc1 + 1] - this.colX[sc0], sh = this.rowY[sr1 + 1] - this.rowY[sr0];
    g.save();
    g.beginPath();
    g.rect(HEADER_W, HEADER_H, vw, vh);
    g.clip();
    g.strokeStyle = "#3949ab";
    g.lineWidth = 2;
    g.strokeRect(sx, sy, Math.max(3, sw), Math.max(3, sh));
    g.fillStyle = "#3949ab";
    g.fillRect(sx + Math.max(3, sw) - 3, sy + Math.max(3, sh) - 3, 6, 6);
    g.restore();
    this.lastDrawMs = performance.now() - t0;
  }
}
