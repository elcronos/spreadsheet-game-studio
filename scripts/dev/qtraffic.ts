import { makeWorld } from "../../tests/quayside/harness";
const { w, step } = await makeWorld(3);
step(3);
for (const c of w.cars.slice(0, 5)) {
  const v = c.v;
  console.log(v.kind, v.x.toFixed(1), v.z.toFixed(1), "cls", w.raster.at(v.x, v.z), "thr", v.throttle.toFixed(2), "steer", v.steerInput.toFixed(2), "v", Math.hypot(v.vx, v.vz).toFixed(2), "driver", v.driver, "destroyed", v.destroyed, "health", v.health);
}
