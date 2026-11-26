import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, autopilot } from "./harness";
import { makePed } from "../../examples/gridlock-city/src/sim/peds";

test("G1 on foot: walk, run, sprint drains stamina", () => {
  const { world, step, hold } = makeWorld();
  const p = world.player;
  const x0 = p.x, z0 = p.z;
  world.camYaw = -Math.PI / 2; // look west along Pier Street
  hold("up"); hold("walk"); step(1.5); const walkSpeed = Math.hypot(p.vx, p.vz); hold("walk", false);
  step(1.5); const runSpeed = Math.hypot(p.vx, p.vz);
  hold("sprint"); step(2); const sprintSpeed = Math.hypot(p.vx, p.vz); const stam = p.stamina;
  hold("sprint", false); hold("up", false); step(1);
  assert.ok(walkSpeed > 1 && walkSpeed < 2.2, `walk ${walkSpeed}`);
  assert.ok(runSpeed > 3.5 && runSpeed < 5, `run ${runSpeed}`);
  assert.ok(sprintSpeed > 6, `sprint ${sprintSpeed}`);
  assert.ok(stam < 80, `stamina ${stam}`);
  assert.ok(Math.hypot(p.x - x0, p.z - z0) > 15, "moved");
});

test("G2 enter and exit a vehicle", () => {
  const { world, step, press } = makeWorld();
  const car = world.vehicles.find((v) => v.kind === "sports")!;
  world.player.x = car.x + 2; world.player.z = car.z;
  press("enter"); step(0.5);
  assert.equal(world.playerVehicle, car);
  assert.equal(world.reg.str("player.inVehicle"), "sports");
  press("enter"); step(0.5);
  assert.equal(world.playerVehicle, null);
  assert.equal(world.reg.str("player.inVehicle"), "on foot");
});

test("G3 five vehicle types have distinct measured handling", () => {
  const rows: Record<string, { top: number; t100: number; radius: number }> = {};
  for (const kind of ["sports", "sedan", "taxi", "police", "van"] as const) {
    const { world, step, hold } = makeWorld();
    world.reg.edit("world.population", 0);
    world.vehicles.length = 0;
    const v = world.spawnParked(kind, -140, -60, Math.PI); // empty Coastal-ish straight: Palmetto Ave heading north
    v.place(190 + 5, 175, Math.PI); // Ocean Boulevard northbound lane, long straight
    world.enterVehicle(v, true);
    hold("up");
    let t100 = -1, t = 0;
    step(14, (s) => { t = s; if (t100 < 0 && v.speed * 3.6 >= 80) t100 = s; if (v.z < -150) v.z += 300; });
    const top = v.speed * 3.6;
    hold("up", false);
    // turning circle at 30 km/h
    v.place(0, 0, 0); v.vx = 0; v.vz = 8.3; hold("left");
    const xs: number[] = [], zs: number[] = [];
    step(6, () => { xs.push(v.x); zs.push(v.z); v.throttle = (8.3 - v.speed) * 0.5; });
    hold("left", false);
    const radius = (Math.max(...xs) - Math.min(...xs) + Math.max(...zs) - Math.min(...zs)) / 4;
    rows[kind] = { top: Math.round(top), t100: +t100.toFixed(1), radius: +radius.toFixed(1) };
  }
  console.log("handling", JSON.stringify(rows));
  const tops = Object.values(rows).map((r) => r.top);
  assert.ok(new Set(tops).size === 5, "distinct top speeds");
  assert.ok(rows.sports.top > rows.police.top && rows.police.top > rows.taxi.top && rows.van.top < rows.sedan.top);
  assert.ok(rows.sports.t100 < rows.van.t100 || rows.van.t100 < 0);
});

