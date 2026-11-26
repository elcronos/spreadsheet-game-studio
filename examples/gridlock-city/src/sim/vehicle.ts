/**
 * Arcade vehicle dynamics (see docs/DECISIONS.md ADR-002): a kinematic bicycle
 * model with grip-limited yaw, lateral slip retention (drift), engine curve,
 * reverse, handbrake, ramps/airtime, visual suspension, collisions and damage.
 */
import type { VehicleKind } from "../config";
import { HANDLING } from "../config";
import type { StaticGrid } from "./collision";

export const DIMS: Record<VehicleKind, { length: number; width: number; height: number; wheelbase: number }> = {
  sports: { length: 4.3, width: 1.95, height: 1.2, wheelbase: 2.6 },
  sedan: { length: 4.6, width: 1.85, height: 1.45, wheelbase: 2.75 },
  taxi: { length: 4.7, width: 1.85, height: 1.5, wheelbase: 2.8 },
  police: { length: 4.8, width: 1.95, height: 1.5, wheelbase: 2.85 },
  van: { length: 5.4, width: 2.1, height: 2.45, wheelbase: 3.2 },
};

export interface Params {
  maxSpeed: number; // m/s
  accel: number;
  brake: number;
  steerMul: number;
  traction: number;
  mass: number;
  gravity: number;
  wet: number; // 0..1
}

export interface Dent {
  /** local position (x right, z forward) */
  lx: number;
  lz: number;
  amount: number;
}

let NEXT_ID = 1;

export class Vehicle {
  readonly id = NEXT_ID++;
  x = 0;
  z = 0;
  y = 0;
  vy = 0;
  heading = 0;
  vx = 0;
  vz = 0;
  angVel = 0;
  steer = 0;
  // controls
  throttle = 0;
  steerInput = 0;
  handbrake = false;
  // state
  health: number;
  maxHealth: number;
  fireTimer = -1;
  destroyed = false;
  driver: "player" | "ai" | "none" = "none";
  siren = false;
  braking = false;
  reversing = false;
  pitch = 0;
  roll = 0;
  pitchV = 0;
  rollV = 0;
  wheelSpin = 0;
  dents: Dent[] = [];
  dentVersion = 0;
  airborne = false;
  slip = 0;
  lastImpact = 0;
  /** Simulation level-of-detail: 0 full, 1 reduced rate, 2 frozen. */
  lod = 0;
  lodAcc = 0;
  /** Anything else systems want to hang on the vehicle (AI state etc.). */
  tag: Record<string, unknown> = {};
  colour: number;
  readonly dims: (typeof DIMS)[VehicleKind];

  constructor(public kind: VehicleKind, health: number, colour: number) {
    this.health = this.maxHealth = health;
    this.colour = colour;
    this.dims = DIMS[kind];
  }

  get fx(): number {
    return Math.sin(this.heading);
  }
  get fz(): number {
    return Math.cos(this.heading);
  }
  /** Signed forward speed, m/s. */
  get speed(): number {
    return this.vx * this.fx + this.vz * this.fz;
  }
  get radius(): number {
    return this.dims.width * 0.5;
  }

  /** Collision circles along the car axis (world positions). */
  circles(out: { x: number; z: number; r: number; off: number }[] = []): { x: number; z: number; r: number; off: number }[] {
    const r = this.dims.width * 0.5;
    const h = this.dims.length * 0.5 - r;
    out.length = 0;
    for (const off of [-h, 0, h]) out.push({ x: this.x + this.fx * off, z: this.z + this.fz * off, r, off });
    return out;
  }

  place(x: number, z: number, heading: number): void {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.vx = this.vz = this.angVel = 0;
    this.y = 0;
    this.vy = 0;
  }

  addDamage(amount: number, lx: number, lz: number, invincible = false): void {
    if (this.destroyed || amount <= 0) return;
    if (!invincible) this.health = Math.max(0, this.health - amount);
    if (amount > 12) {
      this.dents.push({ lx, lz, amount: Math.min(1, amount / 160) });
      if (this.dents.length > 8) this.dents.shift();
      this.dentVersion++;
    }
    if (this.health <= 0 && this.fireTimer < 0) this.fireTimer = 4.5;
  }
}

