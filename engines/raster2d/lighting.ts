/**
 * Lighting for a software framebuffer: an ambient multiplier (day/night,
 * weather) plus additive point lights with banded, ordered-dithered falloff so
 * light pools stay crisp pixel art instead of smooth gradients.
 */
import { type Color, keyframeColor, red, green, blue } from "./color";
import { bayer4 } from "./noise";
import type { Surface } from "./surface";

export interface Light {
  /** World coordinates (the surface origin is subtracted). */
  x: number;
  y: number;
  radius: number;
  color: Color;
  /** 0..1+ strength at the centre. */
  intensity: number;
}

export interface LightingOptions {
  /** Number of brightness bands (0 = smooth). */
  bands?: number;
  /** Dither between bands. */
  dither?: boolean;
}

/**
 * Multiply every pixel by `ambient` (0xRRGGBB read as 0..1 factors) plus the
 * contribution of each light; channel factors are capped at 1.
 */
export function applyLighting(s: Surface, ambient: Color, lights: readonly Light[] = [], o: LightingOptions = {}): void {
  const ar = red(ambient) / 255, ag = green(ambient) / 255, ab = blue(ambient) / 255;
  if (ar >= 1 && ag >= 1 && ab >= 1 && lights.length === 0) return;
  const bands = o.bands ?? 4;
  const dither = o.dither ?? true;
  const ls = lights
    .map((l) => ({ x: l.x - s.ox, y: l.y - s.oy, r: l.radius, r2: l.radius * l.radius, cr: (red(l.color) / 255) * l.intensity, cg: (green(l.color) / 255) * l.intensity, cb: (blue(l.color) / 255) * l.intensity }))
    .filter((l) => l.x + l.r >= 0 && l.y + l.r >= 0 && l.x - l.r < s.width && l.y - l.r < s.height);
  const d = s.data;
  for (let py = 0; py < s.height; py++)
    for (let px = 0; px < s.width; px++) {
      let fr = ar, fg = ag, fb = ab;
      for (const l of ls) {
        const dx = px + 0.5 - l.x;
        const dy = py + 0.5 - l.y;
        const dd = dx * dx + dy * dy;
        if (dd >= l.r2) continue;
        let k = 1 - Math.sqrt(dd) / l.r;
        k *= k;
        if (bands > 0) {
          const q = k * bands + (dither ? bayer4(px, py) - 0.5 : 0);
          k = Math.max(0, Math.min(bands, Math.round(q))) / bands;
        }
        fr += l.cr * k;
        fg += l.cg * k;
        fb += l.cb * k;
      }
      if (fr >= 1 && fg >= 1 && fb >= 1) continue;
      const i = (py * s.width + px) * 4;
      d[i] = d[i] * Math.min(1, fr);
      d[i + 1] = d[i + 1] * Math.min(1, fg);
      d[i + 2] = d[i + 2] * Math.min(1, fb);
    }
}

/** Blend every pixel towards `color` by amount (fog, flash, sepia wash). */
export function tintOverlay(s: Surface, color: Color, amount: number): void {
  if (amount <= 0) return;
  const r = red(color), g = green(color), b = blue(color);
  const d = s.data;
  for (let i = 0; i < s.width * s.height * 4; i += 4) {
    d[i] += (r - d[i]) * amount;
    d[i + 1] += (g - d[i + 1]) * amount;
    d[i + 2] += (b - d[i + 2]) * amount;
  }
}

/** Default ambient keyframes by hour of day (0..30, hours past midnight wrap above 24). */
export const DAY_NIGHT_KEYS: readonly (readonly [number, Color])[] = [
  [4.0, 0x4a5590],
  [5.5, 0x8a7a9a],
  [6.5, 0xf0c8a8],
  [8.0, 0xffffff],
  [16.5, 0xffffff],
  [18.0, 0xffdcb0],
  [19.2, 0xd89a90],
  [20.2, 0x7a6aa0],
  [21.5, 0x4f5a98],
  [30.0, 0x4a5590],
];

/** Ambient colour for an hour of day (hours >= 24 continue past midnight). */
export function dayNightAmbient(hour: number, keys = DAY_NIGHT_KEYS): Color {
  return keyframeColor(keys, hour);
}
