/**
 * Colours are packed 0xRRGGBB integers. Alpha is always a separate 0..1 argument
 * so palettes stay plain numbers that are easy to put in tables and sprites.
 */
export type Color = number;

export function rgb(r: number, g: number, b: number): Color {
  return ((clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b)) >>> 0;
}

export function hexColor(s: string): Color {
  const h = s.replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n) || full.length !== 6) throw new Error(`Bad colour "${s}"`);
  return n >>> 0;
}

export const red = (c: Color): number => (c >>> 16) & 255;
export const green = (c: Color): number => (c >>> 8) & 255;
export const blue = (c: Color): number => c & 255;

export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Linear blend a -> b by t (0..1). */
export function mix(a: Color, b: Color, t: number): Color {
  return rgb(red(a) + (red(b) - red(a)) * t, green(a) + (green(b) - green(a)) * t, blue(a) + (blue(b) - blue(a)) * t);
}

/** Multiply brightness (f < 1 darkens, f > 1 brightens). */
export function shade(c: Color, f: number): Color {
  return rgb(red(c) * f, green(c) * f, blue(c) * f);
}

/** Multiply per channel by another colour interpreted as 0..1 factors. */
export function multiplyColor(c: Color, m: Color): Color {
  return rgb((red(c) * red(m)) / 255, (green(c) * green(m)) / 255, (blue(c) * blue(m)) / 255);
}

export function toHex(c: Color): string {
  return "#" + (c & 0xffffff).toString(16).padStart(6, "0");
}

/** Linear interpolation through keyframes [t, colour]; t must be ascending. */
export function keyframeColor(keys: readonly (readonly [number, Color])[], t: number): Color {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, c0] = keys[i - 1];
      const [t1, c1] = keys[i];
      return mix(c0, c1, (t - t0) / (t1 - t0 || 1));
    }
  }
  return keys[keys.length - 1][1];
}
