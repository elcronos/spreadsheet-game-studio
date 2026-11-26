/**
 * Road navigation: traffic signals, lane waypoints, turns, A* routing and a
 * shared driver controller used by traffic, police and race rivals. AI cars
 * drive with exactly the same vehicle physics as the player.
 */
import type { CityLayout, GraphEdge, GraphNode } from "../city";
import { edgePointAt, roadHalfWidthX, ROAD_W, BLVD_W } from "../city";
import type { Vehicle } from "./vehicle";

export const SIGNAL_CYCLE = 24;
export type Light = "green" | "yellow" | "red";

export function signalOffset(n: GraphNode): number {
  return ((Math.round(n.x / 90) + Math.round(n.z / 90)) * 5 + 100 * SIGNAL_CYCLE) % SIGNAL_CYCLE;
}

/** Light shown to traffic travelling along an axis ("ns" = north/south traffic). */
export function signalFor(n: GraphNode, axis: "ns" | "ew", t: number): Light {
  if (!n.signal) return "green";
  const p = (t + signalOffset(n)) % SIGNAL_CYCLE;
  if (axis === "ns") return p < 9 ? "green" : p < 11.5 ? "yellow" : "red";
  return p >= 12 && p < 21 ? "green" : p >= 21 && p < 23.5 ? "yellow" : "red";
}

/** Pedestrians may use a crosswalk when the traffic it crosses is held at red. */
export function pedestrianMayCross(n: GraphNode, crossesTrafficAxis: "ns" | "ew", t: number): boolean {
  const p = (t + signalOffset(n)) % SIGNAL_CYCLE;
  // crossing an avenue (ns traffic): allowed during the ew-green window, with a margin
  if (crossesTrafficAxis === "ns") return p >= 12.5 && p < 20;
  return p >= 0.5 && p < 8;
}

export interface Waypoint {
  x: number;
  z: number;
  /** This waypoint is a stop line for the node, approached along axis. */
  stopNode?: number;
  axis?: "ns" | "ew";
  /** Inside an intersection (never stop here). */
  turn?: boolean;
}

export interface Leg {
  edge: number;
  dir: 1 | -1;
}

export function crossHalf(city: CityLayout, node: GraphNode): number {
  let m = ROAD_W / 2;
  for (const eid of node.edges) m = Math.max(m, city.edges[eid].halfWidth);
  return m;
}

function laneOffset(e: GraphEdge, lane: number): number {
  if (e.halfWidth > 9) return lane === 0 ? 3.9 : 7.4; // boulevard with median
  return lane === 0 ? 1.8 : 5.2;
}

/** Waypoints along one leg, offset into the right-hand lane. */
export function legWaypoints(city: CityLayout, leg: Leg, lane: number, spacing = 7): Waypoint[] {
  const e = city.edges[leg.edge];
  const from = city.nodes[leg.dir === 1 ? e.a : e.b];
  const to = city.nodes[leg.dir === 1 ? e.b : e.a];
  const s0 = crossHalf(city, from) + 3.5;
  const s1 = e.length - crossHalf(city, to) - 4.5;
  const out: Waypoint[] = [];
  const off = laneOffset(e, lane);
  const n = Math.max(1, Math.ceil((s1 - s0) / spacing));
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    const sAlong = leg.dir === 1 ? s : e.length - s;
    const p = edgePointAt(e, sAlong);
    const dx = p.dx * leg.dir, dz = p.dz * leg.dir;
    // right of travel direction = (-dz, dx)
    out.push({ x: p.x - dz * off, z: p.z + dx * off });
  }
  const last = out[out.length - 1];
  const p = edgePointAt(e, leg.dir === 1 ? e.length : 0);
  last.stopNode = to.id;
  last.axis = Math.abs(p.dz) > Math.abs(p.dx) ? "ns" : "ew";
  return out;
}

export function legEndNode(city: CityLayout, leg: Leg): number {
  const e = city.edges[leg.edge];
  return leg.dir === 1 ? e.b : e.a;
}

