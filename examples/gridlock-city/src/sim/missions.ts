/** Missions: timed delivery, checkpoint race, police escape. Plus free roam. */
import type { World } from "./world";
import type { Vehicle } from "./vehicle";
import type { Leg } from "./nav";
import { RoadDriver, legFrom } from "./nav";

export type Status = "available" | "active" | "complete" | "failed";

export interface Marker {
  x: number;
  z: number;
  r: number;
  colour: number;
  kind: "start" | "checkpoint" | "drop" | "finish";
  label: string;
}

export interface MissionRecord {
  status: Status;
  attempts: number;
  best: string;
  lastResult: string;
  reward: number;
}

interface Running {
  id: string;
  objective: string;
  progress: string;
  timeLeft: number; // -1 = none
  update(dt: number): void;
  cleanup(): void;
}

export const MISSIONS = [
  { id: "delivery", name: "Hot Delivery", kind: "Timed delivery", weight: 1, colour: 0xffb000, poi: "depot", brief: "Porter Logistics needs two rush drops. Every dent costs you." },
  { id: "race", name: "Neon Mile Sprint", kind: "Checkpoint race", weight: 1.5, colour: 0xff3fb4, poi: "raceStart", brief: "Three rivals, one lap of Coral Point. Win or go home." },
  { id: "escape", name: "Heatwave", kind: "Police escape", weight: 2, colour: 0xff3b30, poi: "showroom", brief: "Take the Velocity prototype, lose the heat, lock it up." },
] as const;

export type MissionId = (typeof MISSIONS)[number]["id"];

export class MissionManager {
  running: Running | null = null;
  records = new Map<string, MissionRecord>();
  markers: Marker[] = [];
  /** Where the minimap route arrow points. */
  target: { x: number; z: number } | null = null;
  private armed = new Set<string>(MISSIONS.map((m) => m.id));
  lastStarted: MissionId | null = null;
  resultTimer = 0;

  constructor(private w: World) {
    for (const m of MISSIONS) this.records.set(m.id, { status: "available", attempts: 0, best: "", lastResult: "", reward: 0 });
  }

  def(id: string) {
    return MISSIONS.find((m) => m.id === id)!;
  }

  reward(id: string): number {
    return Math.round(this.w.reg.rule("MissionReward") * this.def(id).weight);
  }

  step(dt: number): void {
    const w = this.w;
    this.markers = [];
    if (this.running) {
      this.running.update(dt);
    } else {
      this.target = null;
      const p = w.playerPos();
      for (const m of MISSIONS) {
        const poi = w.city.pois[m.poi];
        this.markers.push({ x: poi.x, z: poi.z, r: 3.2, colour: m.colour, kind: "start", label: m.name });
        const d = Math.hypot(p.x - poi.x, p.z - poi.z);
        if (d > 9) this.armed.add(m.id);
        else if (d < 3.5 && this.armed.has(m.id) && !w.dead && Math.hypot(w.playerVel().x, w.playerVel().z) < 8) this.start(m.id);
      }
    }
    if (this.resultTimer > 0) this.resultTimer -= dt;
  }

  start(id: MissionId, teleport = false): void {
    if (this.running) this.finish(this.running.id, false, "Abandoned");
    const def = this.def(id);
    const rec = this.records.get(id)!;
    rec.attempts++;
    rec.status = "active";
    this.armed.delete(id);
    this.lastStarted = id;
    const poi = this.w.city.pois[def.poi];
    if (teleport) this.w.teleport(poi.x + 2, poi.z + 2);
    this.w.flash(def.name.toUpperCase(), 2.5, def.brief);
    this.running = id === "delivery" ? this.delivery() : id === "race" ? this.race() : this.escape();
  }

  restart(): void {
    if (this.lastStarted) this.start(this.lastStarted, true);
  }

  abort(): void {
    if (this.running) {
      this.finish(this.running.id, false, "Abandoned");
    }
  }

  private finish(id: string, ok: boolean, why: string): void {
    const rec = this.records.get(id)!;
    if (this.running) this.running.cleanup();
    this.running = null;
    rec.status = ok ? "complete" : "failed";
    rec.lastResult = why;
    // markers re-arm only after the player has moved away from them
    this.armed.clear();
    this.target = null;
    this.resultTimer = 4;
    if (ok) {
      this.w.addCash(rec.reward);
      this.w.flash("JOB DONE", 4, `${why}  +$${rec.reward.toLocaleString()}`);
      this.w.stats.missionsPassed++;
    } else {
      this.w.flash("JOB FAILED", 4, `${why} - press R to retry`);
      this.w.stats.missionsFailed++;
    }
  }

