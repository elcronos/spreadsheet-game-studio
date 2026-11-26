/**
 * Collision against the ground raster, with the same interface the Gridlock City
 * car and on-foot physics use (resolveCircle), so those can drive on the real map.
 * "Blocked" depends on who is moving: land actors hit buildings and water, boats hit
 * everything that isn't water (piers and the shore).
 */
import { G, Raster } from "../map";

export type Medium = "land" | "water";

export class RasterCollider {
  constructor(private r: Raster, private medium: Medium) {}

  blocked(cls: number): boolean {
    return this.medium === "land" ? cls === G.BUILDING || cls === G.WATER : cls !== G.WATER && cls !== G.FOOTBRIDGE && cls !== G.BRIDGE;
  }

  blockedAt(x: number, z: number): boolean {
    return this.blocked(this.r.at(x, z));
  }

  /** Push a circle out of blocked cells. Same return shape as StaticGrid.resolveCircle. */
  resolveCircle(x: number, z: number, rad: number, _includeLow = true): { x: number; z: number; nx: number; nz: number; depth: number } | null {
    const R = this.r, res = R.res;
    let px = x, pz = z, hit = false, best = 0, bnx = 0, bnz = 0;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const cx0 = Math.floor((px - rad - R.x0) / res), cx1 = Math.floor((px + rad - R.x0) / res);
      const cy0 = Math.floor((R.y1 + pz - rad) / res), cy1 = Math.floor((R.y1 + pz + rad) / res);
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) {
          if (!this.blocked(R.cell(cx, cy))) continue;
          const bx0 = R.x0 + cx * res, bx1 = bx0 + res, bz0 = cy * res - R.y1, bz1 = bz0 + res;
          const qx = Math.max(bx0, Math.min(px, bx1)), qz = Math.max(bz0, Math.min(pz, bz1));
          let dx = px - qx, dz = pz - qz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= rad * rad) continue;
          let d = Math.sqrt(d2), depth: number;
          if (d < 1e-6) {
            // centre inside the cell: push out through the nearest free side
            const opts: [number, number, number][] = [
              [px - bx0, -1, 0], [bx1 - px, 1, 0], [pz - bz0, 0, -1], [bz1 - pz, 0, 1],
            ];
            opts.sort((a, b) => a[0] - b[0]);
            const [dd, ox, oz] = opts[0];
            dx = ox; dz = oz; d = 1; depth = dd + rad;
          } else depth = rad - d;
          const nx = dx / d, nz = dz / d;
          px += nx * depth;
          pz += nz * depth;
          moved = hit = true;
          if (depth > best) [best, bnx, bnz] = [depth, nx, nz];
        }
      if (!moved) break;
    }
    return hit ? { x: px - x, z: pz - z, nx: bnx, nz: bnz, depth: best } : null;
  }
}