export function legFrom(city: CityLayout, edgeId: number, fromNode: number): Leg {
  return { edge: edgeId, dir: city.edges[edgeId].a === fromNode ? 1 : -1 };
}

/** Smooth turn through an intersection between two legs' lane points. */
export function turnWaypoints(a: Waypoint, b: Waypoint, node: GraphNode): Waypoint[] {
  const out: Waypoint[] = [];
  const cx = (a.x + b.x) / 2 * 0.5 + node.x * 0.5, cz = (a.z + b.z) / 2 * 0.5 + node.z * 0.5;
  for (let i = 1; i <= 4; i++) {
    const t = i / 5;
    const u = 1 - t;
    out.push({ x: u * u * a.x + 2 * u * t * cx + t * t * b.x, z: u * u * a.z + 2 * u * t * cz + t * t * b.z, turn: true });
  }
  return out;
}

export function nearestNode(city: CityLayout, x: number, z: number): number {
  let best = 0, bd = 1e18;
  for (const n of city.nodes) {
    const d = (n.x - x) ** 2 + (n.z - z) ** 2;
    if (d < bd) {
      bd = d;
      best = n.id;
    }
  }
  return best;
}

/** A* over intersections; returns legs from `from` to `to`. */
export function findRoute(city: CityLayout, from: number, to: number): Leg[] {
  if (from === to) return [];
  const g = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, { node: number; edge: number }>();
  const open = new Set([from]);
  const h = (n: number) => Math.hypot(city.nodes[n].x - city.nodes[to].x, city.nodes[n].z - city.nodes[to].z);
  while (open.size) {
    let cur = -1, bf = 1e18;
    for (const n of open) {
      const f = g.get(n)! + h(n);
      if (f < bf) {
        bf = f;
        cur = n;
      }
    }
    if (cur === to) break;
    open.delete(cur);
    for (const eid of city.nodes[cur].edges) {
      const e = city.edges[eid];
      const nb = e.a === cur ? e.b : e.a;
      const ng = g.get(cur)! + e.length;
      if (ng < (g.get(nb) ?? 1e18)) {
        g.set(nb, ng);
        prev.set(nb, { node: cur, edge: eid });
        open.add(nb);
      }
    }
  }
  const legs: Leg[] = [];
  let n = to;
  while (n !== from) {
    const p = prev.get(n);
    if (!p) return [];
    legs.unshift(legFrom(city, p.edge, p.node));
    n = p.node;
  }
  return legs;
}

export interface DriverOpts {
  cruise: number; // m/s
  obeySignals: boolean;
  avoid: boolean;
  lane: number;
  aggression: number; // 0..1
}

export interface Obstacle {
  x: number;
  z: number;
  vx: number;
  vz: number;
  r: number;
  id: number;
}

/**
 * Follows a queue of waypoints built from legs. When the queue runs low it
 * extends with `nextLeg` (random turn for traffic, planned route for police/racers).
 */
export class RoadDriver {
  wps: Waypoint[] = [];
  leg: Leg;
  plan: Leg[] = [];
  stuck = 0;
  reverseTimer = 0;
  waitingAtRed = false;
  /** Seconds held up by obstacles (not lights); used to break deadlocks. */
  blocked = 0;
  private assertive = 0;
  private recovering = 0;
  constructor(private city: CityLayout, leg: Leg, public opts: DriverOpts, private rand: () => number) {
    this.leg = leg;
    this.wps = legWaypoints(city, leg, opts.lane);
  }

  /** Plan a route from the end of the current leg to a node. */
  routeTo(goal: number): void {
    this.setPlan(findRoute(this.city, legEndNode(this.city, this.leg), goal));
  }

  /** Replace the plan (police re-route, race). Keeps the current leg. */
  setPlan(legs: Leg[]): void {
    this.plan = legs.slice();
    // drop queued legs beyond the current one so the plan takes effect quickly
    const end = this.wps.findIndex((w) => w.stopNode !== undefined);
    if (end >= 0) this.wps.length = end + 1;
  }

