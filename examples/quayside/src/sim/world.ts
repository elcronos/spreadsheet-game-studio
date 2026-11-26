/**
 * Quayside simulation (DOM-free): the player on foot, cars on the real street network
 * (driving on the left), two ferries on the real Elizabeth Quay to Mends Street route,
 * stealing cars and the ferry, river and road police, heat, missions.
 * World axes: x east, z south (z = -north), y up. Heading h: forward = (sin h, cos h);
 * a positive steer turns left (heading increases).
 */
import type { InputState } from "../../../../engines/core/input";
import type { VariableRegistry } from "../../../../engines/core/variables";
import { Human, PLAYER_LOOK, knockDown, moveHuman, randomLook } from "../../../gridlock-city/src/sim/human";
import { Vehicle, collideVehicles, handlingFor, setGroundHeight, stepVehicle } from "../../../gridlock-city/src/sim/vehicle";
import type { VehicleKind } from "../../../gridlock-city/src/config";
import type { StaticGrid } from "../../../gridlock-city/src/sim/collision";
import { CITY, G, LM, Raster } from "../map";
import { RasterCollider } from "./collide";

const KN = 0.5144;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const W = (x: number, y: number): [number, number] => [x, -y];

export type Mode = "foot" | "car" | "passenger" | "helm";

export class Boat {
  x = 0;
  z = 0;
  heading = 0;
  speed = 0;
  angVel = 0;
  throttle = 0;
  steer = 0;
  health = 1000;
  driver: "ai" | "player" | "none" = "ai";
  /** Ferry AI: path, direction and timers. */
  path: [number, number][] = [];
  idx = 0;
  state: "docked" | "sailing" = "docked";
  dwell = 0;
  atEQ = true;
  stuck = 0;
  constructor(readonly kind: "ferry" | "police", readonly length: number, readonly beam: number) {}
}

interface Traffic {
  v: Vehicle;
  path: [number, number][];
  idx: number;
  node: string;
  stuck: number;
  blocked: number;
  creep: number;
  police?: boolean;
}

export interface Mission {
  id: "crossing" | "heist";
  title: string;
  objective: string;
  timer: number;
  done: boolean;
}

export interface Event {
  t: number;
  kind: string;
  text: string;
}

// ------------------------------------------------------------------------------------- road graph
interface Edge {
  pts: [number, number][];
  a: string;
  b: string;
  speed: number;
}
const key = (p: [number, number]) => `${Math.round(p[0] / 4)},${Math.round(p[1] / 4)}`;

function buildGraph(): { edges: Edge[]; out: Map<string, number[]> } {
  const edges: Edge[] = [];
  const out = new Map<string, number[]>();
  const add = (pts: [number, number][], speed: number) => {
    const e = { pts, a: key(pts[0]), b: key(pts[pts.length - 1]), speed };
    edges.push(e);
    if (!out.has(e.a)) out.set(e.a, []);
    out.get(e.a)!.push(edges.length - 1);
  };
  for (const r of CITY.roads) {
    if (r.pts.length < 2 || ["motorway", "motorway_link", "trunk_link"].includes(r.hw)) continue;
    const pts = r.pts.map(([x, y]) => W(x, y));
    const speed = r.hw === "primary" || r.hw === "trunk" ? 14 : r.hw === "secondary" ? 12 : 9;
    add(pts, speed);
    if (!r.oneway) add(pts.slice().reverse(), speed);
  }
  return { edges, out };
}

export class World {
  readonly land: RasterCollider;
  readonly water: RasterCollider;
  readonly player = new Human(PLAYER_LOOK);
  mode: Mode = "foot";
  car: Vehicle | null = null;
  boat: Boat | null = null;
  readonly cars: Traffic[] = [];
  readonly parked: Vehicle[] = [];
  readonly ferries: Boat[] = [];
  readonly police: Boat[] = [];
  readonly people: Human[] = [];
  readonly graph = buildGraph();
  camYaw = 0;
  t = 0;
  hint = "";
  banner = "";
  bannerT = 0;
  mission: Mission | null = null;
  events: Event[] = [];
  bustedT = 0;
  seenT = 0;
  private eqBerth: [number, number];
  readonly mendsBerth: [number, number];
  private route: [number, number][];
  private bridge: [number, number, number][] = [];

  constructor(readonly raster: Raster, readonly reg: VariableRegistry, readonly rand: () => number) {
    this.land = new RasterCollider(raster, "land");
    this.water = new RasterCollider(raster, "water");
    // EQ footbridge deck: ground height rises over the inlet mouth (for walking across it)
    const bp = LM.eqBridge.pts.map(([x, y]) => W(x, y));
    let total = 0;
    const lens = [0];
    for (let i = 1; i < bp.length; i++) lens.push((total += Math.hypot(bp[i][0] - bp[i - 1][0], bp[i][1] - bp[i - 1][1])));
    for (let i = 0; i < bp.length; i++) this.bridge.push([bp[i][0], bp[i][1], 1.4 + 4.6 * Math.sin((Math.PI * lens[i]) / total)]);
    setGroundHeight((x, z) => this.groundAt(x, z));
    this.eqBerth = this.findBerth(...W(LM.eqFerry.x, LM.eqFerry.y));
    this.mendsBerth = this.findBerth(...W(LM.mendsFerry.x, LM.mendsFerry.y));
    const r = LM.ferryRoute.pts.map(([x, y]) => W(x, y));
    const d0 = Math.hypot(r[0][0] - this.eqBerth[0], r[0][1] - this.eqBerth[1]);
    const d1 = Math.hypot(r[r.length - 1][0] - this.eqBerth[0], r[r.length - 1][1] - this.eqBerth[1]);
    this.route = [this.eqBerth, ...(d0 < d1 ? r : r.reverse()).filter((p) => raster.isWater(p[0], p[1])), this.mendsBerth];
    this.reset();
  }

