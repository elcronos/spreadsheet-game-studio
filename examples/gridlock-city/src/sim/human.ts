/** People: the player on foot and pedestrians share one body model. */
import type { StaticGrid } from "./collision";
import { groundHeight } from "./vehicle";

let NEXT_ID = 1;

export type Pose = "stand" | "move" | "jump" | "knocked" | "getup" | "enter";

export interface Look {
  skin: number;
  shirt: number;
  pants: number;
  hair: number;
  shoes: number;
  height: number; // metres
  build: number; // 0.85..1.2 width scale
  hairStyle: number; // 0 short, 1 long, 2 bald, 3 cap
  umbrella?: number;
}

export class Human {
  readonly id = NEXT_ID++;
  x = 0;
  z = 0;
  y = 0;
  vy = 0;
  vx = 0;
  vz = 0;
  heading = 0;
  pose: Pose = "stand";
  /** Locomotion speed used for animation blending (m/s). */
  animSpeed = 0;
  /** Walk cycle phase, radians. */
  phase = 0;
  knockTimer = 0;
  /** Knock-down direction/spin for the fall animation. */
  fallYaw = 0;
  health = 100;
  stamina = 100;
  fleeing = 0;
  lod = 0;
  tag: Record<string, unknown> = {};
  constructor(public look: Look) {}
}

const SKIN = [0x8d5524, 0xc68642, 0xe0ac69, 0xf1c27d, 0xffdbac, 0x5c3a21, 0xa0673f];
const SHIRT = [0xf06292, 0x4fc3f7, 0xffd54f, 0xffffff, 0x81c784, 0xff8a65, 0xba68c8, 0x26a69a, 0xe53935, 0x37474f, 0xfff59d, 0x90caf9];
const PANTS = [0x263238, 0x3e2723, 0x1a237e, 0xd7ccc8, 0x5d4037, 0x455a64, 0xeeeeee, 0x827717];
const HAIR = [0x1b1b1b, 0x3e2723, 0x6d4c41, 0xd4a056, 0xb0b0b0, 0x8d2f1c];
const UMB = [0xe53935, 0x1e88e5, 0xfdd835, 0x43a047, 0x8e24aa, 0x212121];

export function randomLook(r: () => number): Look {
  const p = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  return {
    skin: p(SKIN),
    shirt: p(SHIRT),
    pants: p(PANTS),
    hair: p(HAIR),
    shoes: p([0x212121, 0xffffff, 0x795548, 0xc62828]),
    height: 1.6 + r() * 0.3,
    build: 0.9 + r() * 0.3,
    hairStyle: Math.floor(r() * 4),
    umbrella: p(UMB),
  };
}

export const PLAYER_LOOK: Look = { skin: 0xc68642, shirt: 0x2fd6c8, pants: 0xf3efe6, hair: 0x1b1b1b, shoes: 0xffffff, height: 1.82, build: 1.08, hairStyle: 0 };

/** Integrate movement with a desired planar velocity, gravity, and static collision. */
export function moveHuman(h: Human, wantVX: number, wantVZ: number, dt: number, grid: StaticGrid, gravity: number, accel = 14): void {
  if (h.pose === "knocked" || h.pose === "getup") {
    h.vx *= Math.exp(-2.5 * dt);
    h.vz *= Math.exp(-2.5 * dt);
  } else {
    const k = Math.min(1, accel * dt);
    h.vx += (wantVX - h.vx) * k;
    h.vz += (wantVZ - h.vz) * k;
  }
  h.x += h.vx * dt;
  h.z += h.vz * dt;
  const g = groundHeight(h.x, h.z);
  if (h.y > g + 0.01 || h.vy > 0) {
    h.vy -= gravity * dt;
    h.y += h.vy * dt;
    if (h.y <= g) {
      h.y = g;
      h.vy = 0;
      if (h.pose === "jump") h.pose = "stand";
    }
  } else h.y = g;
  const r = grid.resolveCircle(h.x, h.z, 0.38, true);
  if (r) {
    h.x += r.x;
    h.z += r.z;
    const vn = h.vx * r.nx + h.vz * r.nz;
    if (vn < 0) {
      h.vx -= vn * r.nx;
      h.vz -= vn * r.nz;
    }
  }
  const sp = Math.hypot(h.vx, h.vz);
  h.animSpeed += (sp - h.animSpeed) * Math.min(1, 10 * dt);
  // stride length grows with speed: walk ~1.4 m, sprint ~2.6 m per cycle
  const stride = 1.2 + Math.min(1.6, sp * 0.22);
  h.phase += (sp / stride) * Math.PI * 2 * dt;
  if (sp > 0.15 && h.pose !== "knocked" && h.pose !== "getup") {
    const target = Math.atan2(h.vx, h.vz);
    let d = target - h.heading;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    h.heading += d * Math.min(1, 12 * dt);
  }
  if (h.knockTimer > 0) {
    h.knockTimer -= dt;
    if (h.knockTimer <= 0) {
      if (h.pose === "knocked") {
        h.pose = "getup";
        h.knockTimer = 0.8;
      } else h.pose = "stand";
    }
  }
}

export function knockDown(h: Human, fromVX: number, fromVZ: number, speed: number): void {
  if (h.pose === "knocked") return;
  h.pose = "knocked";
  h.knockTimer = 2.5 + Math.min(3, speed * 0.15);
  const l = Math.hypot(fromVX, fromVZ) || 1;
  h.vx = (fromVX / l) * Math.min(12, speed * 0.8);
  h.vz = (fromVZ / l) * Math.min(12, speed * 0.8);
  h.vy = Math.min(6, speed * 0.35);
  h.y += 0.05;
  h.fallYaw = Math.atan2(fromVX, fromVZ);
}