  private extend(): void {
    const node = legEndNode(this.city, this.leg);
    const n = this.city.nodes[node];
    let next: Leg | undefined;
    while (this.plan.length) {
      const cand = this.plan.shift()!;
      const e = this.city.edges[cand.edge];
      if ((cand.dir === 1 ? e.a : e.b) === node) {
        next = cand;
        break;
      }
    }
    if (!next) {
      const options = n.edges.filter((eid) => eid !== this.leg.edge);
      const eid = options.length ? options[Math.floor(this.rand() * options.length)] : this.leg.edge;
      next = legFrom(this.city, eid, node);
    }
    const nw = legWaypoints(this.city, next, this.opts.lane);
    const last = this.wps.length ? this.wps[this.wps.length - 1] : nw[0];
    this.wps.push(...turnWaypoints(last, nw[0], n), ...nw);
    this.leg = next;
  }

  /** Compute controls for a vehicle. Returns desired speed for telemetry. */
  drive(v: Vehicle, dt: number, t: number, obstacles: Obstacle[], directTarget?: { x: number; z: number } | null): number {
    // consume waypoints
    while (this.wps.length) {
      const w = this.wps[0];
      const dx = w.x - v.x, dz = w.z - v.z;
      const d = Math.hypot(dx, dz);
      const ahead = dx * v.fx + dz * v.fz;
      const popR = w.stopNode !== undefined ? 1.6 : 4;
      if (d < popR || (ahead < 0 && d < 10)) this.wps.shift();
      else break;
    }
    while (this.wps.length < 8) this.extend();
    const sp = v.speed;
    // lookahead target
    let tx: number, tz: number;
    if (directTarget) {
      tx = directTarget.x;
      tz = directTarget.z;
    } else {
      const L = 4 + Math.abs(sp) * 0.38;
      let acc = 0, px = v.x, pz = v.z;
      tx = this.wps[0].x;
      tz = this.wps[0].z;
      for (const w of this.wps) {
        acc += Math.hypot(w.x - px, w.z - pz);
        px = w.x;
        pz = w.z;
        tx = w.x;
        tz = w.z;
        if (acc >= L) break;
      }
    }
    const dx = tx - v.x, dz = tz - v.z;
    const fwd = dx * v.fx + dz * v.fz;
    const right = dx * -v.fz + dz * v.fx;
    const ang = Math.atan2(right, Math.max(0.01, fwd) + (fwd < 0 ? 0 : 0));
    const angFull = Math.atan2(right, fwd);
    let overtakeAng: number | null = null;
    // desired speed: anticipate bends by looking further down the path than the steering point
    let want = this.opts.cruise;
    let curve = Math.abs(angFull);
    if (!directTarget) {
      const far = 14 + Math.abs(sp) * 1.1;
      let acc = 0, px = v.x, pz = v.z;
      for (const w of this.wps) {
        acc += Math.hypot(w.x - px, w.z - pz);
        px = w.x;
        pz = w.z;
        if (acc >= far) break;
      }
      const fdx = px - v.x, fdz = pz - v.z;
      curve = Math.max(curve, Math.abs(Math.atan2(fdx * -v.fz + fdz * v.fx, fdx * v.fx + fdz * v.fz)) * 0.5);
    }
    want *= Math.max(0.3, 1 - curve * (directTarget ? 0.5 : 1.15));
    this.waitingAtRed = false;
    let redAhead = false;
    if (this.opts.obeySignals && !directTarget) {
      let acc = 0, px = v.x, pz = v.z;
      for (const w of this.wps) {
        acc += Math.hypot(w.x - px, w.z - pz);
        px = w.x;
        pz = w.z;
        if (acc > 45) break;
        if (w.stopNode !== undefined) {
          const light = signalFor(this.city.nodes[w.stopNode], w.axis!, t);
          const canStop = sp * sp < 2 * 6 * Math.max(0, acc - 1);
          if (light === "red" || (light === "yellow" && canStop)) {
            redAhead = true;
            want = Math.min(want, Math.sqrt(2 * 4.5 * Math.max(0, acc - 3)));
            if (acc < 12) this.waitingAtRed = true;
          }
          break;
        }
      }
    }
    const preObstacle = want;
    let limiting: Obstacle | null = null;
    const ahead = (o: Obstacle, lateralShift: number) => {
      const ox = o.x - v.x, oz = o.z - v.z;
      const lz = ox * v.fx + oz * v.fz;
      if (lz <= 0 || lz > 30) return null;
      const lx = ox * -v.fz + oz * v.fx - lateralShift;
      if (Math.abs(lx) > 1.2 + o.r) return null;
      return lz;
    };
    if (this.opts.avoid && this.assertive <= 0) {
      for (const o of obstacles) {
        if (o.id === v.id) continue;
        const lz = ahead(o, 0);
        if (lz === null) continue;
        const gap = lz - v.dims.length * 0.5 - o.r;
        // relative closing speed
        const ovF = o.vx * v.fx + o.vz * v.fz;
        const allowed = Math.max(0, ovF) * 0.9 + Math.sqrt(2 * 5.5 * Math.max(0, gap - 2.5 * (1 - this.opts.aggression * 0.6)));
        if (allowed < want) {
          want = allowed;
          limiting = o;
        }
      }
      // aggressive drivers (police, racers) overtake on the left instead of queueing
      if (limiting && this.opts.aggression > 0.3 && preObstacle - want > 3) {
        const shift = -3.6; // left of travel
        if (!obstacles.some((o) => o.id !== v.id && ahead(o, shift) !== null)) {
          want = preObstacle;
          const lx = v.fz, lz = -v.fx; // left vector
          const ntx = tx + lx * 3.6, ntz = tz + lz * 3.6;
          const ndx = ntx - v.x, ndz = ntz - v.z;
          overtakeAng = Math.atan2(ndx * -v.fz + ndz * v.fx, Math.max(0.01, ndx * v.fx + ndz * v.fz));
        }
      }
    }
    // deadlock breaker: held by obstacles (not a light) for a while -> back off, then nose through slowly
    if (want < 0.5 && preObstacle > 3 && !redAhead && Math.abs(sp) < 0.5) this.blocked += dt;
    else this.blocked = Math.max(0, this.blocked - dt);
    if (this.assertive > 0) {
      this.assertive -= dt;
      want = Math.min(preObstacle, 4);
    } else if (this.blocked > 6 + this.rand() * 3) {
      this.blocked = 0;
      this.reverseTimer = 0.9;
      this.assertive = 3;
    }
    // controls
    let steer = Math.max(-1, Math.min(1, (-(overtakeAng ?? ang) * 2.4) / 0.6));
    let throttle = Math.max(-1, Math.min(1, (want - sp) * 0.5));
    if (want < 0.5 && sp < 1) throttle = sp > 0.1 ? -0.4 : 0;
    // stuck handling: reverse out
    if (want > 3 && Math.abs(sp) < 0.6) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt * 2);
    if (this.stuck > 2.2 && this.reverseTimer <= 0) {
      this.reverseTimer = 1.4;
      this.stuck = 0;
      // stuck twice near the same spot: the next waypoints are unreachable from here, skip ahead
      this.recovering = 4;
    }
    if (this.recovering > 0) {
      this.recovering -= dt;
      throttle = Math.min(throttle, 0.45);
    }
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      throttle = -0.8;
      steer = -steer;
    } else if (directTarget && fwd < 0 && Math.hypot(dx, dz) < 25 && sp < 6) {
      // target behind: reverse-turn
      throttle = -0.7;
      steer = angFull > 0 ? 1 : -1;
    }
    v.throttle = throttle;
    v.steerInput = steer;
    v.handbrake = false;
    return want;
  }
}

export { roadHalfWidthX, BLVD_W };