test("G4/G5 crimes raise alert, police pursue, then escape after losing them", () => {
  const { world, step, reg } = makeWorld(11);
  const car = world.vehicles.find((v) => v.kind === "sports")!;
  world.enterVehicle(car, true);
  car.place(70, 2, -Math.PI / 2); // stopped on Pier Street
  reg.edit("player.alert", 2);
  world.police.lastSeen = world.t;
  let maxCops = 0, minDist = 1e9, sawSearch = false;
  step(25, () => {
    car.throttle = 0; car.handbrake = true; // sit still: cops close in
    const cops = world.vehicles.filter((v) => v.kind === "police" && v.driver === "ai" && !v.destroyed);
    maxCops = Math.max(maxCops, cops.length);
    for (const c of cops) minDist = Math.min(minDist, Math.hypot(c.x - car.x, c.z - car.z));
    if (world.police.state === "search") sawSearch = true;
  });
  assert.ok(maxCops >= 2, `police spawned: ${maxCops}`);
  assert.ok(minDist < 20 || world.stats.busted > 0, `police closed in: ${minDist.toFixed(1)} busted ${world.stats.busted}`);
  // now escape: teleport far away and hide behind buildings
  const { world: w2, step: step2, reg: reg2 } = makeWorld(12);
  const car2 = w2.vehicles.find((v) => v.kind === "sports")!;
  w2.enterVehicle(car2, true);
  reg2.edit("player.alert", 1);
  w2.police.lastSeen = w2.t;
  step2(3);
  car2.place(-120, 220, 0); // tuck into the hideout yard, far from units
  let escaped = false;
  step2(60, () => { if (w2.police.alert === 0) escaped = true; if (w2.police.state === "search") sawSearch = true; car2.throttle = 0; });
  assert.ok(escaped, `escaped: alert ${w2.police.alert} state ${w2.police.state}`);
  assert.ok(sawSearch, "police searched when sight was lost");
});

test("G4 hitting pedestrians raises the alert level", () => {
  const { world, step } = makeWorld(5);
  step(5);
  const car = world.vehicles.find((v) => v.kind === "sports")!;
  world.enterVehicle(car, true);
  let hits = 0;
  for (let i = 0; i < 40 && world.police.alert === 0; i++) {
    const ped = world.peds.find((p) => p.pose !== "knocked");
    if (!ped) { step(1); continue; }
    car.place(ped.x, ped.z - 4.5, 0);
    car.vx = 0; car.vz = 14;
    step(1.2, () => { car.throttle = 1; car.steerInput = 0; });
    hits = world.stats.pedsHit;
  }
  assert.ok(hits > 0, "hit a pedestrian");
  assert.ok(world.police.alert > 0, `alert ${world.police.alert}`);
});

test("G6 delivery logic: objectives, cargo damage, reward (vehicle placed at each drop; driving skill not tested here)", () => {
  const { world, step, reg } = makeWorld(21);
  const cash0 = reg.num("player.cash");
  world.missions.start("delivery", true);
  step(0.5);
  const van = world.vehicles.find((v) => v.tag.mission)!;
  world.enterVehicle(van, true);
  step(0.5);
  assert.match(world.missions.running!.objective, /Palmetto Market/);
  van.addDamage(100, 0, 1); // a dent costs cargo
  step(0.2);
  for (const poi of [world.city.pois.market, world.city.pois.meridian]) {
    van.place(poi.x, poi.z, 0);
    step(1);
  }
  const rec = world.missions.records.get("delivery")!;
  assert.equal(rec.status, "complete", rec.lastResult);
  assert.ok(reg.num("player.cash") > cash0, "paid");
  assert.ok(rec.reward < Math.round(reg.rule("MissionReward")), "cargo damage reduced the reward");
});

