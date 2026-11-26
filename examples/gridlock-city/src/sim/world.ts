/**
 * The Gridlock City simulation. Renderer-agnostic: three.js reads this state,
 * tests drive it headlessly.
 */
import type { VariableRegistry } from "../../../../engines/core/variables";
import type { InputState } from "../../../../engines/core/input";
import { buildCity, CityLayout, edgePointAt } from "../city";
import { StaticGrid, SpatialHash } from "./collision";
import { Vehicle, stepVehicle, collideVehicles, handlingFor, Params, ImpactEvent } from "./vehicle";
import { Human, moveHuman, knockDown, PLAYER_LOOK, randomLook } from "./human";
import { makePed, pedThink } from "./peds";
import { RoadDriver, legFrom, Obstacle } from "./nav";
import { PoliceSystem } from "./police";
import { MissionManager } from "./missions";
import type { VehicleKind } from "../config";
import { VEHICLE_KINDS } from "../config";

export interface GameEvent {
  type: "impact" | "explosion" | "pedHit" | "checkpoint" | "busted" | "wasted" | "horn" | "jack" | "spray" | "landing";
  x: number;
  z: number;
  intensity: number;
  vehicleId?: number;
}

const COLOURS: Record<VehicleKind, number[]> = {
  sports: [0xe53935, 0xffd600, 0x00b8d4, 0xf5f5f5, 0x212121, 0x7c4dff, 0xff6d00],
  sedan: [0x546e7a, 0xb0bec5, 0x8d6e63, 0x1565c0, 0x2e7d32, 0xf5f5f5, 0x6a1b9a, 0x9e9d24, 0xc62828, 0xd7ccc8],
  taxi: [0xffc107],
  police: [0x151a22],
  van: [0xf4f1ea, 0x8d6e63, 0x26a69a, 0x455a64],
};

export class World {
  readonly city: CityLayout;
  readonly grid = new StaticGrid(16);
  t = 0;
  vehicles: Vehicle[] = [];
  peds: Human[] = [];
  player: Human;
  playerVehicle: Vehicle | null = null;
  private drivers = new Map<number, RoadDriver>();
  readonly police: PoliceSystem;
  readonly missions: MissionManager;
  events: GameEvent[] = [];
  /** Camera yaw (radians) used to make on-foot controls camera-relative. */
  camYaw = 0;
  controlsLocked = false;
  /** Optional scripted driver for the player's car (tests, attract mode, recordings). */
  autopilot: ((dt: number) => void) | null = null;
  dead = false;
  private deadTimer = 0;
  banner = "";
  bannerSub = "";
  bannerTimer = 0;
  escapes = 0;
  hint = "";
  readonly stats = { pedsHit: 0, crashes: 0, busted: 0, wasted: 0, missionsPassed: 0, missionsFailed: 0, jacked: 0, redStops: 0, spawnedCars: 0 };
  private vhash = new SpatialHash<Vehicle>(12);
  private phash = new SpatialHash<Human>(10);
  private tmpV: Vehicle[] = [];
  private tmpH: Human[] = [];
  private handlingCache = new Map<VehicleKind, Params>();
  private ruleTimer = 0;
  private spawnTimer = 0;
  private hornCooldown = 0;
  private enterCooldown = 0;

  constructor(public reg: VariableRegistry, public rand: () => number) {
    this.city = buildCity();
    for (const s of this.city.solids) this.grid.add(s);
    for (const b of this.city.barriers) this.grid.add(b, true);
    this.player = new Human(PLAYER_LOOK);
    const sp = this.city.pois.spawn;
    this.player.x = sp.x;
    this.player.z = sp.z;
    this.player.heading = sp.heading ?? 0;
    this.camYaw = this.player.heading;
    this.police = new PoliceSystem(this);
    this.missions = new MissionManager(this);
    this.spawnParkedCars();
    // spreadsheet edits that need side effects
    reg.onChange((key, v) => {
      if (key === "player.x" || key === "player.z") this.teleport(reg.num("player.x"), reg.num("player.z"));
      if (key === "player.health") {
        this.player.health = Number(v);
        if (this.player.health <= 0) this.damagePlayer(1);
      }
      if (key === "player.stamina") this.player.stamina = Number(v);
      if (key === "veh.current.health" && this.playerVehicle) {
        this.playerVehicle.health = Number(v);
        this.playerVehicle.fireTimer = -1;
        if (Number(v) > 0) this.playerVehicle.dents = [];
        this.playerVehicle.dentVersion++;
      }
      if (key.startsWith("veh.")) this.handlingCache.clear();
      if (key === "world.gravity" || key === "world.weather") this.handlingCache.clear();
      if (key === "player.alert") {
        if (Number(v) > 0) this.police.lastSeen = this.t;
      }
    });
    this.player.health = reg.num("player.health");
  }

