/** Pedestrian AI: pavement loops, signalised crossings, reactions to traffic. */
import type { CityLayout } from "../city";
import { Human, randomLook } from "./human";
import { pedestrianMayCross } from "./nav";

export interface PedBrain {
  loop: number;
  corner: number; // index of the corner we walk towards
  dir: 1 | -1;
  speed: number;
  lateral: number;
  crossing: { tx: number; tz: number; node: number; axis: "ns" | "ew"; waiting: boolean } | null;
  fleeX: number;
  fleeZ: number;
  idle: number;
}

export function brain(h: Human): PedBrain {
  return h.tag.brain as PedBrain;
}

export function makePed(city: CityLayout, r: () => number, x: number, z: number): Human | null {
  // join the nearest loop corner segment
  let best = -1, bd = 1e9, bc = 0;
  city.sidewalkLoops.forEach((loop, li) => {
    loop.forEach((c, ci) => {
      const d = (c.x - x) ** 2 + (c.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = li;
        bc = ci;
      }
    });
  });
  if (best < 0) return null;
  const loop = city.sidewalkLoops[best];
  const a = loop[bc], b = loop[(bc + 1) % loop.length];
  const u = r();
  const h = new Human(randomLook(r));
  h.x = a.x + (b.x - a.x) * u;
  h.z = a.z + (b.z - a.z) * u;
  const br: PedBrain = { loop: best, corner: (bc + 1) % loop.length, dir: 1, speed: 1.15 + r() * 0.5, lateral: (r() - 0.5) * 1.6, crossing: null, fleeX: 0, fleeZ: 0, idle: 0 };
  if (r() < 0.5) {
    br.dir = -1;
    br.corner = bc;
  }
  h.tag.brain = br;
  return h;
}

/** Desired velocity for a pedestrian this step. */
export function pedThink(h: Human, city: CityLayout, t: number, dt: number, r: () => number, threats: { x: number; z: number; vx: number; vz: number }[]): { vx: number; vz: number } {
  const b = brain(h);
  if (h.pose === "knocked" || h.pose === "getup") return { vx: 0, vz: 0 };
  // threat check: vehicles approaching fast
  for (const c of threats) {
    const dx = h.x - c.x, dz = h.z - c.z;
    const d = Math.hypot(dx, dz);
    const sp = Math.hypot(c.vx, c.vz);
    if (d > 14 || sp < 4) continue;
    const toward = -(dx * c.vx + dz * c.vz) / (d * sp);
    if (toward < -0.6 || (d < 5 && sp > 6)) {
      // dive sideways relative to the car's travel
      const side = Math.sign(dx * -c.vz + dz * c.vx) || 1;
      b.fleeX = (-c.vz / sp) * side;
      b.fleeZ = (c.vx / sp) * side;
      h.fleeing = 1.6 + r();
    }
  }
  if (h.fleeing > 0) {
    h.fleeing -= dt;
    if (h.fleeing <= 0) {
      b.crossing = null;
      rejoin(h, city);
    }
    return { vx: b.fleeX * 5.2, vz: b.fleeZ * 5.2 };
  }
  if (b.idle > 0) {
    b.idle -= dt;
    return { vx: 0, vz: 0 };
  }
  if (b.crossing) {
    const c = b.crossing;
    if (c.waiting) {
      if (pedestrianMayCross(city.nodes[c.node], c.axis === "ew" ? "ns" : "ew", t)) c.waiting = false;
      else return { vx: 0, vz: 0 };
    }
    const dx = c.tx - h.x, dz = c.tz - h.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.8) {
      b.crossing = null;
      rejoin(h, city);
    } else {
      const s = b.speed * 1.25;
      return { vx: (dx / d) * s, vz: (dz / d) * s };
    }
  }
  const loop = city.sidewalkLoops[b.loop];
  const tgt = loop[b.corner];
  // lateral offset keeps people from walking in single file
  const prev = loop[(b.corner - b.dir + loop.length) % loop.length];
  const sx = tgt.x - prev.x, sz = tgt.z - prev.z;
  const sl = Math.hypot(sx, sz) || 1;
  const ox = (-sz / sl) * b.lateral, oz = (sx / sl) * b.lateral;
  const dx = tgt.x + ox - h.x, dz = tgt.z + oz - h.z;
  const d = Math.hypot(dx, dz);
  if (d < 1.2) {
    // at a corner: maybe cross the road
    const xw = city.crosswalks.filter((c) => Math.hypot(c.a.x - tgt.x, c.a.z - tgt.z) < 5 || Math.hypot(c.b.x - tgt.x, c.b.z - tgt.z) < 5);
    if (xw.length && r() < 0.45) {
      const c = xw[Math.floor(r() * xw.length)];
      const fromA = Math.hypot(c.a.x - tgt.x, c.a.z - tgt.z) < Math.hypot(c.b.x - tgt.x, c.b.z - tgt.z);
      const end = fromA ? c.b : c.a;
      const start = fromA ? c.a : c.b;
      b.crossing = { tx: end.x, tz: end.z, node: c.node, axis: c.axis, waiting: true };
      h.x += (start.x - h.x) * 0.5;
      h.z += (start.z - h.z) * 0.5;
      return { vx: 0, vz: 0 };
    }
    b.corner = (b.corner + b.dir + loop.length) % loop.length;
    if (r() < 0.08) b.idle = 1 + r() * 3;
    return { vx: 0, vz: 0 };
  }
  return { vx: (dx / d) * b.speed, vz: (dz / d) * b.speed };
}

/** After crossing or fleeing, pick the nearest loop segment again. */
export function rejoin(h: Human, city: CityLayout): void {
  const b = brain(h);
  let best = b.loop, bd = 1e9, bc = 0;
  city.sidewalkLoops.forEach((loop, li) =>
    loop.forEach((c, ci) => {
      const d = (c.x - h.x) ** 2 + (c.z - h.z) ** 2;
      if (d < bd) {
        bd = d;
        best = li;
        bc = ci;
      }
    }),
  );
  b.loop = best;
  const loop = city.sidewalkLoops[best];
  b.corner = (bc + b.dir + loop.length) % loop.length;
}
