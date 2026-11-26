/**
 * A tiny deterministic particle system. Emission takes the caller's RNG so a
 * seeded simulation stays reproducible; update/draw never consume randomness.
 */
import { type Color, mix } from "./color";
import type { Surface } from "./surface";

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds remaining / at spawn. */
  life: number;
  maxLife: number;
  color: Color;
  /** Colour at end of life (defaults to color). */
  endColor: Color;
  size: number;
  gravity: number;
  /** Per-second velocity damping factor (0 = none). */
  drag: number;
  /** Fade alpha over the last 40% of life. */
  fade: boolean;
  /** Stop on reaching this y (ground) instead of falling forever. */
  floorY?: number;
}

export interface BurstSpec {
  x: number;
  y: number;
  count: number;
  speed: [number, number];
  /** Radians; 0 = right, -PI/2 = up. */
  angle: [number, number];
  life: [number, number];
  colors: Color[];
  endColor?: Color;
  size?: [number, number];
  gravity?: number;
  drag?: number;
  spread?: number;
  fade?: boolean;
  floorOffset?: number;
}

export class ParticleSystem {
  readonly particles: Particle[] = [];
  constructor(public max = 400) {}

  emit(p: Partial<Particle> & { x: number; y: number }): void {
    if (this.particles.length >= this.max) this.particles.shift();
    const life = p.life ?? 1;
    const color = p.color ?? 0xffffff;
    this.particles.push({ vx: 0, vy: 0, maxLife: life, size: 1, gravity: 0, drag: 0, fade: true, endColor: p.endColor ?? color, ...p, life, color });
  }

  burst(spec: BurstSpec, rng: () => number): void {
    const lerp = (r: [number, number]) => r[0] + (r[1] - r[0]) * rng();
    for (let i = 0; i < spec.count; i++) {
      const a = lerp(spec.angle);
      const sp = lerp(spec.speed);
      const life = lerp(spec.life);
      const color = spec.colors[Math.floor(rng() * spec.colors.length) % spec.colors.length];
      const spread = spec.spread ?? 0;
      this.emit({
        x: spec.x + (rng() - 0.5) * spread,
        y: spec.y + (rng() - 0.5) * spread,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life,
        maxLife: life,
        color,
        endColor: spec.endColor ?? color,
        size: spec.size ? Math.round(lerp(spec.size)) : 1,
        gravity: spec.gravity ?? 0,
        drag: spec.drag ?? 0,
        fade: spec.fade ?? true,
        floorY: spec.floorOffset !== undefined ? spec.y + spec.floorOffset : undefined,
      });
    }
  }

  update(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy += p.gravity * dt;
      if (p.drag > 0) {
        const k = Math.max(0, 1 - p.drag * dt);
        p.vx *= k;
        p.vy *= k;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.floorY !== undefined && p.y > p.floorY) {
        p.y = p.floorY;
        p.vy = 0;
        p.vx *= 0.5;
      }
      this.particles[w++] = p;
    }
    this.particles.length = w;
  }

  draw(s: Surface): void {
    for (const p of this.particles) {
      const t = 1 - p.life / p.maxLife;
      const c = p.endColor === p.color ? p.color : mix(p.color, p.endColor, t);
      const a = p.fade && t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
      if (p.size <= 1) s.pset(p.x, p.y, c, a);
      else s.fillRect(p.x - (p.size >> 1), p.y - (p.size >> 1), p.size, p.size, c, a);
    }
  }

  clear(): void {
    this.particles.length = 0;
  }

  get count(): number {
    return this.particles.length;
  }
}
