import { makeWorld } from "../../tests/gridlock/harness";
const { world, step, reg } = makeWorld(11);
const car = world.vehicles.find((v) => v.kind === "sports")!;
world.enterVehicle(car, true);
car.place(70, 2, -Math.PI / 2);
reg.edit("player.alert", 2);
world.police.lastSeen = world.t;
let n = 0;
step(25, () => {
  if (n++ % 150) return;
  const cops = world.vehicles.filter((v) => v.kind === "police" && v.driver === "ai");
  console.log(world.t.toFixed(1), world.police.state, "alert", world.police.alert.toFixed(2), "budget", world.reg.rule("PoliceBudget"), cops.map(c => `${(c.tag.cop as any)?.role}:${Math.hypot(c.x - car.x, c.z - car.z).toFixed(0)}m@${c.speed.toFixed(0)} (${c.x.toFixed(0)},${c.z.toFixed(0)}) h${c.heading.toFixed(1)} saw${(c.tag.cop as any)?.sawPlayer} wps${world.driverOf(c)?.wps.length} blk${world.driverOf(c)?.blocked.toFixed(1)}`).join(" "));
});