  // ------------------------------------------------------------ helpers
  playerPos(): { x: number; z: number } {
    return this.playerVehicle ? { x: this.playerVehicle.x, z: this.playerVehicle.z } : { x: this.player.x, z: this.player.z };
  }
  playerVel(): { x: number; z: number } {
    return this.playerVehicle ? { x: this.playerVehicle.vx, z: this.playerVehicle.vz } : { x: this.player.vx, z: this.player.vz };
  }
  distToPlayer(v: { x: number; z: number }): number {
    const p = this.playerPos();
    return Math.hypot(v.x - p.x, v.z - p.z);
  }
  hours(): number {
    return this.reg.num("world.time");
  }
  /** 0 = full day, 1 = full night. */
  nightFactor(): number {
    const h = this.hours();
    if (h >= 7 && h <= 18) return 0;
    if (h >= 20.5 || h <= 5) return 1;
    if (h < 7) return 1 - (h - 5) / 2;
    return (h - 18) / 2.5;
  }
  wetness(): number {
    const w = this.reg.str("world.weather");
    return w === "Storm" ? 1 : w === "Rain" ? 0.6 : 0;
  }
  handling(v: Vehicle): Params {
    let p = this.handlingCache.get(v.kind);
    if (!p) {
      p = handlingFor(v.kind, (k) => this.reg.num(k), this.reg.num("world.gravity"), this.wetness());
      this.handlingCache.set(v.kind, p);
    }
    return p;
  }
  driverOf(v: Vehicle): RoadDriver | undefined {
    return this.drivers.get(v.id);
  }
  setDriver(v: Vehicle, d: RoadDriver): void {
    this.drivers.set(v.id, d);
  }
  flash(text: string, secs: number, sub = ""): void {
    this.banner = text;
    this.bannerSub = sub;
    this.bannerTimer = secs;
  }
  addCash(n: number): void {
    this.reg.setLive("player.cash", Math.max(0, this.reg.num("player.cash") + n));
  }

  teleport(x: number, z: number): void {
    if (this.playerVehicle) this.playerVehicle.place(x, z, this.playerVehicle.heading);
    else {
      this.player.x = x;
      this.player.z = z;
      this.player.vx = this.player.vz = 0;
    }
  }

  obstaclesNear(v: Vehicle): Obstacle[] {
    const out: Obstacle[] = [];
    for (const o of this.vhash.near(v.x + v.fx * 12, v.z + v.fz * 12, 20, this.tmpV)) out.push({ x: o.x, z: o.z, vx: o.vx, vz: o.vz, r: o.dims.width * 0.5, id: o.id });
    for (const h of this.phash.near(v.x + v.fx * 8, v.z + v.fz * 8, 12, this.tmpH)) if (h.pose !== "knocked") out.push({ x: h.x, z: h.z, vx: h.vx, vz: h.vz, r: 0.5, id: -h.id });
    if (!this.playerVehicle && this.distToPlayer(v) < 25) out.push({ x: this.player.x, z: this.player.z, vx: 0, vz: 0, r: 0.5, id: -1 });
    return out;
  }

  // ------------------------------------------------------------ spawning
  newVehicle(kind: VehicleKind, colour?: number): Vehicle {
    const cols = COLOURS[kind];
    const v = new Vehicle(kind, this.reg.num(`veh.${kind}.health`), colour ?? cols[Math.floor(this.rand() * cols.length)]);
    this.vehicles.push(v);
    return v;
  }