export interface Ramp {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** rising direction: 1 +x, 2 +z, 3 -x, 0 -z */
  dir: number;
  height: number;
}

export const RAMPS: Ramp[] = [
  { x0: 228, x1: 244, z0: 96, z1: 106, dir: 1, height: 2.2 }, // beach dune kicker
  { x0: 232, x1: 248, z0: -126, z1: -116, dir: 3, height: 1.8 },
  { x0: 70, x1: 82, z0: 125, z1: 133, dir: 1, height: 1.6 }, // parking lot ramp
];

/** Ground height at (x, z). Another game can swap in its own terrain with setGroundHeight. */
export function groundHeight(x: number, z: number): number {
  return groundFn(x, z);
}
let groundFn = rampHeight;
export function setGroundHeight(fn: ((x: number, z: number) => number) | null): void {
  groundFn = fn ?? rampHeight;
}
function rampHeight(x: number, z: number): number {
  for (const r of RAMPS) {
    if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue;
    const u = r.dir === 1 ? (x - r.x0) / (r.x1 - r.x0) : r.dir === 3 ? (r.x1 - x) / (r.x1 - r.x0) : r.dir === 2 ? (z - r.z0) / (r.z1 - r.z0) : (r.z1 - z) / (r.z1 - r.z0);
    return u * r.height;
  }
  return 0;
}

export function handlingFor(kind: VehicleKind, num: (k: string) => number, gravity: number, wet: number): Params {
  return {
    maxSpeed: num(`veh.${kind}.maxSpeed`) / 3.6,
    accel: num(`veh.${kind}.accel`),
    brake: num(`veh.${kind}.brake`),
    steerMul: num(`veh.${kind}.steer`),
    traction: num(`veh.${kind}.traction`),
    mass: num(`veh.${kind}.mass`),
    gravity,
    wet,
  };
}

export const BASE_STEER: Record<VehicleKind, number> = Object.fromEntries(Object.entries(HANDLING).map(([k, h]) => [k, h.steer])) as Record<VehicleKind, number>;

/** Wall friction grows with how hard the car is pressed into the wall. */
function impactSpeedForFriction(vn: number): number {
  return Math.min(20, -vn * 4);
}

export interface ImpactEvent {
  x: number;
  z: number;
  speed: number;
  vehicle: Vehicle;
  other?: Vehicle;
}

const circ: { x: number; z: number; r: number; off: number }[] = [];

