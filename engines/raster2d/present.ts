/**
 * Resolution independence. Games draw into a Surface at a fixed logical size;
 * present() maps it onto any target w×h:
 *
 *  - integer nearest-neighbour upscale when an integer factor fits well
 *    (160x90 -> 320x180 is exactly 2x, every logical pixel becomes a 2x2 block);
 *  - fractional nearest-neighbour when the best integer fit would waste too
 *    much of the target (e.g. 160x90 -> 240x135 = 1.5x);
 *  - area-averaged downscale below 1x (160x90 -> 80x45 averages 2x2 blocks,
 *    which keeps thin features visible instead of dropping every other row);
 *  - aspect is always preserved: "contain" letterboxes, "cover" crops centred.
 *
 * CanvasPresenter does the same for a conventional HTMLCanvasElement using
 * putImageData + drawImage with imageSmoothingEnabled = false. It is only
 * constructible where `document` exists; everything else here is DOM-free.
 */
import type { Color } from "./color";
import { Surface } from "./surface";

export type FitMode = "contain" | "cover";
export type ScaleMode = "auto" | "integer" | "fractional";

export interface PresentOptions {
  fit?: FitMode;
  scaling?: ScaleMode;
  /** Letterbox colour. */
  background?: Color;
  /** Downscale filter. */
  downsample?: "area" | "nearest";
  /** In auto mode, accept an integer upscale if it fills at least this fraction of the limiting axis. */
  minIntegerFill?: number;
}

export interface Fit {
  scale: number;
  /** Destination rectangle of the scaled image in target pixels (may exceed the target for cover). */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  integer: boolean;
}

export function computeFit(sw: number, sh: number, tw: number, th: number, o: PresentOptions = {}): Fit {
  const fit = o.fit ?? "contain";
  const raw = fit === "contain" ? Math.min(tw / sw, th / sh) : Math.max(tw / sw, th / sh);
  let scale = raw;
  let integer = false;
  if (raw >= 1) {
    const intScale = fit === "contain" ? Math.floor(raw) : Math.ceil(raw);
    const mode = o.scaling ?? "auto";
    const fill = intScale / raw;
    if (mode === "integer" || (mode === "auto" && (Math.abs(raw - intScale) < 1e-9 || (fit === "contain" && fill >= (o.minIntegerFill ?? 0.8))))) {
      scale = intScale;
      integer = true;
    }
  } else if (Number.isInteger(1 / raw)) integer = true;
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);
  return { scale, dx: Math.floor((tw - dw) / 2), dy: Math.floor((th - dh) / 2), dw, dh, integer };
}

/**
 * Scale `src` into `out` (tw*th*4 RGBA, top row first). Returns the fit used.
 */
export function present(src: Surface, tw: number, th: number, out: Uint8Array | Uint8ClampedArray, o: PresentOptions = {}): Fit {
  if (out.length < tw * th * 4) throw new Error(`present: output buffer ${out.length} < ${tw * th * 4}`);
  const f = computeFit(src.width, src.height, tw, th, o);
  const bg = o.background ?? 0x1a1410;
  const br = (bg >>> 16) & 255, bgg = (bg >>> 8) & 255, bb = bg & 255;
  const sw = src.width, sh = src.height, sd = src.data;
  const area = f.dw < sw && (o.downsample ?? "area") === "area";
  // Precompute source spans per target column/row.
  const xs0 = new Int32Array(tw), xs1 = new Int32Array(tw);
  for (let x = 0; x < tw; x++) {
    const u = x - f.dx;
    if (u < 0 || u >= f.dw) {
      xs0[x] = -1;
      continue;
    }
    xs0[x] = Math.min(sw - 1, Math.floor((u * sw) / f.dw));
    xs1[x] = area ? Math.max(xs0[x] + 1, Math.min(sw, Math.floor(((u + 1) * sw) / f.dw))) : xs0[x] + 1;
  }
  const ys0 = new Int32Array(th), ys1 = new Int32Array(th);
  for (let y = 0; y < th; y++) {
    const v = y - f.dy;
    if (v < 0 || v >= f.dh) {
      ys0[y] = -1;
      continue;
    }
    ys0[y] = Math.min(sh - 1, Math.floor((v * sh) / f.dh));
    ys1[y] = area ? Math.max(ys0[y] + 1, Math.min(sh, Math.floor(((v + 1) * sh) / f.dh))) : ys0[y] + 1;
  }
  for (let y = 0; y < th; y++) {
    const o4 = y * tw * 4;
    for (let x = 0; x < tw; x++) {
      const i = o4 + x * 4;
      if (xs0[x] < 0 || ys0[y] < 0) {
        out[i] = br;
        out[i + 1] = bgg;
        out[i + 2] = bb;
        out[i + 3] = 255;
        continue;
      }
      if (!area) {
        const s = (ys0[y] * sw + xs0[x]) * 4;
        out[i] = sd[s];
        out[i + 1] = sd[s + 1];
        out[i + 2] = sd[s + 2];
        out[i + 3] = 255;
        continue;
      }
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = ys0[y]; sy < ys1[y]; sy++)
        for (let sx = xs0[x]; sx < xs1[x]; sx++) {
          const s = (sy * sw + sx) * 4;
          r += sd[s];
          g += sd[s + 1];
          b += sd[s + 2];
          n++;
        }
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = 255;
    }
  }
  return f;
}

/** Convenience: integer nearest-neighbour upscale into a new Surface (screenshots, previews). */
export function upscale(src: Surface, factor: number): Surface {
  const out = new Surface(src.width * factor, src.height * factor);
  present(src, out.width, out.height, out.data, { scaling: "integer" });
  return out;
}

export function hasDom(): boolean {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

/**
 * Presents a Surface on a conventional canvas: the logical frame is written
 * with putImageData to a 1:1 backing canvas, then drawn scaled with smoothing
 * disabled (and CSS image-rendering: pixelated) so pixels stay crisp.
 */
export class CanvasPresenter {
  readonly canvas: HTMLCanvasElement;
  private backing: HTMLCanvasElement;
  private image: ImageData | null = null;

  constructor(canvas?: HTMLCanvasElement) {
    if (!hasDom()) throw new Error("CanvasPresenter needs a DOM (document is undefined)");
    this.canvas = canvas ?? document.createElement("canvas");
    this.canvas.style.imageRendering = "pixelated";
    this.backing = document.createElement("canvas");
  }

  /**
   * Draw `src` at an integer scale. With scale "fit" the largest integer
   * scale that fits (maxW, maxH) is used (minimum 1).
   */
  present(src: Surface, scale: number | "fit" = "fit", maxW = 0, maxH = 0): number {
    let k = typeof scale === "number" ? Math.max(1, Math.floor(scale)) : 1;
    if (scale === "fit" && maxW > 0 && maxH > 0) k = Math.max(1, Math.floor(Math.min(maxW / src.width, maxH / src.height)));
    if (this.backing.width !== src.width || this.backing.height !== src.height || !this.image) {
      this.backing.width = src.width;
      this.backing.height = src.height;
      this.image = new ImageData(src.width, src.height);
    }
    this.image.data.set(src.data.subarray(0, src.width * src.height * 4));
    this.backing.getContext("2d")!.putImageData(this.image, 0, 0);
    const W = src.width * k, H = src.height * k;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const ctx = this.canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.backing, 0, 0, W, H);
    return k;
  }
}
