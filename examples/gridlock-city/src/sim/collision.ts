/**
 * Static collision grid (axis-aligned boxes) + dynamic spatial hash.
 * Everything is 2D on the ground plane; height is handled separately.
 */
import type { Rect } from "../city";

export class StaticGrid {
  private cells = new Map<number, number[]>();
  readonly rects: (Rect & { low?: boolean })[] = [];
  constructor(private size = 16) {}

  private key(cx: number, cz: number): number {
    return (cx + 1024) * 4096 + (cz + 1024);
  }

  add(r: Rect, low = false): void {
    const i = this.rects.length;
    this.rects.push({ ...r, low });
    const s = this.size;
    for (let cx = Math.floor(r.x0 / s); cx <= Math.floor(r.x1 / s); cx++)
      for (let cz = Math.floor(r.z0 / s); cz <= Math.floor(r.z1 / s); cz++) {
        const k = this.key(cx, cz);
        let a = this.cells.get(k);
        if (!a) this.cells.set(k, (a = []));
        a.push(i);
      }
  }

  query(x0: number, z0: number, x1: number, z1: number, out: number[]): number[] {
    out.length = 0;
    const s = this.size;
    for (let cx = Math.floor(x0 / s); cx <= Math.floor(x1 / s); cx++)
      for (let cz = Math.floor(z0 / s); cz <= Math.floor(z1 / s); cz++) {
        const a = this.cells.get(this.key(cx, cz));
        if (a) for (const i of a) if (!out.includes(i)) out.push(i);
      }
    return out;
  }

  private tmp: number[] = [];

  /**
   * Push a circle out of all boxes. Returns the accumulated push vector and the
   * deepest contact normal (or null).
   */
  resolveCircle(x: number, z: number, r: number, includeLow = true): { x: number; z: number; nx: number; nz: number; depth: number } | null {
    const ids = this.query(x - r, z - r, x + r, z + r, this.tmp);
    let px = x, pz = z, hit = false, bestDepth = 0, bnx = 0, bnz = 0;
    for (let iter = 0; iter < 2; iter++) {
      for (const i of ids) {
        const b = this.rects[i];
        if (!includeLow && b.low) continue;
        const cx = Math.max(b.x0, Math.min(px, b.x1));
        const cz = Math.max(b.z0, Math.min(pz, b.z1));
        let dx = px - cx, dz = pz - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        let d = Math.sqrt(d2), depth: number;
        if (d < 1e-6) {
          // centre inside the box: push out along the shallowest axis
          const l = px - b.x0, rr = b.x1 - px, t = pz - b.z0, bt = b.z1 - pz;
          const m = Math.min(l, rr, t, bt);
          if (m === l) { dx = -1; dz = 0; depth = l + r; }
          else if (m === rr) { dx = 1; dz = 0; depth = rr + r; }
          else if (m === t) { dx = 0; dz = -1; depth = t + r; }
          else { dx = 0; dz = 1; depth = bt + r; }
          d = 1;
        } else depth = r - d;
        const nx = dx / d, nz = dz / d;
        px += nx * depth;
        pz += nz * depth;
        hit = true;
        if (depth > bestDepth) {
          bestDepth = depth;
          bnx = nx;
          bnz = nz;
        }
      }
    }
    return hit ? { x: px - x, z: pz - z, nx: bnx, nz: bnz, depth: bestDepth } : null;
  }

  /** Segment vs boxes; returns fraction of first hit (1 = clear). */
  raycast(x0: number, z0: number, x1: number, z1: number, includeLow = false): number {
    const ids = this.query(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), this.tmp);
    const dx = x1 - x0, dz = z1 - z0;
    let best = 1;
    for (const i of ids) {
      const b = this.rects[i];
      if (!includeLow && b.low) continue;
      let t0 = 0, t1 = best;
      if (Math.abs(dx) < 1e-9) {
        if (x0 < b.x0 || x0 > b.x1) continue;
      } else {
        let a = (b.x0 - x0) / dx, c = (b.x1 - x0) / dx;
        if (a > c) [a, c] = [c, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, c);
        if (t0 > t1) continue;
      }
      if (Math.abs(dz) < 1e-9) {
        if (z0 < b.z0 || z0 > b.z1) continue;
      } else {
        let a = (b.z0 - z0) / dz, c = (b.z1 - z0) / dz;
        if (a > c) [a, c] = [c, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, c);
        if (t0 > t1) continue;
      }
      if (t0 < best) best = t0;
    }
    return best;
  }

  inside(x: number, z: number): boolean {
    const ids = this.query(x, z, x, z, this.tmp);
    for (const i of ids) {
      const b = this.rects[i];
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return true;
    }
    return false;
  }
}

/** Uniform hash for moving entities, rebuilt every step (cheap at these counts). */
export class SpatialHash<T extends { x: number; z: number }> {
  private cells = new Map<number, T[]>();
  constructor(private size = 12) {}
  clear(): void {
    this.cells.clear();
  }
  private key(cx: number, cz: number): number {
    return (cx + 1024) * 4096 + (cz + 1024);
  }
  insert(e: T): void {
    const k = this.key(Math.floor(e.x / this.size), Math.floor(e.z / this.size));
    let a = this.cells.get(k);
    if (!a) this.cells.set(k, (a = []));
    a.push(e);
  }
  near(x: number, z: number, r: number, out: T[]): T[] {
    out.length = 0;
    const s = this.size;
    for (let cx = Math.floor((x - r) / s); cx <= Math.floor((x + r) / s); cx++)
      for (let cz = Math.floor((z - r) / s); cz <= Math.floor((z + r) / s); cz++) {
        const a = this.cells.get(this.key(cx, cz));
        if (a) for (const e of a) if ((e.x - x) ** 2 + (e.z - z) ** 2 <= r * r) out.push(e);
      }
    return out;
  }
}