  /** Called by the world on busted/wasted. */
  onPlayerDown(reason: string): void {
    if (this.running) this.finish(this.running.id, false, reason);
  }

  // ------------------------------------------------------------- delivery
  private delivery(): Running {
    const w = this.w, id = "delivery";
    const depot = w.city.pois.depot;
    const van = w.spawnParked("van", depot.x + 6, depot.z, Math.PI, 0xf4f1ea);
    van.tag.mission = true;
    const drops = [w.city.pois.market, w.city.pois.meridian];
    const diff = w.reg.num("world.difficulty");
    let leg = -1; // -1 = get in van
    let timer = 150 / Math.sqrt(diff);
    let cargo = 100;
    let outTimer = 0;
    let lastHealth = van.health;
    const self: Running = {
      id,
      objective: "Get in the Porter van",
      progress: "0/2 drops",
      timeLeft: -1,
      update: (dt) => {
        if (van.destroyed || van.health <= 0) return this.finish(id, false, "Van destroyed");
        if (van.health < lastHealth) {
          cargo = Math.max(0, cargo - (lastHealth - van.health) * 0.12);
          lastHealth = van.health;
        }
        if (cargo <= 0) return this.finish(id, false, "Cargo ruined");
        if (leg === -1) {
          this.target = { x: van.x, z: van.z };
          this.markers.push({ x: van.x, z: van.z, r: 0, colour: 0xffb000, kind: "drop", label: "Van" });
          if (w.playerVehicle === van) {
            leg = 0;
            w.flash("DELIVER THE CRATES", 2.5, "Two drops before the timer runs out");
          }
          return;
        }
        timer -= dt;
        self.timeLeft = timer;
        if (timer <= 0) return this.finish(id, false, "Out of time");
        if (w.playerVehicle !== van) {
          outTimer += dt;
          self.objective = `Get back in the van (${Math.ceil(12 - outTimer)}s)`;
          if (outTimer > 12) return this.finish(id, false, "Van abandoned");
          this.target = { x: van.x, z: van.z };
          return;
        }
        outTimer = 0;
        const d = drops[leg];
        this.target = { x: d.x, z: d.z };
        this.markers.push({ x: d.x, z: d.z, r: 6, colour: 0xffb000, kind: "drop", label: d.label });
        self.objective = `Deliver to ${d.label}`;
        self.progress = `${leg}/2 drops · cargo ${Math.round(cargo)}%`;
        if (Math.hypot(van.x - d.x, van.z - d.z) < 7 && Math.abs(van.speed) < 4) {
          leg++;
          w.events.push({ type: "checkpoint", x: d.x, z: d.z, intensity: 1 });
          if (leg >= drops.length) {
            const rec = this.records.get(id)!;
            rec.reward = Math.round(this.reward(id) * (0.5 + cargo / 200));
            const best = `${Math.round(150 / Math.sqrt(diff) - timer)}s, cargo ${Math.round(cargo)}%`;
            rec.best = rec.best || best;
            return this.finish(id, true, `Delivered with ${Math.round(timer)}s to spare`);
          }
          timer += 25;
          w.flash("DROP COMPLETE", 2, "+25s · next stop: " + drops[leg].label);
        }
      },
      cleanup: () => {
        van.tag.mission = false;
        van.tag.despawnOk = true;
      },
    };
    return self;
  }

  // ------------------------------------------------------------- race
  static readonly COURSE: [number, number][] = [
    [110, -90], [190, -90], [190, 0], [190, 90], [190, 180], [-150, 180], [-150, 90], [-60, 90], [-60, 0], [30, 0], [30, -90], [110, -90],
  ];

  raceLegs(): Leg[] {
    const c = this.w.city;
    const id = (x: number, z: number) => c.nodes.find((n) => n.x === x && n.z === z)!.id;
    const legs: Leg[] = [];
    const C = MissionManager.COURSE;
    for (let i = 0; i + 1 < C.length; i++) {
      const a = id(...C[i]), b = id(...C[i + 1]);
      const e = c.nodes[a].edges.find((eid) => {
        const ed = c.edges[eid];
        return (ed.a === a && ed.b === b) || (ed.a === b && ed.b === a);
      })!;
      legs.push(legFrom(c, e, a));
    }
    return legs;
  }

  raceCheckpoints(): { x: number; z: number }[] {
    const pts = MissionManager.COURSE.slice(0, -1).map(([x, z]) => ({ x, z }));
    pts.splice(5, 0, { x: 150, z: 250 }, { x: 20, z: 250 }, { x: -110, z: 250 });
    pts.push({ x: 72, z: -90 });
    return pts;
  }