  reset(): void {
    const [sx, sz] = W(LM.spanda.x + 12, LM.spanda.y + 18);
    Object.assign(this.player, { x: sx, z: sz, y: 0, vx: 0, vz: 0, heading: Math.PI, pose: "stand" });
    this.camYaw = Math.PI; // looking south over the inlet towards the river
    this.mode = "foot";
    this.car = this.boat = null;
    this.cars.length = this.parked.length = this.ferries.length = this.police.length = this.people.length = 0;
    // two ferries, one at each end, so one is always on its way
    for (const atEQ of [true, false]) {
      const f = new Boat("ferry", 22, 7.2);
      const [x, z] = atEQ ? this.eqBerth : this.mendsBerth;
      Object.assign(f, { x, z, atEQ, state: "docked", dwell: atEQ ? 8 : 20 });
      f.path = atEQ ? this.route : this.route.slice().reverse();
      f.heading = Math.atan2(f.path[1][0] - f.path[0][0], f.path[1][1] - f.path[0][1]);
      this.ferries.push(f);
    }
    // parked cars to steal near the quay (on The Esplanade and Barrack Street kerbs)
    const spots: [VehicleKind, number, number, number][] = [
      ["sports", 150, 610, 0xd7263d], ["sedan", 60, 652, 0x2e86ab], ["taxi", 250, 470, 0xf6c445], ["sports", 300, 600, 0x1b998b],
    ];
    for (const [kind, x, y, col] of spots) {
      const [rx, rz] = this.nearestFree(...W(x, y), "road");
      const h = this.roadHeadingNear(rx, rz);
      // pull over to the left kerb, off the lanes
      let off = 6;
      while (off > 2 && this.land.blockedAt(rx + Math.cos(h) * off, rz - Math.sin(h) * off)) off -= 0.5;
      const v = new Vehicle(kind, this.reg.num(`veh.${kind}.health`), col);
      Object.assign(v, { x: rx + Math.cos(h) * off, z: rz - Math.sin(h) * off, heading: h });
      this.parked.push(v);
    }
    this.mission = null;
    this.reg.setLive("player.heat", 0);
    this.reg.setLive("player.health", 100);
  }

  // ------------------------------------------------------------------------------- map helpers
  groundAt(x: number, z: number): number {
    const c = this.raster.at(x, z);
    if (c === G.PIER) return 0.75;
    if (c !== G.PATH && c !== G.WATER && c !== G.FOOTBRIDGE) return 0;
    // on the footbridge?
    let best = 1e9, h = 0;
    for (let i = 1; i < this.bridge.length; i++) {
      const [ax, az, ah] = this.bridge[i - 1], [bx, bz, bh] = this.bridge[i];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const d = Math.hypot(x - ax - dx * u, z - az - dz * u);
      if (d < best) [best, h] = [d, ah + (bh - ah) * u];
    }
    return best < 3 ? h : 0;
  }

  where(x: number, z: number): string {
    const y = -z;
    if (this.raster.isWater(x, z)) return y < 150 && y > -850 ? "Perth Water (Swan River)" : "Swan River";
    if (Math.hypot(x - LM.eqFerry.x, y - LM.eqFerry.y) < 220) return "Elizabeth Quay";
    if (Math.hypot(x - LM.mendsFerry.x, y - LM.mendsFerry.y) < 260) return "South Perth, Mends Street";
    if (y > 560) return "Perth CBD";
    if (x > 300) return "Riverside Drive";
    if (y < -500) return "South Perth";
    return "Mounts Bay";
  }

  /** A water point near (x, z) with at least 4 m of water around it (for berths). */
  findBerth(x: number, z: number): [number, number] {
    for (let r = 3; r < 60; r += 1)
      for (let a = 0; a < 32; a++) {
        const px = x + Math.cos((a / 32) * Math.PI * 2) * r, pz = z + Math.sin((a / 32) * Math.PI * 2) * r;
        let ok = true;
        for (let b = 0; b < 12 && ok; b++) ok = this.raster.isWater(px + Math.cos(b * 0.52) * 4.5, pz + Math.sin(b * 0.52) * 4.5);
        if (ok) return [px, pz];
      }
    return [x, z];
  }

  nearestFree(x: number, z: number, want: "road" | "walk"): [number, number] {
    const ok = (c: number) => (want === "road" ? c === G.ROAD || c === G.ROAD_MAJOR : c !== G.WATER && c !== G.BUILDING);
    for (let r = 0; r < 80; r += 1)
      for (let a = 0; a < 16; a++) {
        const px = x + Math.cos((a / 16) * Math.PI * 2) * r, pz = z + Math.sin((a / 16) * Math.PI * 2) * r;
        if (ok(this.raster.at(px, pz)) && (want === "walk" || ok(this.raster.at(px + 1.5, pz)) && ok(this.raster.at(px - 1.5, pz)))) return [px, pz];
      }
    return [x, z];
  }

