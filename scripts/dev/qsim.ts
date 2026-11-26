import { makeWorld } from "../../tests/quayside/harness";
const { w, step } = await makeWorld(3);
const f0 = w.ferries[0], f1 = w.ferries[1];
let arrived = -1, back = -1;
const stuckHist: number[] = [];
for (let s = 0; s < 420; s++) {
  step(1);
  if (arrived < 0 && !f0.atEQ && f0.state === "docked") arrived = s;
  if (arrived >= 0 && back < 0 && f0.atEQ && f0.state === "docked") back = s;
  if (s % 60 === 59) stuckHist.push(w.cars.filter((c) => Math.hypot(c.v.vx, c.v.vz) < 0.5).length);
}
console.log("ferry0 EQ->Mends", arrived, "s, back at EQ", back, "s; health", f0.health.toFixed(0), "| ferry1", f1.state, f1.atEQ ? "EQ" : "Mends", f1.health.toFixed(0));
console.log("traffic", w.cars.length, "stopped per minute", stuckHist.join(","), "speeds", w.cars.slice(0, 8).map((c) => Math.hypot(c.v.vx, c.v.vz).toFixed(1)).join(" "));