  private race(): Running {
    const w = this.w, id = "race";
    const diff = w.reg.num("world.difficulty");
    const start = { x: 52, z: -90 };
    // clear the grid area
    w.clearArea(start.x + 10, start.z, 30);
    const car = w.spawnParked("sports", start.x, start.z + 2, Math.PI / 2, 0xff3fb4);
    car.tag.mission = true;
    w.enterVehicle(car, true);
    const cps = this.raceCheckpoints();
    const legs = this.raceLegs();
    const nid = (x: number, z: number) => w.city.nodes.find((n) => n.x === x && n.z === z)!.id;
    const a0 = nid(30, -90), b0 = nid(110, -90);
    const startLeg = legFrom(w.city, w.city.nodes[a0].edges.find((e) => w.city.edges[e].a === b0 || w.city.edges[e].b === b0)!, a0);
    const rivals: { v: Vehicle; cp: number; done: number }[] = [];
    const rivalCols = [0x22e6ff, 0xffd23f, 0x3dff8c];
    for (let i = 0; i < 3; i++) {
      const v = w.spawnParked("sports", start.x - 9 - (i >> 1) * 8, start.z + (i % 2 ? 2 : -2), Math.PI / 2, rivalCols[i]);
      v.driver = "ai";
      v.tag.mission = true;
      const d = new RoadDriver(w.city, startLeg, { cruise: 0, obeySignals: false, avoid: true, lane: i % 2 ? 1 : 0, aggression: 0.5 }, w.rand);
      d.wps = d.wps.filter((p) => p.x > v.x + 2);
      d.setPlan(legs);
      w.setDriver(v, d);
      rivals.push({ v, cp: 0, done: -1 });
    }
    let cp = 0;
    let countdown = 3.5;
    let elapsed = 0;
    let out = 0;
    let finishedBefore = 0;
    const self: Running = {
      id,
      objective: "Get ready",
      progress: `0/${cps.length}`,
      timeLeft: 240,
      update: (dt) => {
        if (countdown > 0) {
          countdown -= dt;
          w.controlsLocked = true;
          for (const r of rivals) w.driverOf(r.v)!.opts.cruise = 0;
          w.flash(countdown > 0.5 ? String(Math.ceil(countdown - 0.5)) : "GO!", 0.6);
          if (countdown <= 0) {
            w.controlsLocked = false;
            for (const r of rivals) w.driverOf(r.v)!.opts.cruise = w.handling(r.v).maxSpeed * (0.6 + 0.1 * diff);
          }
          return;
        }
        elapsed += dt;
        self.timeLeft = 240 - elapsed;
        if (self.timeLeft <= 0) return this.finish(id, false, "Out of time");
        if (car.destroyed) return this.finish(id, false, "Car wrecked");
        if (w.playerVehicle !== car) {
          out += dt;
          if (out > 10) return this.finish(id, false, "Left the race");
        } else out = 0;
        const c = cps[cp];
        this.target = c;
        this.markers.push({ x: c.x, z: c.z, r: 9, colour: 0xff3fb4, kind: cp === cps.length - 1 ? "finish" : "checkpoint", label: `CP ${cp + 1}` });
        if (cp + 1 < cps.length) this.markers.push({ x: cps[cp + 1].x, z: cps[cp + 1].z, r: 9, colour: 0x7a2a5a, kind: "checkpoint", label: "" });
        const p = w.playerPos();
        if (Math.hypot(p.x - c.x, p.z - c.z) < 18) {
          cp++;
          w.events.push({ type: "checkpoint", x: c.x, z: c.z, intensity: 1 });
          if (cp >= cps.length) {
            const pos = finishedBefore + 1;
            const t = elapsed.toFixed(1) + "s";
            const rec = this.records.get(id)!;
            if (pos === 1) {
              rec.reward = this.reward(id);
              rec.best = rec.best && parseFloat(rec.best) < elapsed ? rec.best : t;
              return this.finish(id, true, `1st place in ${t}`);
            }
            return this.finish(id, false, `Finished ${pos}${pos === 2 ? "nd" : pos === 3 ? "rd" : "th"}`);
          }
        }
        // rivals progress
        let ahead = 0;
        for (const r of rivals) {
          if (r.done >= 0) {
            ahead++;
            continue;
          }
          const rc = cps[r.cp];
          if (Math.hypot(r.v.x - rc.x, r.v.z - rc.z) < 14) {
            r.cp++;
            if (r.cp >= cps.length) {
              r.done = elapsed;
              finishedBefore++;
              const dd = w.driverOf(r.v);
              if (dd) dd.opts.cruise = 6;
            }
          }
          if (r.cp > cp || (r.cp === cp && Math.hypot(r.v.x - c.x, r.v.z - c.z) < Math.hypot(p.x - c.x, p.z - c.z))) ahead++;
        }
        const pos = ahead + 1;
        self.objective = `Race! Position ${pos}/4`;
        self.progress = `CP ${cp}/${cps.length} · ${elapsed.toFixed(1)}s`;
      },
      cleanup: () => {
        w.controlsLocked = false;
        for (const r of rivals) {
          r.v.tag.mission = false;
          r.v.tag.despawnOk = true;
          const dd = w.driverOf(r.v);
          if (dd) {
            dd.opts.cruise = 10;
            dd.opts.obeySignals = true;
            dd.plan = [];
          }
        }
        car.tag.mission = false;
        car.tag.despawnOk = true;
      },
    };
    return self;
  }