  roadHeadingNear(x: number, z: number): number {
    let best = 1e9, h = 0;
    for (const e of this.graph.edges)
      for (let i = 1; i < e.pts.length; i++) {
        const [ax, az] = e.pts[i - 1], [bx, bz] = e.pts[i];
        const d = Math.hypot((ax + bx) / 2 - x, (az + bz) / 2 - z);
        if (d < best) [best, h] = [d, Math.atan2(bx - ax, bz - az)];
      }
    return h;
  }

  private say(kind: string, text: string, banner = false): void {
    this.events.push({ t: this.t, kind, text });
    if (this.events.length > 30) this.events.shift();
    if (banner) {
      this.banner = text;
      this.bannerT = 3.5;
    }
  }

  get heat(): number {
    return this.reg.num("player.heat");
  }
  setHeat(v: number): void {
    this.reg.setLive("player.heat", Math.max(0, Math.min(5, v)));
    this.reg.recomputeRules();
  }

  focus(): [number, number] {
    if (this.mode === "car" && this.car) return [this.car.x, this.car.z];
    if ((this.mode === "passenger" || this.mode === "helm") && this.boat) return [this.boat.x, this.boat.z];
    return [this.player.x, this.player.z];
  }

  // ------------------------------------------------------------------------------- step
  step(dt: number, input: InputState): void {
    this.t += dt;
    const reg = this.reg;
    reg.setLive("world.time", (reg.num("world.time") + (dt * reg.num("world.timeScale")) / 60) % 24);
    if (this.bannerT > 0) this.bannerT -= dt;
    if (input.pressed("restart")) {
      this.reset();
      return;
    }
    this.hint = "";
    if (this.mode === "foot") this.stepFoot(dt, input);
    else if (this.mode === "car") this.stepDriving(dt, input);
    else if (this.mode === "helm") this.stepHelm(dt, input);
    else this.stepPassenger(input);
    this.stepFerries(dt);
    this.stepTraffic(dt);
    this.stepPolice(dt);
    this.stepPeople(dt);
    this.stepMission(dt);
    const [fx, fz] = this.focus();
    reg.setLive("player.where", this.where(fx, fz));
    reg.setLive("player.mode", this.mode === "foot" ? "on foot" : this.mode === "car" ? `driving a ${this.car?.kind}` : this.mode === "helm" ? "at the helm of a stolen ferry" : "riding the ferry");
    if (reg.num("player.health") <= 0) this.wasted();
  }

  private stepFoot(dt: number, input: InputState): void {
    const pl = this.player, reg = this.reg;
    const fwd = input.combined("down", "up"), side = input.combined("left", "right");
    const mag = Math.min(1, Math.hypot(fwd, side));
    const sprint = input.held("sprint");
    const base = (sprint ? 7.0 : 4.0) * reg.num("player.speed");
    const cf = { x: Math.sin(this.camYaw), z: Math.cos(this.camYaw) }, cr = { x: -cf.z, z: cf.x };
    let wx = cf.x * fwd + cr.x * side, wz = cf.z * fwd + cr.z * side;
    const l = Math.hypot(wx, wz) || 1;
    wx = (wx / l) * base * mag;
    wz = (wz / l) * base * mag;
    if (pl.pose === "knocked" || pl.pose === "getup") wx = wz = 0;
    moveHuman(pl, wx, wz, dt, this.land as unknown as StaticGrid, 9.81);
    if (pl.pose === "stand" && mag > 0.05) pl.pose = "move";
    if (pl.pose === "move" && mag <= 0.05 && Math.hypot(pl.vx, pl.vz) < 0.2) pl.pose = "stand";
    // nearest thing to use
    const car = this.nearestCar(pl.x, pl.z, 3.2);
    const ferry = this.ferries.find((f) => Math.hypot(f.x - pl.x, f.z - pl.z) < f.length * 0.85 && f.driver !== "player");
    if (ferry && ferry.state === "docked") {
      this.hint = `F  Board the ferry ($${reg.num("ferry.fare").toFixed(2)})    G  Steal the ferry`;
      if (input.pressed("enter")) this.board(ferry, false);
      else if (input.pressed("hijack")) this.board(ferry, true);
    } else if (ferry) {
      this.hint = "G  Jump aboard and steal the ferry";
      if (input.pressed("hijack")) this.board(ferry, true);
    } else if (car) {
      this.hint = `F  ${car.driver === "ai" ? "Pull the driver out and take the car" : "Take the car"}`;
      if (input.pressed("enter")) this.enterCar(car);
    }
  }

  private nearestCar(x: number, z: number, r: number): Vehicle | null {
    let best: Vehicle | null = null, bd = r;
    for (const v of [...this.parked, ...this.cars.map((c) => c.v)]) {
      const d = Math.hypot(v.x - x, v.z - z);
      if (d < bd && !v.destroyed) [best, bd] = [v, d];
    }
    return best;
  }

  private enterCar(v: Vehicle): void {
    const ti = this.cars.findIndex((c) => c.v === v);
    if (ti >= 0) {
      const tr = this.cars.splice(ti, 1)[0];
      // the driver gets out and runs
      const h = new Human(randomLook(this.rand));
      const [ex, ez] = this.nearestFree(v.x + Math.cos(v.heading) * 2, v.z - Math.sin(v.heading) * 2, "walk");
      Object.assign(h, { x: ex, z: ez, heading: v.heading + Math.PI / 2, pose: "move", fleeing: 6 });
      this.people.push(h);
      this.setHeat(Math.max(this.heat, tr.police ? 3 : 1) + (tr.police ? 0 : 0.5));
      this.say("crime", "Carjacking reported", false);
    } else {
      const pi = this.parked.indexOf(v);
      if (pi >= 0) this.parked.splice(pi, 1);
      if (this.rand() < 0.5) this.setHeat(Math.max(this.heat, 1));
    }
    v.driver = "player";
    this.car = v;
    this.mode = "car";
  }