export function stepVehicle(v: Vehicle, p: Params, dt: number, grid: StaticGrid, onImpact: (e: ImpactEvent) => void, invincible = false): void {
  if (v.driver === "none") v.braking = false;
  if (v.destroyed) {
    v.vx *= Math.exp(-3 * dt);
    v.vz *= Math.exp(-3 * dt);
    v.x += v.vx * dt;
    v.z += v.vz * dt;
    return;
  }
  const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
  const rx = -fz, rz = fx;
  let vF = v.vx * fx + v.vz * fz;
  let vR = v.vx * rx + v.vz * rz;
  const prevVF = vF, prevVR = vR;
  const ground = groundHeight(v.x, v.z);
  v.airborne = v.y > ground + 0.08;
  const dead = v.health <= 0;
  const thr = dead ? 0 : v.throttle;
  v.braking = false;
  v.reversing = false;
  if (!v.airborne) {
    if (thr > 0) {
      if (vF < -0.5) {
        vF = Math.min(0, vF + p.brake * thr * dt);
        v.braking = true;
      } else {
        const k = Math.max(0, 1 - Math.max(0, vF) / p.maxSpeed);
        vF += p.accel * thr * (0.35 + 0.65 * Math.sqrt(k)) * dt * (k > 0 ? 1 : 0);
      }
    } else if (thr < 0) {
      if (vF > 0.5) {
        vF = Math.max(0, vF + p.brake * thr * dt);
        v.braking = true;
      } else {
        v.reversing = true;
        if (vF > -p.maxSpeed * 0.3) vF += p.accel * 0.6 * thr * dt;
      }
    }
    // rolling resistance + aero drag
    const drag = 0.9 + 0.0009 * vF * vF;
    if (Math.abs(vF) <= drag * dt) vF = thr === 0 ? 0 : vF;
    else vF -= Math.sign(vF) * drag * dt;
    if (vF > p.maxSpeed * 1.02) vF -= (vF - p.maxSpeed) * 2 * dt;
    if (v.handbrake) {
      const hb = Math.min(Math.abs(vF), 7 * dt);
      vF -= Math.sign(vF) * hb;
      v.braking = v.driver !== "none";
    }
  }
  // steering
  const speedK = 1 / (1 + Math.abs(vF) / 24);
  const maxSteer = BASE_STEER[v.kind] * p.steerMul;
  const target = (dead ? 0 : v.steerInput) * maxSteer * speedK;
  v.steer += (target - v.steer) * Math.min(1, 6 * dt);
  // yaw
  let grip = p.traction * (1 - 0.25 * p.wet);
  const onSand = v.x > 201 && v.x < 272 && Math.abs(v.z) > 7;
  if (onSand) grip *= 0.7;
  if (v.handbrake) grip *= 0.32;
  if (!v.airborne) {
    const yawTarget = (vF / v.dims.wheelbase) * Math.tan(v.steer) * (v.handbrake ? 1.45 : 1);
    v.angVel += (yawTarget - v.angVel) * Math.min(1, grip * 7 * dt);
  } else v.angVel *= Math.exp(-0.5 * dt);
  v.heading += v.angVel * dt;
  if (!v.airborne) vR *= Math.exp(-grip * 6.5 * dt);
  v.slip = Math.abs(vR);
  // recombine with the new heading
  const nfx = Math.sin(v.heading), nfz = Math.cos(v.heading);
  const nrx = -nfz, nrz = nfx;
  v.vx = nfx * vF + nrx * vR;
  v.vz = nfz * vF + nrz * vR;
  // sand drag
  if (onSand && !v.airborne) {
    v.vx *= Math.exp(-0.25 * dt);
    v.vz *= Math.exp(-0.25 * dt);
  }
  v.x += v.vx * dt;
  v.z += v.vz * dt;
  // vertical
  const g2 = groundHeight(v.x, v.z);
  if (v.airborne || v.y > g2 + 0.08) {
    v.vy -= p.gravity * dt;
    v.y += v.vy * dt;
    if (v.y <= g2) {
      if (v.vy < -6) v.addDamage((-v.vy - 6) * 12, 0, 0, invincible);
      v.pitchV += v.vy * 0.05;
      v.y = g2;
      v.vy = 0;
    }
  } else {
    // follow ramps; launch when leaving the top
    const climb = (g2 - v.y) / Math.max(dt, 1e-4);
    v.y = g2;
    v.vy = climb > 0 ? climb : 0;
    if (g2 === 0 && climb < 0) v.vy = 0;
  }
  // suspension visuals
  const aLong = (vF - prevVF) / dt, aLat = (vR - prevVR) / dt + vF * v.angVel;
  const tp = Math.max(-0.12, Math.min(0.12, -aLong * 0.008)), tr = Math.max(-0.1, Math.min(0.1, aLat * 0.009));
  v.pitchV += (tp - v.pitch) * 60 * dt - v.pitchV * 9 * dt;
  v.rollV += (tr - v.roll) * 60 * dt - v.rollV * 9 * dt;
  v.pitch += v.pitchV * dt;
  v.roll += v.rollV * dt;
  v.wheelSpin += (vF / 0.34) * dt;
  // static collisions
  v.circles(circ);
  let best: { nx: number; nz: number; depth: number; off: number } | null = null;
  let px = 0, pz = 0;
  for (const c of circ) {
    const r = grid.resolveCircle(c.x, c.z, c.r, true);
    if (r) {
      if (Math.abs(r.x) > Math.abs(px)) px = r.x;
      if (Math.abs(r.z) > Math.abs(pz)) pz = r.z;
      if (!best || r.depth > best.depth) best = { nx: r.nx, nz: r.nz, depth: r.depth, off: c.off };
    }
  }
  if (best) {
    v.x += px;
    v.z += pz;
    const vn = v.vx * best.nx + v.vz * best.nz;
    if (vn < 0) {
      const e = 0.25;
      v.vx -= (1 + e) * vn * best.nx;
      v.vz -= (1 + e) * vn * best.nz;
      // friction along the wall
      const tx = -best.nz, tz = best.nx;
      const vt = v.vx * tx + v.vz * tz;
      const fr = Math.min(1, (impactSpeedForFriction(vn) + 2.5) * dt);
      v.vx -= vt * fr * tx;
      v.vz -= vt * fr * tz;
      // spin from off-centre hits
      const cross = (nfx * best.off) * best.nz - (nfz * best.off) * best.nx;
      v.angVel += cross * vn * 0.04;
      const impact = -vn;
      if (impact > 3.5) {
        const lx = -(best.nx * nrx + best.nz * nrz) * v.dims.width * 0.5;
        const lz = best.off - (best.nx * nfx + best.nz * nfz) * 0.5;
        v.addDamage((impact - 3) ** 1.5 * 5 * (p.mass / 1500), lx, lz, invincible);
        v.lastImpact = impact;
        onImpact({ x: v.x - best.nx * v.dims.width * 0.5, z: v.z - best.nz * v.dims.width * 0.5, speed: impact, vehicle: v });
      }
    }
  }
  if (v.fireTimer > 0) {
    v.fireTimer -= dt;
    if (v.fireTimer <= 0) v.destroyed = true;
  }
}

