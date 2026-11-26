// Quayside gameplay tests: the real Elizabeth Quay map, headless (no renderer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CITY, G, LM } from "../../examples/quayside/src/map";
import { RasterCollider } from "../../examples/quayside/src/sim/collide";
import { loadRaster, makeWorld } from "./harness";

const W = (x: number, y: number): [number, number] => [x, -y];

test("map data: real landmarks sit on the right ground", async () => {
  const r = await loadRaster();
  assert.ok(CITY.buildings.length > 1000, "OSM buildings loaded");
  assert.equal(r.at(...W(0, -400)), G.WATER, "Perth Water south of the quay is river");
  assert.equal(r.at(...W(LM.spanda.x, LM.spanda.y)) === G.WATER, false, "Spanda stands on land");
  // the Elizabeth Quay footbridge is walkable but boats pass underneath it
  let foot = 0;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (r.cell(x, y) === G.FOOTBRIDGE) foot++;
  assert.ok(foot > 50, "footbridge cells exist");
});

test("colliders: cars stay out of the river, boats stay off the land", async () => {
  const r = await loadRaster();
  const land = new RasterCollider(r, "land"), water = new RasterCollider(r, "water");
  const [rx, rz] = W(0, -400);
  assert.ok(land.resolveCircle(rx, rz, 1.5), "a car in the river is pushed out");
  assert.equal(water.resolveCircle(rx, rz, 3), null, "a boat in open water is free");
  const [cx, cz] = W(200, 600);
  assert.ok(water.resolveCircle(cx, cz, 3), "a boat in the CBD is pushed out");
});

test("ferry timetable: Elizabeth Quay to Mends Street and back", async () => {
  const { w, step } = await makeWorld(3);
  const f = w.ferries[0];
  let arrived = -1, back = -1;
  for (let s = 0; s < 480 && back < 0; s++) {
    step(1);
    if (arrived < 0 && !f.atEQ && f.state === "docked") arrived = s;
    if (arrived >= 0 && back < 0 && f.atEQ && f.state === "docked") back = s;
  }
  assert.ok(arrived > 100 && arrived < 260, `reached Mends Street in ${arrived} s`);
  assert.ok(back > arrived, `came back to Elizabeth Quay at ${back} s`);
  assert.ok(f.health > 90, "no collisions on the route");
});

test("passenger: pay the fare, ride across, earn the crossing bonus, step ashore", async () => {
  const { w, step, reg } = await makeWorld(5);
  const f = w.ferries[0];
  Object.assign(w.player, { x: f.x + 6, z: f.z });
  step(0.2);
  assert.match(w.hint, /Board the ferry/);
  const cash0 = reg.num("player.cash");
  step(0.1, [], ["enter"]);
  assert.equal(w.mode, "passenger");
  assert.ok(reg.num("player.cash") < cash0, "fare taken");
  for (let s = 0; s < 300 && !w.mission?.done; s++) step(1);
  assert.equal(w.mission?.done, true, "crossing completed");
  assert.ok(reg.num("player.cash") > cash0, "bonus paid");
  step(0.1, [], ["enter"]);
  assert.equal(w.mode, "foot");
  assert.notEqual(w.raster.at(w.player.x, w.player.z), G.WATER, "landed on the jetty, not in the river");
});

test("heist: steal the ferry, police boats respond, docking at Mends Street pays out", async () => {
  const { w, step, reg } = await makeWorld(7);
  const f = w.ferries.find((x) => x.state === "docked") ?? w.ferries[0];
  Object.assign(w.player, { x: f.x + 5, z: f.z });
  step(0.1, [], ["hijack"]);
  assert.equal(w.mode, "helm");
  assert.ok(reg.num("player.heat") >= 3, "a wanted level for stealing a ferry");
  assert.equal(w.mission?.id, "heist");
  step(20, ["up"]);
  assert.ok(w.police.length > 0, "river police launched");
  // bring the ferry alongside the Mends Street jetty, stopped
  const ferry = w.boat!;
  const [mx, mz] = w.mendsBerth;
  Object.assign(ferry, { x: mx, z: mz, speed: 0 });
  const cash0 = reg.num("player.cash");
  step(0.5);
  assert.equal(w.mission?.done, true, "heist completed");
  assert.equal(reg.num("player.cash") - cash0, reg.rule("HeistReward"), "paid the HeistReward rule");
});

test("traffic keeps moving on the real street grid (drives on the left)", async () => {
  const { w, step } = await makeWorld(11);
  step(60);
  assert.ok(w.cars.length >= 15, `${w.cars.length} cars spawned`);
  const stopped = w.cars.filter((c) => !c.police && Math.hypot(c.v.vx, c.v.vz) < 0.5).length;
  assert.ok(stopped / w.cars.length < 0.4, `${stopped} of ${w.cars.length} stopped`);
  for (const c of w.cars) assert.notEqual(w.raster.at(c.v.x, c.v.z), G.WATER, "no car in the river");
});

test("editable rules change the game: TrafficDensity scales the TrafficCars rule", async () => {
  const { reg } = await makeWorld(1);
  const base = reg.rule("TrafficCars");
  const res = reg.edit("world.traffic", 0.5);
  assert.ok(res.ok, "the sheet accepts the edit");
  assert.ok(reg.rule("TrafficCars") < base);
});