  private exitCar(): void {
    const v = this.car!;
    v.driver = "none";
    v.throttle = v.steerInput = 0;
    const side = [Math.cos(v.heading) * 2.2, -Math.sin(v.heading) * 2.2];
    let [x, z] = [v.x + side[0], v.z + side[1]];
    if (this.land.blockedAt(x, z)) [x, z] = [v.x - side[0], v.z - side[1]];
    [x, z] = this.nearestFree(x, z, "walk");
    Object.assign(this.player, { x, z, y: this.groundAt(x, z), vx: 0, vz: 0, heading: v.heading, pose: "stand" });
    this.parked.push(v);
    this.car = null;
    this.mode = "foot";
  }

  private stepDriving(dt: number, input: InputState): void {
    const v = this.car!, reg = this.reg;
    v.throttle = input.combined("down", "up");
    v.steerInput = Math.max(-1, Math.min(1, input.combined("right", "left")));
    v.handbrake = input.held("handbrake");
    stepVehicle(v, handlingFor(v.kind, (k) => reg.num(k), 9.81, 0), dt, this.land as unknown as StaticGrid, (e) => this.onImpact(e.speed, e.other), reg.bool("player.invincible"));
    this.camYaw += wrap(v.heading - this.camYaw) * Math.min(1, dt * 3);
    // run people over: knocked down, heat
    for (const h of this.people)
      if (h.pose !== "knocked" && Math.hypot(h.x - v.x, h.z - v.z) < 1.8 && Math.hypot(v.vx, v.vz) > 4) {
        knockDown(h, v.vx, v.vz, Math.hypot(v.vx, v.vz));
        this.setHeat(this.heat + 1);
        this.say("crime", "Pedestrian hit", false);
      }
    if (input.pressed("enter") && Math.hypot(v.vx, v.vz) < 6) this.exitCar();
  }

  private onImpact(speed: number, other?: Vehicle): void {
    if (other && this.cars.find((c) => c.v === other)?.police && speed > 5) this.setHeat(Math.max(this.heat, 2) + 0.5);
    if (speed > 14 && !this.reg.bool("player.invincible")) this.reg.setLive("player.health", this.reg.num("player.health") - (speed - 14) * 1.5);
  }

  // ------------------------------------------------------------------------------- ferries
  private board(f: Boat, hijack: boolean): void {
    this.boat = f;
    if (hijack) {
      f.driver = "player";
      f.state = "sailing";
      this.mode = "helm";
      this.camYaw = f.heading;
      this.setHeat(Math.max(this.heat, 3));
      this.say("crime", "FERRY HIJACKED", true);
      if (!this.mission || this.mission.done) this.mission = { id: "heist", title: "Swan River Heist", objective: "Take the stolen ferry to Mends Street Jetty", timer: 240, done: false };
    } else {
      const fare = this.reg.num("ferry.fare");
      this.reg.setLive("player.cash", Math.max(0, this.reg.num("player.cash") - fare));
      this.mode = "passenger";
      this.camYaw = f.heading;
      if (!this.mission || this.mission.done) this.mission = { id: "crossing", title: "The Ten-Minute Crossing", objective: f.atEQ ? "Ride the ferry to South Perth" : "Ride the ferry to Elizabeth Quay", timer: 0, done: false };
      this.say("info", "Welcome aboard", false);
    }
  }

  private disembark(): void {
    const f = this.boat!;
    let best: [number, number] = [f.x, f.z], bd = 1e9;
    for (let r = 4; r < 30; r += 1.5)
      for (let a = 0; a < 24; a++) {
        const x = f.x + Math.cos((a / 24) * 6.283) * r, z = f.z + Math.sin((a / 24) * 6.283) * r;
        if (!this.land.blockedAt(x, z) && !this.land.blockedAt(x + 0.6, z) && !this.land.blockedAt(x, z + 0.6) && r < bd) [best, bd] = [[x, z], r];
      }
    Object.assign(this.player, { x: best[0], z: best[1], y: this.groundAt(best[0], best[1]), vx: 0, vz: 0, pose: "stand" });
    if (f.driver === "player") {
      f.driver = "none";
      f.throttle = f.steer = 0;
    }
    this.boat = null;
    this.mode = "foot";
  }

  private stepPassenger(input: InputState): void {
    const f = this.boat!;
    this.player.x = f.x;
    this.player.z = f.z;
    this.camYaw += wrap(f.heading + Math.PI * 0.75 - this.camYaw) * 0.01; // a slow look along the river
    if (f.state === "docked") {
      this.hint = "F  Get off the ferry    G  Take the helm";
      if (input.pressed("enter")) this.disembark();
      else if (input.pressed("hijack")) this.board(f, true);
    } else this.hint = "G  Storm the wheelhouse and steal the ferry";
    if (input.pressed("hijack") && f.state !== "docked") this.board(f, true);
  }

