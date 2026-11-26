/** Minimal geometry builder: quads and boxes with world-scale UVs and vertex colours. */
import * as THREE from "three";

const tmpC = new THREE.Color();

export class Geo {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** a,b,c,d counter-clockwise seen from the front (normal side). */
  quad(a: number[], b: number[], c: number[], d: number[], uv: [number, number, number, number] = [0, 0, 1, 1], colour = 0xffffff, n?: number[]): void {
    const base = this.vertexCount;
    if (!n) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
      n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      n = [n[0] / l, n[1] / l, n[2] / l];
    }
    tmpC.setHex(colour);
    for (const p of [a, b, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n[0], n[1], n[2]);
      this.col.push(tmpC.r, tmpC.g, tmpC.b);
    }
    const [u0, v0, u1, v1] = uv;
    this.uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Axis-aligned box; uvScale > 0 gives world-scale UVs (metres per repeat). */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, colour = 0xffffff, uvScale = 0, skipBottom = true): void {
    const s = uvScale || 1;
    const U = (a: number, b: number, c: number, d: number): [number, number, number, number] => (uvScale ? [a / s, b / s, c / s, d / s] : [0, 0, 1, 1]);
    // +z face
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], U(x0, y0, x1, y1), colour, [0, 0, 1]);
    // -z face
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], U(-x1, y0, -x0, y1), colour, [0, 0, -1]);
    // +x
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], U(-z1, y0, -z0, y1), colour, [1, 0, 0]);
    // -x
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], U(z0, y0, z1, y1), colour, [-1, 0, 0]);
    // top
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], U(x0, -z1, x1, -z0), colour, [0, 1, 0]);
    if (!skipBottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], U(x0, z0, x1, z1), colour, [0, -1, 0]);
  }

  /** Horizontal quad on the ground (y), world UVs. */
  flat(x0: number, z0: number, x1: number, z1: number, y: number, uvScale: number, colour = 0xffffff): void {
    const s = uvScale;
    this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [x0 / s, -z1 / s, x1 / s, -z0 / s], colour, [0, 1, 0]);
  }

  /** Ribbon along a polyline on the ground. */
  ribbon(pts: { x: number; z: number }[], halfWidth: number, y: number, uvScale: number, colour = 0xffffff, offset = 0): void {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
      if (l < 1e-6) continue;
      // average normals at joints for smooth curves
      const n0 = normalAt(pts, i - 1), n1 = normalAt(pts, i);
      const al = { x: a.x + n0.x * (offset - halfWidth), z: a.z + n0.z * (offset - halfWidth) };
      const ar = { x: a.x + n0.x * (offset + halfWidth), z: a.z + n0.z * (offset + halfWidth) };
      const bl = { x: b.x + n1.x * (offset - halfWidth), z: b.z + n1.z * (offset - halfWidth) };
      const br = { x: b.x + n1.x * (offset + halfWidth), z: b.z + n1.z * (offset + halfWidth) };
      const u0 = acc / uvScale, u1 = (acc + l) / uvScale;
      this.quad([ar.x, y, ar.z], [br.x, y, br.z], [bl.x, y, bl.z], [al.x, y, al.z], [0, u0, (2 * halfWidth) / uvScale, u1], colour, [0, 1, 0]);
      acc += l;
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Left-hand normal of a polyline at vertex i (perpendicular to travel, pointing to the right of travel = (-dz, dx)). */
export function normalAt(pts: { x: number; z: number }[], i: number): { x: number; z: number } {
  const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
  return { x: -dz / l, z: dx / l };
}
