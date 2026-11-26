/**
 * Surface: a DOM-free RGBA framebuffer (Uint8Array, 4 bytes per pixel, top row
 * first) with clipped integer drawing primitives. All coordinates are offset by
 * `origin` (use it as a camera) and clipped to `clip`.
 */
import { type Color, red, green, blue } from "./color";
import { type Sprite, TRANSPARENT } from "./sprite";

export interface BlitOptions {
  flipX?: boolean;
  flipY?: boolean;
  /** 0..1 global opacity. */
  alpha?: number;
  /** Blend every opaque pixel towards this colour by tintAmount. */
  tint?: Color;
  tintAmount?: number;
  /** Draw every opaque pixel in this colour (shadows, hit flashes). */
  silhouette?: Color;
}

export class Surface {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  ox = 0;
  oy = 0;
  private cx0 = 0;
  private cy0 = 0;
  private cx1: number;
  private cy1: number;

  constructor(width: number, height: number, data?: Uint8Array) {
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8Array(width * height * 4);
    if (this.data.length < width * height * 4) throw new Error("Surface buffer too small");
    this.cx1 = width;
    this.cy1 = height;
  }

  /** Translate subsequent drawing so that world (x, y) maps to pixel (x - ox, y - oy). */
  setOrigin(ox: number, oy: number): void {
    this.ox = Math.round(ox);
    this.oy = Math.round(oy);
  }
  resetOrigin(): void {
    this.ox = 0;
    this.oy = 0;
  }
  /** Clip rectangle in pixel (not world) coordinates. */
  setClip(x: number, y: number, w: number, h: number): void {
    this.cx0 = Math.max(0, x | 0);
    this.cy0 = Math.max(0, y | 0);
    this.cx1 = Math.min(this.width, (x + w) | 0);
    this.cy1 = Math.min(this.height, (y + h) | 0);
  }
  resetClip(): void {
    this.cx0 = 0;
    this.cy0 = 0;
    this.cx1 = this.width;
    this.cy1 = this.height;
  }

  clear(c: Color): void {
    const r = red(c), g = green(c), b = blue(c);
    const d = this.data;
    for (let i = 0; i < this.width * this.height * 4; i += 4) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }

  /** Plot one pixel (world coordinates). */
  pset(x: number, y: number, c: Color, a = 1): void {
    const px = Math.floor(x) - this.ox;
    const py = Math.floor(y) - this.oy;
    if (px < this.cx0 || py < this.cy0 || px >= this.cx1 || py >= this.cy1) return;
    this.putRaw(px, py, c, a);
  }

  /** Plot in pixel coordinates without origin/clip checks beyond bounds. */
  private putRaw(px: number, py: number, c: Color, a: number): void {
    const i = (py * this.width + px) * 4;
    const d = this.data;
    if (a >= 1) {
      d[i] = (c >>> 16) & 255;
      d[i + 1] = (c >>> 8) & 255;
      d[i + 2] = c & 255;
    } else if (a > 0) {
      d[i] += (((c >>> 16) & 255) - d[i]) * a;
      d[i + 1] += (((c >>> 8) & 255) - d[i + 1]) * a;
      d[i + 2] += ((c & 255) - d[i + 2]) * a;
    }
    d[i + 3] = 255;
  }

  /** Colour at world (x, y), or -1 outside. */
  get(x: number, y: number): number {
    const px = Math.floor(x) - this.ox;
    const py = Math.floor(y) - this.oy;
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return -1;
    const i = (py * this.width + px) * 4;
    return (this.data[i] << 16) | (this.data[i + 1] << 8) | this.data[i + 2];
  }

