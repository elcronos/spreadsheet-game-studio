import { makeWorld } from "../../tests/gridlock/harness";
import { signalFor } from "../../examples/gridlock-city/src/sim/nav";
const { world, step } = makeWorld();
let slowAtRed = 0, samples = 0, passRed = 0;
step(90, (t) => {
  if (Math.round(t * 60) % 30) return;
  for (const v of world.vehicles) {
    const d = world.driverOf(v); if (!d || v.driver !== "ai") continue;
    let acc = 0, px = v.x, pz = v.z;
    for (const w of d.wps) { acc += Math.hypot(w.x - px, w.z - pz); px = w.x; pz = w.z; if (w.stopNode !== undefined) { const L = signalFor(world.city.nodes[w.stopNode], w.axis!, world.t); if (acc < 15 && L === "red") { samples++; if (Math.abs(v.speed) < 1) slowAtRed++; if (acc < 3 && v.speed > 5) { passRed++; if (passRed < 6) console.log(v.kind, JSON.stringify(d.opts), (d as any).assertive, (d as any).reverseTimer, w.axis, acc.toFixed(1), v.speed.toFixed(1)); } } break; } }
  }
});
console.log({ samples, slowAtRed, passRed, waited: world.vehicles.filter(v=>v.tag.waited).length });