  private stepHelm(dt: number, input: InputState): void {
    const f = this.boat!;
    f.throttle = input.combined("down", "up");
    f.steer = input.combined("right", "left");
    this.stepBoat(f, dt, this.reg.num("ferry.helmSpeed") * KN, 2.2, 0.32);
    this.camYaw += wrap(f.heading - this.camYaw) * Math.min(1, dt * 1.5);
    this.player.x = f.x;
    this.player.z = f.z;
    const nearLand = this.disembarkable(f);
    this.hint = nearLand && Math.abs(f.speed) < 3 ? "F  Jump ashore" : "";
    if (input.pressed("enter") && nearLand && Math.abs(f.speed) < 3) this.disembark();
  }

  private disembarkable(f: Boat): boolean {
    for (let a = 0; a < 16; a++)
      for (const r of [6, 9, 12])
        if (!this.land.blockedAt(f.x + Math.cos(a * 0.39) * r, f.z + Math.sin(a * 0.39) * r)) return true;
    return false;
  }

  /** Simple boat dynamics: thrust, quadratic drag, speed-dependent turning, raster collisions. */
  stepBoat(b: Boat, dt: number, vmax: number, accel: number, turnRate: number): void {
    const drag = accel / (vmax * vmax);
    b.speed += (b.throttle * accel * (b.throttle < 0 ? 0.5 : 1) - drag * b.speed * Math.abs(b.speed) - Math.sign(b.speed) * 0.15) * dt;
    if (Math.abs(b.speed) < 0.05 && b.throttle === 0) b.speed = 0;
    const authority = Math.min(1, Math.abs(b.speed) / 4 + 0.15) * Math.sign(b.speed || 1);
    b.angVel += (b.steer * turnRate * authority - b.angVel) * Math.min(1, dt * 1.8);
    b.heading = wrap(b.heading + b.angVel * dt);
    const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
    b.x += fx * b.speed * dt;
    b.z += fz * b.speed * dt;
    // hull as two circles (bow, stern)
    for (const off of [b.length * 0.33, -b.length * 0.33]) {
      const cx = b.x + fx * off, cz = b.z + fz * off;
      const hit = this.water.resolveCircle(cx, cz, b.beam * 0.55);
      if (hit) {
        b.x += hit.x;
        b.z += hit.z;
        const vn = Math.abs(b.speed);
        if (vn > 2.5) b.health -= vn * 6;
        b.speed *= 0.55;
        b.angVel += (off > 0 ? 1 : -1) * Math.sign(hit.nx * fz - hit.nz * fx) * 0.2;
      }
    }
  }

  private stepFerries(dt: number): void {
    const reg = this.reg, cruise = reg.num("ferry.speed") * KN;
    for (const f of this.ferries) {
      if (f.driver === "player") continue;
      if (f.driver === "none") {
        // abandoned stolen ferry drifts to a stop
        f.throttle = f.steer = 0;
        this.stepBoat(f, dt, cruise, 1.2, 0.25);
        continue;
      }
      if (f.state === "docked") {
        f.speed = 0;
        f.dwell -= dt;
        if (f.dwell <= 0) {
          f.state = "sailing";
          f.idx = 1;
        }
        continue;
      }
      // pure pursuit along the route
      const end = f.path[f.path.length - 1];
      while (f.idx < f.path.length - 1 && Math.hypot(f.path[f.idx][0] - f.x, f.path[f.idx][1] - f.z) < 22) f.idx++;
      const tgt = f.path[f.idx];
      const want = Math.atan2(tgt[0] - f.x, tgt[1] - f.z);
      f.steer = Math.max(-1, Math.min(1, wrap(want - f.heading) * 2.2));
      const dEnd = Math.hypot(end[0] - f.x, end[1] - f.z);
      const vt = cruise * Math.max(0.12, Math.min(1, dEnd / 90)) * (Math.abs(wrap(want - f.heading)) > 0.8 ? 0.4 : 1);
      f.throttle = Math.max(-1, Math.min(1, (vt - f.speed) * 0.8));
      this.stepBoat(f, dt, cruise * 1.15, 1.4, 0.3);
      if (dEnd < 7 && Math.abs(f.speed) < 1.6) {
        f.state = "docked";
        f.dwell = reg.num("ferry.dwell");
        f.atEQ = !f.atEQ;
        f.path = f.atEQ ? this.route : this.route.slice().reverse();
        f.idx = 1;
        if (this.boat === f && this.mode === "passenger" && this.mission?.id === "crossing" && !this.mission.done) {
          this.mission.done = true;
          this.reg.setLive("player.cash", this.reg.num("player.cash") + 50);
          this.say("mission", `CROSSING COMPLETE  +$50`, true);
        }
      }
    }
  }