/** Vehicle-vehicle collision with mass-weighted impulses. */
export function collideVehicles(a: Vehicle, b: Vehicle, ma: number, mb: number, onImpact: (e: ImpactEvent) => void, invA = false, invB = false, rand: () => number = Math.random): void {
  const ca = a.circles([]), cb = b.circles([]);
  let best: { nx: number; nz: number; depth: number; x: number; z: number; offA: number; offB: number } | null = null;
  for (const p of ca)
    for (const q of cb) {
      const dx = p.x - q.x, dz = p.z - q.z;
      const rr = p.r + q.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const depth = rr - d;
      if (!best || depth > best.depth) best = { nx: dx / d, nz: dz / d, depth, x: (p.x + q.x) / 2, z: (p.z + q.z) / 2, offA: p.off, offB: q.off };
    }
  if (!best) return;
  const ia = 1 / ma, ib = 1 / mb, it = ia + ib;
  a.x += best.nx * best.depth * (ia / it);
  a.z += best.nz * best.depth * (ia / it);
  b.x -= best.nx * best.depth * (ib / it);
  b.z -= best.nz * best.depth * (ib / it);
  const rvx = a.vx - b.vx, rvz = a.vz - b.vz;
  const vn = rvx * best.nx + rvz * best.nz;
  if (vn >= 0) return;
  const e = 0.3;
  const j = (-(1 + e) * vn) / it;
  a.vx += j * ia * best.nx;
  a.vz += j * ia * best.nz;
  b.vx -= j * ib * best.nx;
  b.vz -= j * ib * best.nz;
  a.angVel += (rand() - 0.5) * -vn * 0.03;
  b.angVel += (rand() - 0.5) * -vn * 0.03;
  const impact = -vn;
  if (impact > 3) {
    const dmg = (impact - 2.5) ** 1.45 * 3.3;
    a.addDamage(dmg * (mb / (ma + mb)) * 2, -best.nx, best.offA, invA);
    b.addDamage(dmg * (ma / (ma + mb)) * 2, best.nx, best.offB, invB);
    a.lastImpact = b.lastImpact = impact;
    onImpact({ x: best.x, z: best.z, speed: impact, vehicle: a, other: b });
  }
}