  spawnParked(kind: VehicleKind, x: number, z: number, heading: number, colour?: number): Vehicle {
    this.clearArea(x, z, 4);
    const v = this.newVehicle(kind, colour);
    v.place(x, z, heading);
    return v;
  }

  clearArea(x: number, z: number, r: number): void {
    for (const v of [...this.vehicles]) if (v !== this.playerVehicle && !v.tag.mission && Math.hypot(v.x - x, v.z - z) < r + 3) this.removeVehicle(v);
  }

  removeVehicle(v: Vehicle): void {
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
    this.drivers.delete(v.id);
  }

  private spawnParkedCars(): void {
    for (const lot of this.city.parking) {
      for (let x = lot.x0 + 3; x < lot.x1 - 3; x += 3.2)
        for (const z of [lot.z0 + 3, lot.z1 - 3])
          if (this.rand() < 0.35) {
            const kinds: VehicleKind[] = ["sedan", "sedan", "sports", "van", "taxi"];
            const v = this.newVehicle(kinds[Math.floor(this.rand() * kinds.length)]);
            v.place(x, z, z < (lot.z0 + lot.z1) / 2 ? Math.PI : 0);
          }
    }
    // a few at the kerb, plus a guaranteed sports car near the spawn
    const sp = this.city.pois.spawn;
    const v = this.newVehicle("sports", 0xe53935);
    v.place(sp.x - 6, sp.z - 4, Math.PI);
  }

  pickKind(): VehicleKind {
    const w = VEHICLE_KINDS.map((k) => Math.max(0, this.reg.num(`world.spawn.${k}`)));
    const tot = w.reduce((a, b) => a + b, 0);
    if (tot <= 0) return "sedan";
    let r = this.rand() * tot;
    for (let i = 0; i < w.length; i++) if ((r -= w[i]) <= 0) return VEHICLE_KINDS[i];
    return "sedan";
  }

  /** Spawn an AI vehicle on a road point between rMin and rMax from the player, preferring points out of view. */
  spawnVehicleNear(kind: VehicleKind, rMin: number, rMax: number, police = false, centre?: { x: number; z: number }): Vehicle | null {
    const p = centre ?? this.playerPos();
    const pp = this.playerPos();
    for (let tries = 0; tries < 12; tries++) {
      const e = this.city.edges[Math.floor(this.rand() * this.city.edges.length)];
      const s = 12 + this.rand() * Math.max(1, e.length - 24);
      const pt = edgePointAt(e, s);
      const d = Math.hypot(pt.x - p.x, pt.z - p.z);
      if (d < rMin || d > rMax) continue;
      if (centre && Math.hypot(pt.x - pp.x, pt.z - pp.z) < 60) continue; // never pop up right beside a hidden player
      const dir: 1 | -1 = this.rand() < 0.5 ? 1 : -1;
      const lane = this.rand() < 0.5 ? 0 : 1;
      const leg = legFrom(this.city, e.id, dir === 1 ? e.a : e.b);
      const drv = new RoadDriver(this.city, leg, { cruise: police ? 20 : 10 + this.rand() * 5, obeySignals: !police, avoid: true, lane, aggression: 0 }, this.rand);
      // start at the waypoint nearest to s
      const wps = drv.wps;
      let bi = 0, bd = 1e9;
      wps.forEach((w, i) => {
        const dd = Math.hypot(w.x - pt.x, w.z - pt.z);
        if (dd < bd) {
          bd = dd;
          bi = i;
        }
      });
      const w0 = wps[bi], w1 = wps[Math.min(wps.length - 1, bi + 1)];
      if (w0 === w1) continue;
      if (this.vhash.near(w0.x, w0.z, 9, this.tmpV).length) continue;
      const v = this.newVehicle(kind);
      v.place(w0.x, w0.z, Math.atan2(w1.x - w0.x, w1.z - w0.z));
      const sp = police ? 12 : 7;
      v.vx = v.fx * sp;
      v.vz = v.fz * sp;
      v.driver = "ai";
      drv.wps = wps.slice(bi + 1);
      this.drivers.set(v.id, drv);
      this.stats.spawnedCars++;
      return v;
    }
    return null;
  }

