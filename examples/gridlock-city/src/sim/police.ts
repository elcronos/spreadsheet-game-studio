/**
 * Alert & police pursuit system.
 *
 * Crimes raise the alert level (0-5 stars, PLAYER!AlertLevel). Police budget
 * comes from RULES!PoliceBudget. Units coordinate by role:
 *   chase     - the two nearest units drive straight at the predicted position
 *   intercept - aim at a point ahead of the player's travel
 *   flank     - route to the intersection the player is heading towards
 * Losing line of sight starts a search around the last sighting
 * (RULES!SearchRadius); staying unseen for RULES!EscapeTime drops a star.
 */
import type { World } from "./world";
import type { Vehicle } from "./vehicle";
import { RoadDriver, nearestNode } from "./nav";

export type Role = "chase" | "intercept" | "flank" | "search" | "patrol";

export interface CopState {
  role: Role;
  driver: RoadDriver;
  replanAt: number;
  searchTarget: { x: number; z: number } | null;
  sawPlayer: boolean;
  closeTimer: number;
}

export type CrimeKind = "pedHit" | "jack" | "copRam" | "crash" | "explosion" | "speeding";

const SEVERITY: Record<CrimeKind, number> = { pedHit: 1, jack: 1, copRam: 1.2, crash: 0.35, explosion: 1.5, speeding: 0.5 };

export class PoliceSystem {
  lastSeen = -1e9;
  lastKnown = { x: 0, z: 0 };
  lastKnownVel = { x: 0, z: 0 };
  unseenTimer = 0;
  bustedTimer = 0;
  state: "idle" | "pursuit" | "search" = "idle";
  /** Recent events for telemetry/evals. */
  log: { t: number; msg: string }[] = [];
  private spawnCooldown = 0;
  crimes = 0;

  constructor(private w: World) {}

  get alert(): number {
    return this.w.reg.num("player.alert");
  }
  set alert(v: number) {
    this.w.reg.setLive("player.alert", Math.max(0, Math.min(5, v)));
  }
  get stars(): number {
    return Math.max(0, Math.ceil(this.alert - 1e-6));
  }

  cop(v: Vehicle): CopState | undefined {
    return v.tag.cop as CopState | undefined;
  }

  note(msg: string): void {
    this.log.push({ t: this.w.t, msg });
    if (this.log.length > 40) this.log.shift();
  }

  /** Visibility range shrinks at night and in bad weather. */
  sightRange(): number {
    const night = this.w.nightFactor();
    const wx = this.w.reg.str("world.weather");
    let r = 85 - 30 * night;
    if (wx === "Fog") r *= 0.5;
    if (wx === "Storm") r *= 0.7;
    if (wx === "Rain") r *= 0.85;
    return r;
  }

  canSee(v: Vehicle): boolean {
    const p = this.w.playerPos();
    const d = Math.hypot(p.x - v.x, p.z - v.z);
    if (d > this.sightRange()) return false;
    return this.w.grid.raycast(v.x, v.z, p.x, p.z) >= 1;
  }

  reportCrime(kind: CrimeKind, x: number, z: number): void {
    if (this.w.reg.num("world.policeResponse") <= 0) return;
    let witnessed = kind === "copRam";
    for (const v of this.w.vehicles)
      if (v.kind === "police" && !v.destroyed && v.driver === "ai" && Math.hypot(v.x - x, v.z - z) < 70 && this.w.grid.raycast(v.x, v.z, x, z) >= 1) witnessed = true;
    let reported = witnessed;
    if (!reported) {
      const peds = this.w.peds.filter((p) => Math.hypot(p.x - x, p.z - z) < 25 && p.pose !== "knocked").length;
      reported = peds > 0 && this.w.rand() < Math.min(0.9, 0.35 + peds * 0.15);
    }
    if (!reported) return;
    this.crimes++;
    const before = this.stars;
    const add = SEVERITY[kind] * (witnessed ? 1 : 0.7);
    this.alert = Math.max(this.alert + add, kind === "crash" || kind === "speeding" ? this.alert : Math.max(1, this.alert));
    if (witnessed) this.sighted();
    else this.lastKnown = { x, z };
    if (this.stars > before) this.note(`${kind} → heat ${this.stars}`);
    this.unseenTimer = 0;
  }

  private sighted(): void {
    const p = this.w.playerPos();
    this.lastSeen = this.w.t;
    this.lastKnown = { x: p.x, z: p.z };
    const pv = this.w.playerVel();
    this.lastKnownVel = { x: pv.x, z: pv.z };
  }