  // ------------------------------------------------------------- escape
  private escape(): Running {
    const w = this.w, id = "escape";
    const sr = w.city.pois.showroom;
    const car = w.spawnParked("sports", -61.8, sr.z + 6, 0, 0xff6a00);
    car.tag.mission = true;
    car.tag.prototype = true;
    const hide = w.city.pois.hideout;
    let phase = 0; // 0 get car, 1 lose cops, 2 drive to hideout
    let out = 0;
    const self: Running = {
      id,
      objective: "Steal the Velocity prototype",
      progress: "",
      timeLeft: -1,
      update: (dt) => {
        if (car.destroyed) return this.finish(id, false, "Prototype destroyed");
        if (phase === 0) {
          this.target = { x: car.x, z: car.z };
          this.markers.push({ x: car.x, z: car.z, r: 0, colour: 0xff3b30, kind: "drop", label: "Prototype" });
          if (w.playerVehicle === car) {
            phase = 1;
            w.police.alert = Math.max(w.police.alert, 3);
            w.police.reportCrime("jack", car.x, car.z);
            w.police.lastSeen = w.t;
            w.flash("ALARM TRIGGERED", 2.5, "Lose the police");
          }
          return;
        }
        if (w.playerVehicle !== car) {
          out += dt;
          self.objective = `Get back in the prototype (${Math.ceil(15 - out)}s)`;
          if (out > 15) return this.finish(id, false, "Prototype abandoned");
          return;
        }
        out = 0;
        const stars = w.police.stars;
        if (stars > 0) {
          phase = 1;
          self.objective = `Lose the police (heat ${stars})`;
          self.progress = w.police.state === "search" ? `Hiding… ${Math.ceil(w.reg.rule("EscapeTime") - w.police.unseenTimer)}s` : "Pursuit";
          this.target = null;
          return;
        }
        if (phase === 1) {
          phase = 2;
          w.flash("HEAT LOST", 2, "Lock the car up at the hideout");
        }
        self.objective = "Deliver the prototype to the hideout";
        self.progress = `${Math.round(Math.hypot(car.x - hide.x, car.z - hide.z))} m`;
        this.target = hide;
        this.markers.push({ x: hide.x, z: hide.z, r: 6, colour: 0xff3b30, kind: "drop", label: "Hideout" });
        if (Math.hypot(car.x - hide.x, car.z - hide.z) < 7 && Math.abs(car.speed) < 3) {
          const rec = this.records.get(id)!;
          rec.reward = this.reward(id);
          rec.best = rec.best || "clean";
          this.finish(id, true, "Prototype locked up");
        }
      },
      cleanup: () => {
        car.tag.mission = false;
        car.tag.despawnOk = true;
      },
    };
    return self;
  }

  rows(): { cells: (string | number)[]; style?: "header" | "active" | "done" | "failed" | "muted" }[] {
    return MISSIONS.map((m) => {
      const r = this.records.get(m.id)!;
      const active = this.running?.id === m.id;
      return {
        cells: [
          m.name,
          m.kind,
          active ? this.running!.objective : m.brief,
          active ? this.running!.progress : r.lastResult,
          active && this.running!.timeLeft >= 0 ? Math.max(0, Math.round(this.running!.timeLeft)) : "",
          this.reward(m.id),
          active ? "ACTIVE" : r.status.toUpperCase(),
          r.attempts,
          r.best,
        ],
        style: active ? "active" : r.status === "complete" ? "done" : r.status === "failed" ? "failed" : undefined,
      };
    });
  }
}
