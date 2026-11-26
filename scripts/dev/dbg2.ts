import { makeWorld, autopilot } from "../../tests/gridlock/harness";
const { world, step, reg } = makeWorld(21);
reg.edit("world.population", 0.4);
world.missions.start("delivery", true);
let pilot: any = null; let n = 0;
step(60, () => {
  if (!world.playerVehicle) { const v = world.vehicles.find((v) => v.tag.mission)!; world.player.x = v.x + 2; world.player.z = v.z; world.enterVehicle(v); return; }
  if (!pilot) pilot = autopilot(world, world.playerVehicle, () => world.missions.target, 17);
  world.autopilot = pilot;
  if (n++ % 120 === 0) { const v = world.playerVehicle; const d = world.driverOf(v); console.log(world.t.toFixed(1), v.x.toFixed(1), v.z.toFixed(1), "spd", v.speed.toFixed(1), "thr", v.throttle.toFixed(2), "st", v.steerInput.toFixed(2), "tgt", JSON.stringify(world.missions.target), world.missions.running?.objective); }
});