test("G6 race logic: countdown, checkpoints in order, 1st place pays (car placed at each checkpoint)", () => {
  const { world, step, reg } = makeWorld(21);
  world.missions.start("race", true);
  const car = world.playerVehicle!;
  step(1);
  assert.ok(world.controlsLocked, "countdown locks controls");
  step(3);
  assert.ok(!world.controlsLocked, "GO releases controls");
  const cps = world.missions.raceCheckpoints();
  for (const c of cps) {
    car.place(c.x, c.z, car.heading);
    step(0.3);
  }
  const rec = world.missions.records.get("race")!;
  assert.equal(rec.status, "complete", rec.lastResult);
  assert.match(rec.lastResult, /1st/);
  assert.ok(reg.num("player.cash") > 250);
});

test("G6 escape logic: steal -> 3 stars -> police search -> lose them -> lock up (deterministic placement, real police logic)", () => {
  const { world, step, reg } = makeWorld(22);
  reg.edit("world.spawn.police", 0);
  world.missions.start("escape", true);
  step(0.5);
  const car = world.vehicles.find((v) => v.tag.prototype)!;
  world.enterVehicle(car, true);
  step(0.5);
  assert.ok(world.police.stars >= 3, `stars ${world.police.stars}`);
  car.place(150, -178.2, Math.PI / 2); // out of sight on Aster Street
  let searched = false;
  const spots = [[150, -178.2, Math.PI / 2], [-140, -178.2, Math.PI / 2], [-148.2, 60, Math.PI]];
  let k = 0;
  step(150, () => {
    if (world.police.state === "search") searched = true;
    // if a unit finds us, a player would flee: relocate to another out-of-sight spot
    if (world.police.state === "pursuit" && world.police.stars > 0) { const [x, z, h] = spots[++k % 3]; car.place(x, z, h); world.police.lastSeen -= 3; }
  });
  assert.ok(searched, "police searched");
  assert.ok(world.police.stars === 0, "heat lost");
  assert.match(world.missions.running!.objective, /hideout/);
  const h = world.city.pois.hideout;
  car.place(h.x, h.z, 0);
  step(1);
  const rec = world.missions.records.get("escape")!;
  assert.equal(rec.status, "complete", rec.lastResult);
});

test("G6 race can be won by a physics-driven scripted driver (at least 1 of 3 seeds)", () => {
  let wins = 0;
  const results: string[] = [];
  for (const seed of [21, 22, 24]) {
    const { world, step, reg } = makeWorld(seed);
    reg.edit("world.population", 0.15);
    reg.edit("world.difficulty", 0.6);
    world.missions.start("race", true);
    const car = world.playerVehicle!;
    world.autopilot = autopilot(world, car, () => world.missions.target, 32, world.missions.raceLegs());
    step(120, () => {});
    const rec = world.missions.records.get("race")!;
    results.push(`${seed}:${rec.status}:${rec.lastResult}`);
    if (rec.status === "complete") wins++;
  }
  console.log("scripted race", results.join(" | "));
  assert.ok(wins >= 1, results.join(" | "));
});

test("G7 race fails when the player leaves the car or runs out of time", () => {
  const { world, step } = makeWorld(5);
  world.missions.start("race", true);
  step(4);
  world.exitVehicle();
  step(12);
  const rec = world.missions.records.get("race")!;
  assert.equal(rec.status, "failed");
  assert.match(rec.lastResult, /Left the race/);
  world.missions.restart();
  assert.equal(rec.status, "active");
});

test("G7 escape fails when the prototype is destroyed, and restarts", () => {
  const { world, step } = makeWorld(6);
  world.missions.start("escape", true);
  step(0.5);
  const car = world.vehicles.find((v) => v.tag.prototype)!;
  world.enterVehicle(car, true);
  step(0.5);
  car.addDamage(1e6, 0, 0);
  step(8);
  const rec = world.missions.records.get("escape")!;
  assert.equal(rec.status, "failed");
  world.missions.restart();
  assert.equal(rec.status, "active");
});

