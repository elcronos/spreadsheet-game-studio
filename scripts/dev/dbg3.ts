import { makeWorld, autopilot } from "../../tests/gridlock/harness";
const id = (process.argv[2] ?? "race") as any;
const { world, step, reg } = makeWorld(21);
reg.edit("world.population", 0.15);
if (id === "race") reg.edit("world.difficulty", 0.6);
world.missions.start(id, true);
let pilot: any = null; let n = 0;
const origImpact = (world as any).onImpact.bind(world);
(world as any).onImpact = (e: any) => { if (e.vehicle === world.playerVehicle || e.other === world.playerVehicle) console.log("IMPACT", world.t.toFixed(1), e.speed.toFixed(1), e.other ? "car:" + e.other.kind : "static", "at", e.x.toFixed(0), e.z.toFixed(0), "hp", world.playerVehicle?.health.toFixed(0)); origImpact(e); };
step(200, () => {
  const rec = world.missions.records.get(id)!;
  if (rec.status !== "active") return;
  if (!world.playerVehicle) { const v = world.vehicles.find((v) => v.tag.mission)!; world.player.x = v.x + 2; world.player.z = v.z; world.enterVehicle(v); pilot = null; world.autopilot = null; return; }
  if (!pilot) { pilot = autopilot(world, world.playerVehicle, () => world.missions.target, id === "race" ? 25 : 17, id === "race" ? world.missions.raceLegs() : undefined); world.autopilot = pilot; }
  if (n++ % 300 === 0) { const v = world.playerVehicle; console.log(world.t.toFixed(1), v.x.toFixed(1), v.z.toFixed(1), "spd", v.speed.toFixed(1), "hp", v.health.toFixed(0), world.missions.running?.objective, world.missions.running?.progress, "plan", pilot.driver.plan.length, "leg", world.city.edges[pilot.driver.leg.edge].name, pilot.driver.leg.dir, "wps", pilot.driver.wps.length); }
});
console.log(world.missions.records.get(id));
const v = world.playerVehicle!;
console.log("heading", v.heading.toFixed(2), "obstacles", JSON.stringify(world.obstaclesNear(v).map(o => ({ id: o.id, dx: +(o.x - v.x).toFixed(1), dz: +(o.z - v.z).toFixed(1), r: o.r }))));
const near = world.vehicles.filter(o => o !== v && Math.hypot(o.x - v.x, o.z - v.z) < 15).map(o => ({ kind: o.kind, driver: o.driver, dx: +(o.x - v.x).toFixed(1), dz: +(o.z - v.z).toFixed(1), spd: o.speed.toFixed(1), mission: o.tag.mission }));
console.log(JSON.stringify(near));