  step(dt: number): void {
    const w = this.w;
    const alert = this.alert;
    const units = w.vehicles.filter((v) => v.kind === "police" && v.driver === "ai" && !v.destroyed);
    for (const u of units) if (!u.tag.cop) u.tag.cop = { role: "patrol", driver: w.driverOf(u)!, replanAt: 0, searchTarget: null, sawPlayer: false, closeTimer: 0 } satisfies CopState;

    if (alert <= 0) {
      if (this.state !== "idle") {
        this.note("pursuit over");
        for (const u of units) this.disengage(u);
      }
      this.state = "idle";
      this.bustedTimer = 0;
      return;
    }
    // sightings
    let seen = false;
    for (const u of units) {
      const c = this.cop(u)!;
      c.sawPlayer = this.canSee(u);
      if (c.sawPlayer) seen = true;
    }
    if (seen) this.sighted();
    const sinceSeen = w.t - this.lastSeen;
    if (seen) {
      this.unseenTimer = 0;
      this.state = "pursuit";
    } else {
      this.unseenTimer += dt;
      if (sinceSeen > 2.5) this.state = "search";
      if (this.unseenTimer > w.reg.rule("EscapeTime")) {
        this.unseenTimer = 0;
        const s = this.stars - 1;
        this.alert = Math.max(0, s);
        this.note(s > 0 ? `lost sight → heat ${s}` : "escaped");
        if (s <= 0) {
          w.escapes++;
          w.flash("ESCAPED", 2.5);
        }
        return;
      }
    }
    // budget & spawning
    const budget = Math.max(1, Math.round(w.reg.rule("PoliceBudget")));
    const engaged = units.filter((u) => !u.tag.despawnOk && (this.cop(u)!.role !== "patrol" || Math.hypot(u.x - w.playerPos().x, u.z - w.playerPos().z) < 160));
    this.spawnCooldown -= dt;
    if (engaged.length < budget && this.spawnCooldown <= 0) {
      const v = this.state === "pursuit" ? w.spawnVehicleNear("police", 70, 130, true) : w.spawnVehicleNear("police", 40, 140, true, this.lastKnown);
      if (v) {
        v.siren = true;
        this.spawnCooldown = 2.2 / Math.max(0.5, w.reg.num("world.policeResponse"));
      }
    }
    // excess units peel away
    const sorted = engaged.sort((a, b) => w.distToPlayer(a) - w.distToPlayer(b));
    // units beyond the budget peel away (farthest first) and stay out of the pursuit
    for (const u of sorted.slice(budget + 1)) this.disengage(u);
    const active = sorted.slice(0, budget + 1);
    active.forEach((u, i) => {
      const c = this.cop(u)!;
      u.siren = true;
      if (this.state === "search") c.role = "search";
      else c.role = i < 2 ? "chase" : i === 2 || i === 4 ? "intercept" : "flank";
    });
    const aggression = Math.min(1, 0.55 + 0.15 * w.reg.num("world.policeResponse"));
    for (const u of active) this.driveUnit(u, aggression, dt);
    this.checkBusted(dt, active);
  }

  private disengage(u: Vehicle): void {
    const c = this.cop(u);
    if (!c) return;
    c.role = "patrol";
    u.siren = false;
    c.driver.opts.obeySignals = true;
    c.driver.opts.cruise = 11;
    c.driver.opts.aggression = 0;
    c.driver.plan = [];
    u.tag.despawnOk = true;
  }

  private driveUnit(u: Vehicle, aggression: number, dt: number): void {
    const w = this.w;
    const c = this.cop(u)!;
    const d = c.driver;
    d.opts.obeySignals = false;
    d.opts.cruise = w.handling(u).maxSpeed * (0.8 + 0.2 * aggression);
    d.opts.aggression = aggression;
    const p = w.playerPos();
    const pv = w.playerVel();
    const dist = Math.hypot(p.x - u.x, p.z - u.z);
    let target: { x: number; z: number } | null = null;
    if (c.role === "search") {
      const R = w.reg.rule("SearchRadius");
      if (!c.searchTarget || Math.hypot(c.searchTarget.x - u.x, c.searchTarget.z - u.z) < 15 || w.t > c.replanAt + 12) {
        const a = w.rand() * Math.PI * 2, rr = w.rand() * R;
        c.searchTarget = { x: this.lastKnown.x + this.lastKnownVel.x * 2 + Math.cos(a) * rr, z: this.lastKnown.z + this.lastKnownVel.z * 2 + Math.sin(a) * rr };
        d.routeTo(nearestNode(w.city, c.searchTarget.x, c.searchTarget.z));
        c.replanAt = w.t;
      }
      d.opts.cruise *= 0.6;
      d.drive(u, dt, w.t, w.obstaclesNear(u), null);
      return;
    }
    if (c.role === "chase" && c.sawPlayer && dist < 55) {
      const lead = Math.min(1.2, dist / 25);
      target = { x: p.x + pv.x * lead, z: p.z + pv.z * lead };
    } else if (c.role === "intercept" && c.sawPlayer && dist < 70) {
      const lead = Math.min(3, dist / 15);
      target = { x: p.x + pv.x * lead, z: p.z + pv.z * lead };
    }
    if (!target && w.t > c.replanAt) {
      c.replanAt = w.t + 1.5 + w.rand();
      let goal = nearestNode(w.city, p.x, p.z);
      if (c.role === "flank" || c.role === "intercept") goal = nearestNode(w.city, p.x + pv.x * 4, p.z + pv.z * 4);
      d.routeTo(goal);
    }
    // close in directly once in the same street
    if (!target && dist < 30 && w.grid.raycast(u.x, u.z, p.x, p.z) >= 1) target = { x: p.x, z: p.z };
    // box the suspect in rather than ramming at full speed
    if (dist < 14) d.opts.cruise = Math.min(d.opts.cruise, Math.hypot(pv.x, pv.z) + 5);
    d.drive(u, dt, w.t, target ? [] : w.obstaclesNear(u), target);
  }

  private checkBusted(dt: number, active: Vehicle[]): void {
    const w = this.w;
    const p = w.playerPos();
    const near = active.some((u) => Math.hypot(u.x - p.x, u.z - p.z) < (w.playerVehicle ? 7.5 : 6) && Math.abs(u.speed) < 6);
    const slow = w.playerVehicle ? Math.abs(w.playerVehicle.speed) < 1.6 : Math.hypot(w.player.vx, w.player.vz) < 3.5;
    if (near && slow && this.state === "pursuit") this.bustedTimer += dt;
    else this.bustedTimer = Math.max(0, this.bustedTimer - dt);
    if (this.bustedTimer > (w.playerVehicle ? 2.6 : 1.6)) {
      this.bustedTimer = 0;
      w.busted();
    }
  }
}