test("G7 delivery fails when the van is wrecked, and restarts", () => {
  const { world, step, reg } = makeWorld(3);
  world.missions.start("delivery", true);
  const van = world.vehicles.find((v) => v.tag.mission)!;
  world.enterVehicle(van, true);
  van.health = 1; van.addDamage(50, 0, 0);
  step(8);
  const rec = world.missions.records.get("delivery")!;
  assert.equal(rec.status, "failed");
  world.missions.restart();
  assert.equal(rec.status, "active");
  assert.equal(rec.attempts, 2);
  void reg;
});

test("G8 traffic stops at red lights; pedestrians walk pavements and dive away from cars", () => {
  const { world, step } = makeWorld(8);
  let stoppedAtRed = 0;
  step(60, () => { for (const v of world.vehicles) { const d = world.driverOf(v); if (d?.waitingAtRed && Math.abs(v.speed) < 0.3) stoppedAtRed++; } });
  assert.ok(stoppedAtRed > 100, `stopped samples ${stoppedAtRed}`);
  // pedestrians stay off the carriageway except on crossings
  const onRoad = world.peds.filter((p) => world.city.edges.some((e) => e.pts.length === 2 && Math.abs((e.pts[0].x === e.pts[1].x ? p.x - e.pts[0].x : p.z - e.pts[0].z)) < e.halfWidth - 1 && (e.pts[0].x === e.pts[1].x ? p.z > Math.min(e.pts[0].z, e.pts[1].z) + 12 && p.z < Math.max(e.pts[0].z, e.pts[1].z) - 12 : p.x > Math.min(e.pts[0].x, e.pts[1].x) + 12 && p.x < Math.max(e.pts[0].x, e.pts[1].x) - 12))).length;
  assert.ok(onRoad <= 2, `peds mid-road ${onRoad}/${world.peds.length}`);
  // dive: drive at a pedestrian and check they flee before impact
  const ped = makePed(world.city, world.rand, 221, 60)!;
  ped.x = 221; ped.z = 60;
  world.peds.push(ped);
  const car = world.vehicles.find((v) => v.kind === "sports")!;
  world.enterVehicle(car, true);
  car.place(ped.x, ped.z - 25, 0); car.vz = 12;
  let fled = false;
  step(1.5, () => { car.throttle = 0.6; if (ped.fleeing > 0) fled = true; });
  assert.ok(fled, "pedestrian reacted");
});

test("S4 spreadsheet edits change the simulation (max speed, traffic density, police budget)", () => {
  const measure = (edit: (r: any) => void) => {
    const { world, step, hold, reg } = makeWorld(4);
    reg.edit("world.population", 0);
    edit(reg);
    world.vehicles.length = 0;
    const v = world.spawnParked("sports", 195, 175, Math.PI);
    world.enterVehicle(v, true);
    hold("up");
    step(10, () => { if (v.z < -150) v.z += 300; });
    return v.speed * 3.6;
  };
  const base = measure(() => {});
  const fast = measure((r) => r.edit("veh.sports.maxSpeed", 300));
  assert.ok(fast > base + 30, `max speed edit: ${base.toFixed(0)} -> ${fast.toFixed(0)} km/h`);
  const cars = (pop: number) => { const { world, step, reg } = makeWorld(6); reg.edit("world.population", pop); step(30); return world.vehicles.filter((v) => v.driver === "ai").length; };
  const lo = cars(0.2), hi = cars(2.5);
  assert.ok(hi > lo * 2, `traffic density ${lo} -> ${hi}`);
  const cops = (formula: string) => { const { world, step, reg } = makeWorld(9); reg.setRuleFormula("PoliceBudget", formula); reg.edit("player.alert", 2); world.police.lastSeen = 0; step(20, () => { world.police.lastSeen = world.t; }); return world.vehicles.filter((v) => v.kind === "police" && v.driver === "ai").length; };
  const c1 = cops("=1"), c6 = cops("=6");
  assert.ok(c6 > c1, `PoliceBudget formula: ${c1} -> ${c6}`);
});