  // ------------------------------------------------------------ player
  enterVehicle(v: Vehicle, instant = false): void {
    if (v.driver === "ai") {
      // carjacking: throw the driver out
      const dr = new Human(randomLook(this.rand));
      dr.x = v.x + v.fz * 1.6;
      dr.z = v.z - v.fx * 1.6;
      makeBrainless(dr);
      dr.fleeing = 4;
      dr.tag.brain = { loop: 0, corner: 0, dir: 1, speed: 1.4, lateral: 0, crossing: null, fleeX: v.fz, fleeZ: -v.fx, idle: 0 };
      this.peds.push(dr);
      this.drivers.delete(v.id);
      this.stats.jacked++;
      this.events.push({ type: "jack", x: v.x, z: v.z, intensity: 1 });
      if (v.kind === "police") this.police.reportCrime("copRam", v.x, v.z);
      else if (!v.tag.mission) this.police.reportCrime("jack", v.x, v.z);
    }
    v.driver = "player";
    v.tag.despawnOk = false;
    this.playerVehicle = v;
    this.player.pose = "stand";
    this.reg.setLive("player.inVehicle", v.kind);
    this.enterCooldown = instant ? 0 : 0.4;
  }

  exitVehicle(): void {
    const v = this.playerVehicle;
    if (!v) return;
    const fast = Math.abs(v.speed) > 7;
    let placed = false;
    for (const side of [1, -1]) {
      const x = v.x + v.fz * 1.7 * side, z = v.z - v.fx * 1.7 * side;
      if (!this.grid.inside(x, z)) {
        this.player.x = x;
        this.player.z = z;
        placed = true;
        break;
      }
    }
    if (!placed) {
      this.player.x = v.x;
      this.player.z = v.z;
    }
    this.player.heading = v.heading;
    this.player.vx = v.vx * 0.5;
    this.player.vz = v.vz * 0.5;
    v.driver = "none";
    v.throttle = 0;
    v.steerInput = 0;
    v.handbrake = !fast;
    this.playerVehicle = null;
    this.reg.setLive("player.inVehicle", "on foot");
    if (fast) knockDown(this.player, v.vx, v.vz, Math.abs(v.speed) * 0.6);
  }