  // ------------------------------------------------------------------------------- traffic
  private spawnTraffic(police: boolean): void {
    const [px, pz] = this.focus();
    const g = this.graph;
    for (let tries = 0; tries < 30; tries++) {
      const ei = Math.floor(this.rand() * g.edges.length), e = g.edges[ei];
      const i = Math.floor(this.rand() * (e.pts.length - 1));
      const [x, z] = e.pts[i];
      const d = Math.hypot(x - px, z - pz);
      if (d < (police ? 90 : 70) || d > (police ? 200 : 380)) continue;
      if (this.cars.some((c) => Math.hypot(c.v.x - x, c.v.z - z) < 12)) continue;
      const kinds: VehicleKind[] = ["sedan", "sedan", "taxi", "van", "sedan", "sports"];
      const kind = police ? "police" : kinds[Math.floor(this.rand() * kinds.length)];
      const colours = [0xf2f2f2, 0x1d1d1f, 0x8a8f98, 0x2e5c8a, 0x9b1d20, 0x41644a, 0xd9c8a0];
      const v = new Vehicle(kind, this.reg.num(`veh.${kind}.health`), kind === "taxi" ? 0xf6c445 : colours[Math.floor(this.rand() * colours.length)]);
      const [nx, nz] = e.pts[i + 1];
      v.heading = Math.atan2(nx - x, nz - z);
      const left = [Math.cos(v.heading), -Math.sin(v.heading)];
      v.x = x + left[0] * 1.8;
      v.z = z + left[1] * 1.8;
      v.driver = "ai";
      v.siren = police;
      this.cars.push({ v, path: e.pts, idx: i + 1, node: e.b, stuck: 0, blocked: 0, creep: 0, police });
      return;
    }
  }