  fillRect(x: number, y: number, w: number, h: number, c: Color, a = 1): void {
    const x0 = Math.max(this.cx0, Math.floor(x) - this.ox);
    const y0 = Math.max(this.cy0, Math.floor(y) - this.oy);
    const x1 = Math.min(this.cx1, Math.floor(x) - this.ox + Math.floor(w));
    const y1 = Math.min(this.cy1, Math.floor(y) - this.oy + Math.floor(h));
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) this.putRaw(px, py, c, a);
  }

  /** 1px outline rectangle. */
  rect(x: number, y: number, w: number, h: number, c: Color, a = 1): void {
    if (w <= 0 || h <= 0) return;
    this.hline(x, x + w - 1, y, c, a);
    if (h > 1) this.hline(x, x + w - 1, y + h - 1, c, a);
    if (h > 2) {
      this.vline(x, y + 1, y + h - 2, c, a);
      if (w > 1) this.vline(x + w - 1, y + 1, y + h - 2, c, a);
    }
  }

  hline(x0: number, x1: number, y: number, c: Color, a = 1): void {
    if (x1 < x0) [x0, x1] = [x1, x0];
    this.fillRect(x0, y, Math.floor(x1) - Math.floor(x0) + 1, 1, c, a);
  }

  vline(x: number, y0: number, y1: number, c: Color, a = 1): void {
    if (y1 < y0) [y0, y1] = [y1, y0];
    this.fillRect(x, y0, 1, Math.floor(y1) - Math.floor(y0) + 1, c, a);
  }

  /** Bresenham line, inclusive endpoints. */
  line(x0: number, y0: number, x1: number, y1: number, c: Color, a = 1): void {
    x0 = Math.floor(x0);
    y0 = Math.floor(y0);
    x1 = Math.floor(x1);
    y1 = Math.floor(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 4096; guard++) {
      this.pset(x0, y0, c, a);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /** Midpoint circle outline. */
  circle(cx: number, cy: number, r: number, c: Color, a = 1): void {
    cx = Math.floor(cx);
    cy = Math.floor(cy);
    r = Math.floor(r);
    if (r <= 0) return this.pset(cx, cy, c, a);
    let x = r;
    let y = 0;
    let err = 1 - r;
    const seen = new Set<number>();
    const plot = (px: number, py: number) => {
      const k = (py + 4096) * 8192 + (px + 4096);
      if (seen.has(k)) return;
      seen.add(k);
      this.pset(px, py, c, a);
    };
    while (x >= y) {
      plot(cx + x, cy + y);
      plot(cx + y, cy + x);
      plot(cx - y, cy + x);
      plot(cx - x, cy + y);
      plot(cx - x, cy - y);
      plot(cx - y, cy - x);
      plot(cx + y, cy - x);
      plot(cx + x, cy - y);
      y++;
      if (err < 0) err += 2 * y + 1;
      else {
        x--;
        err += 2 * (y - x) + 1;
      }
    }
  }

  fillCircle(cx: number, cy: number, r: number, c: Color, a = 1): void {
    this.fillEllipse(cx, cy, r, r, c, a);
  }

  /** Filled ellipse centred on (cx, cy); radii may be fractional for nicer small shapes. */
  fillEllipse(cx: number, cy: number, rx: number, ry: number, c: Color, a = 1): void {
    if (rx <= 0 || ry <= 0) return;
    const y0 = Math.floor(cy - ry);
    const y1 = Math.ceil(cy + ry);
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - cy) / ry;
      if (dy * dy > 1) continue;
      const half = rx * Math.sqrt(1 - dy * dy);
      const xa = Math.round(cx - half);
      const xb = Math.round(cx + half);
      if (xb > xa) this.fillRect(xa, y, xb - xa, 1, c, a);
    }
  }

  /** Draw a sprite with its top-left at (x, y). */
  blit(s: Sprite, x: number, y: number, o: BlitOptions = {}): void {
    const bx = Math.floor(x) - this.ox;
    const by = Math.floor(y) - this.oy;
    const a = o.alpha ?? 1;
    const ta = o.tint !== undefined ? (o.tintAmount ?? 0.5) : 0;
    const tr = o.tint !== undefined ? red(o.tint) : 0;
    const tg = o.tint !== undefined ? green(o.tint) : 0;
    const tb = o.tint !== undefined ? blue(o.tint) : 0;
    const x0 = Math.max(this.cx0, bx);
    const y0 = Math.max(this.cy0, by);
    const x1 = Math.min(this.cx1, bx + s.w);
    const y1 = Math.min(this.cy1, by + s.h);
    for (let py = y0; py < y1; py++) {
      const sy = o.flipY ? s.h - 1 - (py - by) : py - by;
      for (let px = x0; px < x1; px++) {
        const sx = o.flipX ? s.w - 1 - (px - bx) : px - bx;
        let c = s.px[sy * s.w + sx];
        if (c === TRANSPARENT) continue;
        if (o.silhouette !== undefined) c = o.silhouette;
        else if (ta > 0) {
          const r = (c >>> 16) & 255, g = (c >>> 8) & 255, b = c & 255;
          c = (Math.round(r + (tr - r) * ta) << 16) | (Math.round(g + (tg - g) * ta) << 8) | Math.round(b + (tb - b) * ta);
        }
        this.putRaw(px, py, c, a);
      }
    }
  }

  /** Draw a sprite so that its anchor (default bottom-centre) lands on (x, y). */
  blitAnchored(s: Sprite, x: number, y: number, o: BlitOptions = {}): void {
    const ax = o.flipX ? s.w - s.ax : s.ax;
    this.blit(s, Math.floor(x) - ax, Math.floor(y) - s.ay, o);
  }

  /** Copy a region of another surface (opaque copy, ignores src origin). */
  drawSurface(src: Surface, dx: number, dy: number, sx = 0, sy = 0, sw = src.width, sh = src.height): void {
    const bx = Math.floor(dx) - this.ox;
    const by = Math.floor(dy) - this.oy;
    const x0 = Math.max(this.cx0, bx, bx - sx);
    const y0 = Math.max(this.cy0, by, by - sy);
    const x1 = Math.min(this.cx1, bx + sw, bx - sx + src.width);
    const y1 = Math.min(this.cy1, by + sh, by - sy + src.height);
    if (x1 <= x0) return;
    for (let py = y0; py < y1; py++) {
      const srow = (py - by + sy) * src.width;
      const so = (srow + (x0 - bx + sx)) * 4;
      const dOff = (py * this.width + x0) * 4;
      this.data.set(src.data.subarray(so, so + (x1 - x0) * 4), dOff);
    }
  }

  /** Apply fn to every pixel inside the clip rect: fn(r, g, b, px, py) -> 0xRRGGBB. */
  mapPixels(fn: (r: number, g: number, b: number, px: number, py: number) => number): void {
    const d = this.data;
    for (let py = this.cy0; py < this.cy1; py++)
      for (let px = this.cx0; px < this.cx1; px++) {
        const i = (py * this.width + px) * 4;
        const c = fn(d[i], d[i + 1], d[i + 2], px, py);
        d[i] = (c >>> 16) & 255;
        d[i + 1] = (c >>> 8) & 255;
        d[i + 2] = c & 255;
      }
  }

  /** Count distinct colours (diagnostics / tests). */
  distinctColors(): number {
    const s = new Set<number>();
    const d = this.data;
    for (let i = 0; i < this.width * this.height * 4; i += 4) s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return s.size;
  }
}