  nearestEnterable(): Vehicle | null {
    let best: Vehicle | null = null, bd = 4.2;
    for (const v of this.vehicles) {
      if (v.destroyed || v.health <= 0) continue;
      const d = Math.hypot(v.x - this.player.x, v.z - this.player.z);
      if (d < bd && Math.abs(v.speed) < 9) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  busted(): void {
    this.stats.busted++;
    this.downPlayer("ARRESTED", "policeStation", 0.1);
  }

  private downPlayer(text: string, poi: string, cashLoss: number): void {
    if (this.dead) return;
    this.dead = true;
    this.deadTimer = 3;
    this.flash(text, 3, cashLoss ? `-$${Math.round(this.reg.num("player.cash") * cashLoss)}` : "");
    this.events.push({ type: text === "ARRESTED" ? "busted" : "wasted", x: this.playerPos().x, z: this.playerPos().z, intensity: 1 });
    this.addCash(-Math.round(this.reg.num("player.cash") * cashLoss));
    this.missions.onPlayerDown(text === "ARRESTED" ? "Arrested" : "Hospitalised");
    this.respawnPoi = poi;
  }
  private respawnPoi = "hospital";

  private respawn(): void {
    if (this.playerVehicle) this.exitVehicle();
    const p = this.city.pois[this.respawnPoi];
    this.player.x = p.x;
    this.player.z = p.z;
    this.player.vx = this.player.vz = 0;
    this.player.pose = "stand";
    this.player.knockTimer = 0;
    this.player.health = 100;
    this.reg.setLive("player.health", 100);
    this.police.alert = 0;
    this.dead = false;
  }

  // ------------------------------------------------------------ main step
  step(dt: number, input: InputState): void {
    this.t += dt;
    this.events.length = 0;
    const reg = this.reg;
    // clock
    const h = (reg.num("world.time") + (dt * reg.num("world.timeScale")) / 60) % 24;
    reg.setLive("world.time", h);
    this.ruleTimer -= dt;
    if (this.ruleTimer <= 0) {
      reg.recomputeRules();
      this.ruleTimer = 0.5;
    }
    if (this.bannerTimer > 0) this.bannerTimer -= dt;
    // hashes
    this.vhash.clear();
    for (const v of this.vehicles) this.vhash.insert(v);
    this.phash.clear();
    for (const p of this.peds) this.phash.insert(p);

    if (this.dead) {
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) this.respawn();
    } else this.controlPlayer(dt, input);

    // vehicles
    const pp = this.playerPos();
    const onImpact = (e: ImpactEvent) => this.onImpact(e);
    const invincible = reg.bool("player.invincible");
    for (const v of this.vehicles) {
      const d = Math.hypot(v.x - pp.x, v.z - pp.z);
      v.lod = d < 110 ? 0 : d < 170 ? 1 : 2;
      // mission vehicles (race rivals) and engaged police must keep moving wherever they are
      if (v.lod === 2 && (v.tag.mission || (v.tag.cop && (v.tag.cop as { role: string }).role !== "patrol"))) v.lod = 1;
      if (v.driver === "ai") {
        const drv = this.drivers.get(v.id);
        if (drv && (!v.tag.cop || (v.tag.cop as { role: string }).role === "patrol")) {
          drv.drive(v, dt, this.t, v.lod === 0 ? this.obstaclesNear(v) : []);
          if (drv.waitingAtRed && Math.abs(v.speed) < 0.3) v.tag.waited = true;
        }
      }
      if (v.driver === "none") {
        v.throttle = 0;
        v.steerInput = 0;
        if (Math.hypot(v.vx, v.vz) < 0.05 && v.health > 0 && v.lod > 0) continue;
      }
      let sdt = dt;
      if (v.lod === 1) {
        v.lodAcc += dt;
        if (v.lodAcc < dt * 3) continue;
        sdt = v.lodAcc;
        v.lodAcc = 0;
      } else if (v.lod === 2 && v !== this.playerVehicle) continue;
      stepVehicle(v, this.handling(v), sdt, this.grid, onImpact, v === this.playerVehicle && invincible);
    }
    this.police.step(dt);
    // vehicle-vehicle
    for (const v of this.vehicles) {
      if (v.lod === 2) continue;
      for (const o of this.vhash.near(v.x, v.z, 6.5, this.tmpV)) {
        if (o.id <= v.id) continue;
        collideVehicles(v, o, this.handling(v).mass, this.handling(o).mass, onImpact, v === this.playerVehicle && invincible, o === this.playerVehicle && invincible, this.rand);
      }
    }
    // explosions
    for (const v of this.vehicles) {
      if (v.destroyed && !v.tag.exploded) {
        v.tag.exploded = true;
        v.tag.wreckTime = this.t;
        this.events.push({ type: "explosion", x: v.x, z: v.z, intensity: 1, vehicleId: v.id });
        if (v === this.playerVehicle) {
          this.exitVehicle();
          this.damagePlayer(70);
          knockDown(this.player, this.player.x - v.x, this.player.z - v.z, 10);
        } else if (this.distToPlayer(v) < 8 && !this.playerVehicle) {
          this.damagePlayer(45);
          knockDown(this.player, this.player.x - v.x, this.player.z - v.z, 8);
        }
        if (v.driver === "ai") {
          this.drivers.delete(v.id);
          v.driver = "none";
        }
        if (this.distToPlayer(v) < 60 && (v.tag.lastHitByPlayer as number) > this.t - 10) this.police.reportCrime("explosion", v.x, v.z);
      }
    }
    if (this.playerVehicle) reg.setLive("veh.current.health", Math.round(this.playerVehicle.health));
    this.stepPeds(dt);
    this.missions.step(dt);
    this.manageSpawns(dt);
    // live variables
    const p = this.playerPos();
    reg.setLive("player.x", Math.round(p.x * 10) / 10);
    reg.setLive("player.z", Math.round(p.z * 10) / 10);
    reg.setLive("player.stamina", Math.round(this.player.stamina));
    reg.setLive("player.health", Math.round(this.player.health));
    this.hint = this.computeHint();
  }

  private computeHint(): string {
    if (this.dead) return "";
    if (this.playerVehicle) return Math.abs(this.playerVehicle.speed) < 7 ? "F  Exit vehicle" : "SPACE  Handbrake";
    const v = this.nearestEnterable();
    if (v) return `F  ${v.driver === "ai" ? "Jack" : "Enter"} ${v.kind === "van" ? "van" : v.kind === "police" ? "police cruiser" : v.kind}`;
    return "";
  }

  damagePlayer(n: number): void {
    if (this.reg.bool("player.invincible") || this.dead) return;
    this.player.health = Math.max(0, this.player.health - n);
    this.reg.setLive("player.health", Math.round(this.player.health));
    if (this.player.health <= 0) {
      this.stats.wasted++;
      this.downPlayer("HOSPITALISED", "hospital", 0.08);
    }
  }

  private onImpact(e: ImpactEvent): void {
    this.events.push({ type: "impact", x: e.x, z: e.z, intensity: Math.min(1, e.speed / 25), vehicleId: e.vehicle.id });
    const pv = this.playerVehicle;
    const involvesPlayer = e.vehicle === pv || e.other === pv;
    if (involvesPlayer) {
      this.stats.crashes++;
      const other = e.vehicle === pv ? e.other : e.vehicle;
      if (other) other.tag.lastHitByPlayer = this.t;
      // only the player's own ramming counts (cops shunting a stopped car is not a crime)
      const playerFaster = !!other && Math.hypot(pv!.vx, pv!.vz) > Math.hypot(other.vx, other.vz) + 2;
      if (other?.kind === "police" && e.speed > 5 && playerFaster) this.police.reportCrime("copRam", e.x, e.z);
      else if (other && other.driver === "ai" && e.speed > 9 && playerFaster) this.police.reportCrime("crash", e.x, e.z);
      if (e.speed > 18) this.damagePlayer((e.speed - 18) * 1.1);
    }
  }

  private controlPlayer(dt: number, input: InputState): void {
    const reg = this.reg;
    this.enterCooldown -= dt;
    this.hornCooldown -= dt;
    const locked = this.controlsLocked;
    if (input.pressed("enter") && this.enterCooldown <= 0 && !locked) {
      if (this.playerVehicle) {
        if (Math.abs(this.playerVehicle.speed) < 12) this.exitVehicle();
      } else if (this.player.pose !== "knocked") {
        const v = this.nearestEnterable();
        if (v) this.enterVehicle(v);
      }
    }
    if (input.pressed("restart") && this.missions.resultTimer > 0 && this.missions.records.get(this.missions.lastStarted ?? "")?.status === "failed") this.missions.restart();
    const v = this.playerVehicle;
    if (v) {
      if (locked) {
        v.throttle = 0;
        v.steerInput = 0;
        v.handbrake = true;
        return;
      }
      if (this.autopilot) {
        this.autopilot(dt);
        this.player.x = v.x;
        this.player.z = v.z;
        return;
      }
      v.throttle = input.combined("down", "up", "moveY");
      v.steerInput = Math.max(-1, Math.min(1, input.combined("right", "left") - input.axis("moveX")));
      v.handbrake = input.held("handbrake");
      if (input.held("horn") && this.hornCooldown <= 0) {
        this.hornCooldown = 0.5;
        this.events.push({ type: "horn", x: v.x, z: v.z, intensity: 1, vehicleId: v.id });
        for (const p of this.peds) if (Math.hypot(p.x - v.x, p.z - v.z) < 16 && p.pose !== "knocked") p.fleeing = Math.max(p.fleeing, 0.01);
      }
      // speeding past police
      if (Math.abs(v.speed) > 30 && this.police.alert === 0) {
        for (const o of this.vhash.near(v.x, v.z, 25, this.tmpV))
          if (o.kind === "police" && o.driver === "ai" && this.rand() < dt * 0.6) this.police.reportCrime("speeding", v.x, v.z);
      }
      this.player.x = v.x;
      this.player.z = v.z;
      return;
    }
    // on foot
    const pl = this.player;
    const fwd = input.combined("down", "up", "moveY");
    const side = input.combined("left", "right", "moveX");
    let mag = Math.min(1, Math.hypot(fwd, side));
    const sprint = input.held("sprint") && pl.stamina > 2 && mag > 0.1;
    const walk = input.held("walk");
    const base = (walk ? 1.6 : sprint ? 7.2 : 4.1) * reg.num("player.speed");
    if (sprint) pl.stamina = Math.max(0, pl.stamina - 16 * dt);
    else pl.stamina = Math.min(100, pl.stamina + (mag > 0.1 ? 6 : 14) * dt);
    if (locked || pl.pose === "knocked" || pl.pose === "getup") mag = 0;
    // camera-relative: forward = camera look direction on the ground
    const cf = { x: Math.sin(this.camYaw), z: Math.cos(this.camYaw) };
    const cr = { x: -cf.z, z: cf.x };
    let wx = cf.x * fwd + cr.x * side, wz = cf.z * fwd + cr.z * side;
    const l = Math.hypot(wx, wz) || 1;
    wx = (wx / l) * base * mag;
    wz = (wz / l) * base * mag;
    if (input.pressed("handbrake") && pl.pose !== "jump" && pl.pose !== "knocked" && pl.y <= 0.01) {
      pl.vy = 4.2 * Math.sqrt(reg.num("world.gravity") / 9.81);
      pl.y += 0.01;
      pl.pose = "jump";
    }
    moveHuman(pl, wx, wz, dt, this.grid, reg.num("world.gravity"));
    if (pl.pose === "stand" && mag > 0.05) pl.pose = "move";
    if (pl.pose === "move" && mag <= 0.05 && Math.hypot(pl.vx, pl.vz) < 0.2) pl.pose = "stand";
    // cars hitting the player
    for (const c of this.vhash.near(pl.x, pl.z, 4, this.tmpV)) {
      const sp = Math.hypot(c.vx, c.vz);
      for (const cc of c.circles([])) {
        if (Math.hypot(cc.x - pl.x, cc.z - pl.z) < cc.r + 0.4) {
          if (sp > 4.5 && pl.pose !== "knocked") {
            knockDown(pl, c.vx, c.vz, sp);
            this.damagePlayer(sp * 2.2);
          } else {
            // pushed by slow car
            const dx = pl.x - cc.x, dz = pl.z - cc.z, d = Math.hypot(dx, dz) || 1;
            pl.x = cc.x + (dx / d) * (cc.r + 0.41);
            pl.z = cc.z + (dz / d) * (cc.r + 0.41);
          }
        }
      }
    }
  }

  private stepPeds(dt: number): void {
    const pp = this.playerPos();
    const threats: { x: number; z: number; vx: number; vz: number }[] = [];
    for (const v of this.vehicles) if (Math.hypot(v.vx, v.vz) > 4 && Math.hypot(v.x - pp.x, v.z - pp.z) < 90) threats.push({ x: v.x, z: v.z, vx: v.vx, vz: v.vz });
    const g = this.reg.num("world.gravity");
    for (const p of this.peds) {
      const d = Math.hypot(p.x - pp.x, p.z - pp.z);
      p.lod = d < 70 ? 0 : 1;
      let sdt = dt;
      if (p.lod === 1) {
        p.tag.acc = ((p.tag.acc as number) || 0) + dt;
        if ((p.tag.acc as number) < dt * 2) continue;
        sdt = p.tag.acc as number;
        p.tag.acc = 0;
      }
      const near = threats.filter((t) => Math.abs(t.x - p.x) < 16 && Math.abs(t.z - p.z) < 16);
      if (p.fleeing === 0.01) {
        // honked at
        const pv = this.playerVehicle;
        if (pv) near.push({ x: pv.x, z: pv.z, vx: (p.x - pv.x) * 2, vz: (p.z - pv.z) * 2 });
        p.fleeing = 0;
      }
      const want = pedThink(p, this.city, this.t, sdt, this.rand, near);
      moveHuman(p, want.vx, want.vz, sdt, this.grid, g, 9);
      p.pose = p.pose === "knocked" || p.pose === "getup" ? p.pose : Math.hypot(p.vx, p.vz) > 0.2 ? "move" : "stand";
      // vehicle hits
      if (p.pose !== "knocked")
        for (const c of this.vhash.near(p.x, p.z, 4, this.tmpV)) {
          const sp = Math.hypot(c.vx, c.vz);
          if (sp < 3) continue;
          for (const cc of c.circles([]))
            if (Math.hypot(cc.x - p.x, cc.z - p.z) < cc.r + 0.38) {
              knockDown(p, c.vx, c.vz, sp);
              p.health -= sp * 3;
              this.events.push({ type: "pedHit", x: p.x, z: p.z, intensity: Math.min(1, sp / 20) });
              if (c === this.playerVehicle) {
                this.stats.pedsHit++;
                this.police.reportCrime("pedHit", p.x, p.z);
              }
              break;
            }
        }
    }
  }

  private manageSpawns(dt: number): void {
    const pp = this.playerPos();
    // despawn far entities
    for (const v of [...this.vehicles]) {
      if (v === this.playerVehicle || v.tag.mission) continue;
      const d = Math.hypot(v.x - pp.x, v.z - pp.z);
      const wreckOld = v.destroyed && this.t - (v.tag.wreckTime as number) > 45;
      if ((v.driver === "ai" || v.tag.despawnOk || v.destroyed) && (d > 200 || (wreckOld && d > 60))) this.removeVehicle(v);
    }
    for (const p of [...this.peds]) if (Math.hypot(p.x - pp.x, p.z - pp.z) > 140) this.peds.splice(this.peds.indexOf(p), 1);
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = 0.25;
    const target = Math.round(26 * this.reg.rule("TrafficDensity"));
    const traffic = this.vehicles.filter((v) => v.driver === "ai" && !v.tag.cop && !v.tag.mission).length;
    if (traffic < target) {
      const k = this.pickKind();
      this.spawnVehicleNear(k, 60, 150, false);
    } else if (traffic > target + 2) {
      const far = this.vehicles.filter((v) => v.driver === "ai" && !v.tag.cop && !v.tag.mission).sort((a, b) => this.distToPlayer(b) - this.distToPlayer(a))[0];
      if (far && this.distToPlayer(far) > 60) this.removeVehicle(far);
    }
    const pedTarget = Math.round(this.reg.rule("PedestrianCount"));
    if (this.peds.length < pedTarget) {
      for (let i = 0; i < 3 && this.peds.length < pedTarget; i++) {
        const loop = this.city.sidewalkLoops[Math.floor(this.rand() * this.city.sidewalkLoops.length)];
        const c = loop[Math.floor(this.rand() * loop.length)];
        const d = Math.hypot(c.x - pp.x, c.z - pp.z);
        if (d < 25 || d > 110) continue;
        const ped = makePed(this.city, this.rand, c.x + (this.rand() - 0.5) * 20, c.z + (this.rand() - 0.5) * 20);
        if (ped) this.peds.push(ped);
      }
    } else if (this.peds.length > pedTarget + 2) {
      const far = this.peds.sort((a, b) => this.distToPlayer(b) - this.distToPlayer(a))[0];
      if (this.distToPlayer(far) > 40) this.peds.shift();
    }
  }

  entityCount(): number {
    return this.vehicles.length + this.peds.length + 1;
  }
}

function makeBrainless(h: Human): void {
  h.pose = "move";
}