  private stepTraffic(dt: number): void {
    const reg = this.reg;
    const want = reg.rule("TrafficCars");
    const civ = this.cars.filter((c) => !c.police).length;
    if (civ < want && this.rand() < dt * 4) this.spawnTraffic(false);
    const [px, pz] = this.focus();
    for (let k = this.cars.length - 1; k >= 0; k--) {
      const c = this.cars[k], v = c.v;
      if (Math.hypot(v.x - px, v.z - pz) > 480 || (!c.police && civ > want + 3 && Math.hypot(v.x - px, v.z - pz) > 150)) {
        this.cars.splice(k, 1);
        continue;
      }
      if (c.police) continue; // driven in stepPolice
      // follow the lane: next point, then the next edge out of the end node
      if (c.idx >= c.path.length) {
        const outs = (this.graph.out.get(c.node) ?? []).map((i) => this.graph.edges[i]).filter((e) => Math.hypot(e.pts[1][0] - c.path[c.path.length - 2][0], e.pts[1][1] - c.path[c.path.length - 2][1]) > 3);
        if (!outs.length) {
          c.path = c.path.slice().reverse();
          c.idx = 1;
          c.node = key(c.path[c.path.length - 1]);
        } else {
          const e = outs[Math.floor(this.rand() * outs.length)];
          c.path = e.pts;
          c.idx = 1;
          c.node = e.b;
        }
      }
      const [tx, tz] = c.path[c.idx];
      const left = [Math.cos(v.heading) * 1.8, -Math.sin(v.heading) * 1.8];
      const ax = tx + left[0], az = tz + left[1];
      if (Math.hypot(tx - v.x, tz - v.z) < 7) c.idx++;
      const wantH = Math.atan2(ax - v.x, az - v.z);
      const turn = wrap(wantH - v.heading);
      v.steerInput = Math.max(-1, Math.min(1, turn * 2.5));
      // brake for anything ahead (cars, the player, people)
      const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
      let ahead = 99;
      const obstacles: [number, number][] = [...this.cars.filter((o) => o !== c).map((o) => [o.v.x, o.v.z] as [number, number]), ...this.parked.map((o) => [o.x, o.z] as [number, number])];
      if (this.mode === "foot") obstacles.push([this.player.x, this.player.z]);
      if (this.car) obstacles.push([this.car.x, this.car.z]);
      for (const [ox, oz] of obstacles) {
        const dx = ox - v.x, dz = oz - v.z, along = dx * fx + dz * fz, lat = Math.abs(dx * fz - dz * fx);
        if (along > 0 && along < ahead && lat < 2.2) ahead = along;
      }
      const sp = Math.hypot(v.vx, v.vz);
      // deadlock breaker: after waiting a while, creep forward ignoring what is ahead
      if (c.creep > 0) {
        c.creep -= dt;
        ahead = Math.max(ahead, 9);
      }
      const limit = Math.min(12, ahead < 30 ? (ahead - 7) * 0.7 : 12) * (Math.abs(turn) > 0.5 ? 0.45 : 1);
      v.throttle = Math.max(-1, Math.min(1, (limit - sp) * 0.5));
      stepVehicle(v, handlingFor(v.kind, (kk) => reg.num(kk), 9.81, 0), dt, this.land as unknown as StaticGrid, () => {});
      c.blocked = sp < 0.5 ? c.blocked + dt : 0;
      if (c.blocked > 3 + (v.id % 5) && c.creep <= 0) {
        c.creep = 1.6;
        c.blocked = 0;
      }
      c.stuck = sp < 0.3 ? c.stuck + dt : 0;
      if (c.stuck > 14 && Math.hypot(v.x - px, v.z - pz) > 50) this.cars.splice(k, 1);
    }
    // car-car collisions near the player
    const all = [...this.cars.map((c) => c.v), ...this.parked, ...(this.car ? [this.car] : [])];
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++)
        if (Math.abs(all[i].x - all[j].x) < 6 && Math.abs(all[i].z - all[j].z) < 6) collideVehicles(all[i], all[j], all[i].maxHealth, all[j].maxHealth, (e) => all[i] === this.car || all[j] === this.car ? this.onImpact(e.speed, all[i] === this.car ? all[j] : all[i]) : undefined, false, false, this.rand);
  }

  // ------------------------------------------------------------------------------- police
  private stepPolice(dt: number): void {
    const reg = this.reg, heat = this.heat;
    const onWater = this.mode === "helm";
    const target = this.focus();
    // river police
    const wantBoats = onWater ? reg.rule("PoliceBoats") : 0;
    if (this.police.length < wantBoats && this.rand() < dt * 1.5) {
      // launch from the nearest of the river police moorings, or out on the water ahead of you
      const a = this.rand() * Math.PI * 2;
      const ring: [number, number] = [target[0] + Math.cos(a) * 160, target[1] + Math.sin(a) * 160];
      const spots = [W(LM.barrackJetty.x, LM.barrackJetty.y), ring, ring];
      const s = spots[this.police.length % spots.length];
      const [bx, bz] = this.findBerth(s[0], s[1]);
      if (Math.hypot(bx - target[0], bz - target[1]) > 60) {
        const b = new Boat("police", 8.5, 2.8);
        Object.assign(b, { x: bx, z: bz, heading: Math.atan2(target[0] - bx, target[1] - bz), state: "sailing" });
        this.police.push(b);
      }
    }
    if (!onWater && this.police.length) this.police.forEach((b) => (b.throttle = 0));
    const vmax = reg.num("police.boatSpeed") * KN;
    let nearest = 1e9;
    for (let i = this.police.length - 1; i >= 0; i--) {
      const b = this.police[i];
      const d = Math.hypot(target[0] - b.x, target[1] - b.z);
      nearest = Math.min(nearest, d);
      if (!onWater || heat <= 0) {
        b.throttle = 0.3;
        b.steer = 0;
        if (d > 300) this.police.splice(i, 1);
        this.stepBoat(b, dt, vmax, 4, 0.9);
        continue;
      }
      // pursue the predicted position, steer around the shore with feelers
      const tb = this.boat!;
      const lead = Math.min(3, d / 15);
      const px = tb.x + Math.sin(tb.heading) * tb.speed * lead, pz = tb.z + Math.cos(tb.heading) * tb.speed * lead;
      let want = Math.atan2(px - b.x, pz - b.z);
      const probe = (a: number) => {
        for (let r = 6; r <= 30; r += 6) if (this.water.blockedAt(b.x + Math.sin(a) * r, b.z + Math.cos(a) * r)) return r;
        return 99;
      };
      if (probe(b.heading) < 30) want = probe(b.heading + 0.7) > probe(b.heading - 0.7) ? b.heading + 0.9 : b.heading - 0.9;
      b.steer = Math.max(-1, Math.min(1, wrap(want - b.heading) * 2));
      b.throttle = d < 14 ? 0.2 : 1;
      this.stepBoat(b, dt, vmax, 4.5, 0.9);
    }
    // police cars on land
    const wantCars = !onWater && this.mode !== "passenger" ? reg.rule("PoliceCars") : 0;
    const cops = this.cars.filter((c) => c.police);
    if (cops.length < wantCars && this.rand() < dt * 0.8) this.spawnTraffic(true);
    for (const c of cops) {
      const v = c.v;
      const d = Math.hypot(target[0] - v.x, target[1] - v.z);
      nearest = Math.min(nearest, d);
      if (heat <= 0) {
        v.siren = false;
        c.police = false; // back to normal patrol driving
        continue;
      }
      let want = Math.atan2(target[0] - v.x, target[1] - v.z);
      const probe = (a: number) => {
        for (let r = 4; r <= 20; r += 4) if (this.land.blockedAt(v.x + Math.sin(a) * r, v.z + Math.cos(a) * r)) return r;
        return 99;
      };
      if (probe(v.heading) < 16) want = probe(v.heading + 0.6) > probe(v.heading - 0.6) ? v.heading + 0.8 : v.heading - 0.8;
      v.steerInput = Math.max(-1, Math.min(1, wrap(want - v.heading) * 2.5));
      const sp = Math.hypot(v.vx, v.vz);
      v.throttle = d < 9 ? -0.6 : Math.max(-1, Math.min(1, (reg.num("veh.police.maxSpeed") / 3.6 * 0.8 * reg.num("police.carSpeedMul") - sp) * 0.3));
      stepVehicle(v, handlingFor("police", (kk) => reg.num(kk), 9.81, 0), dt, this.land as unknown as StaticGrid, () => {});
      c.stuck = sp < 0.5 && d > 12 ? c.stuck + dt : 0;
      if (c.stuck > 4) {
        // unstick: reverse briefly
        v.throttle = -1;
        v.steerInput = -v.steerInput;
        c.stuck = 2;
      }
    }
    // heat cools off out of sight; busted when cornered
    const sightR = onWater ? 140 : 80;
    if (heat > 0) {
      // the cool-down only runs once units are out and you have shaken them off
      const units = onWater ? this.police.length : this.cars.filter((c) => c.police).length;
      const dispatching = units < (onWater ? reg.rule("PoliceBoats") : reg.rule("PoliceCars"));
      this.seenT = nearest < sightR || (dispatching && units === 0) ? 0 : this.seenT + dt;
      if (this.seenT > reg.num("police.coolDown")) {
        this.setHeat(Math.floor(heat - 0.01));
        this.seenT = 0;
        if (this.heat <= 0) this.say("info", "You lost the police", true);
      }
      const slow = this.mode === "helm" ? Math.abs(this.boat!.speed) < 1.5 : this.mode === "car" ? Math.hypot(this.car!.vx, this.car!.vz) < 1.2 : true;
      const close = onWater ? nearest < 16 : nearest < 7;
      this.bustedT = slow && close ? this.bustedT + dt : Math.max(0, this.bustedT - dt);
      if (this.bustedT > (this.mode === "foot" ? 2.5 : 4)) this.busted();
    } else this.bustedT = 0;
  }

  private busted(): void {
    this.say("fail", "BUSTED", true);
    const fine = Math.min(this.reg.num("player.cash"), 250);
    this.reg.setLive("player.cash", this.reg.num("player.cash") - fine);
    if (this.mission && !this.mission.done) this.mission = null;
    this.afterIncident(LM.eqFerry.x + 40, LM.eqFerry.y + 160);
  }

  private wasted(): void {
    this.say("fail", "HOSPITALISED", true);
    this.reg.setLive("player.health", 100);
    if (this.mission && !this.mission.done) this.mission = null;
    this.afterIncident(LM.spanda.x + 12, LM.spanda.y + 18);
  }

  private afterIncident(x: number, y: number): void {
    if (this.boat && this.boat.driver === "player") this.boat.driver = "none";
    if (this.car) this.car.driver = "none";
    this.car = this.boat = null;
    this.mode = "foot";
    const [wx, wz] = this.nearestFree(...W(x, y), "walk");
    Object.assign(this.player, { x: wx, z: wz, y: 0, vx: 0, vz: 0, pose: "stand" });
    this.police.length = 0;
    for (const c of this.cars) if (c.police) c.police = false;
    this.setHeat(0);
    this.bustedT = 0;
    // a hijacked ferry is towed back into service
    for (const f of this.ferries)
      if (f.driver !== "ai") {
        f.driver = "ai";
        const [x2, z2] = f.atEQ ? this.eqBerth : this.mendsBerth;
        Object.assign(f, { x: x2, z: z2, state: "docked", dwell: 15, speed: 0, health: 1000 });
        f.path = f.atEQ ? this.route : this.route.slice().reverse();
      }
  }

  // ------------------------------------------------------------------------------- people
  private stepPeople(dt: number): void {
    const want = this.reg.rule("People");
    const [px, pz] = this.focus();
    if (this.people.length < want && this.rand() < dt * 6) {
      const a = this.rand() * 6.283, r = 25 + this.rand() * 110;
      const x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r;
      const c = this.raster.at(x, z);
      if (c === G.PLAZA || c === G.PATH || c === G.URBAN || c === G.PIER || c === G.GRASS) {
        const h = new Human(randomLook(this.rand));
        Object.assign(h, { x, z, heading: this.rand() * 6.283 });
        h.tag.goal = [x, z];
        this.people.push(h);
      }
    }
    for (let i = this.people.length - 1; i >= 0; i--) {
      const h = this.people[i];
      if (Math.hypot(h.x - px, h.z - pz) > 170) {
        this.people.splice(i, 1);
        continue;
      }
      if (h.pose === "knocked" || h.pose === "getup") {
        moveHuman(h, 0, 0, dt, this.land as unknown as StaticGrid, 9.81);
        continue;
      }
      let [gx, gz] = h.tag.goal as [number, number];
      if (Math.hypot(gx - h.x, gz - h.z) < 1.5 || this.rand() < dt * 0.02) {
        const a = this.rand() * 6.283, r = 8 + this.rand() * 30;
        const nx = h.x + Math.cos(a) * r, nz = h.z + Math.sin(a) * r;
        if (!this.land.blockedAt(nx, nz)) h.tag.goal = [gx, gz] = [nx, nz];
      }
      const run = h.fleeing > 0;
      if (run) h.fleeing -= dt;
      const sp = run ? 5.5 : 1.3;
      const dx = gx - h.x, dz = gz - h.z, l = Math.hypot(dx, dz) || 1;
      moveHuman(h, (dx / l) * sp, (dz / l) * sp, dt, this.land as unknown as StaticGrid, 9.81);
      h.pose = "move";
    }
  }

  // ------------------------------------------------------------------------------- missions
  private stepMission(dt: number): void {
    const m = this.mission;
    if (!m || m.done) return;
    if (m.id === "heist") {
      m.timer -= dt;
      const f = this.boat;
      if (!f || this.mode !== "helm") {
        if (this.mode === "foot" && m.timer > 0 && f === null) {
          m.objective = "Get back on the ferry (it is drifting)";
        }
      }
      const ferry = this.ferries.find((x) => x.driver === "player");
      if (ferry) {
        const d = Math.hypot(ferry.x - this.mendsBerth[0], ferry.z - this.mendsBerth[1]);
        m.objective = `Take the stolen ferry to Mends Street Jetty  ${Math.round(d)} m  ${Math.max(0, Math.ceil(m.timer))} s`;
        if (d < 30 && Math.abs(ferry.speed) < 2.5) {
          m.done = true;
          const pay = this.reg.rule("HeistReward");
          this.reg.setLive("player.cash", this.reg.num("player.cash") + pay);
          this.say("mission", `HEIST COMPLETE  +$${Math.round(pay).toLocaleString("en-AU")}`, true);
          this.setHeat(Math.max(this.heat, 2));
        }
        if (ferry.health <= 0) {
          this.say("fail", "FERRY WRECKED", true);
          this.mission = null;
        }
      }
      if (m.timer <= 0 && !m.done) {
        this.say("fail", "TOO SLOW: THE HEIST FAILED", true);
        this.mission = null;
      }
    }
  }
}
