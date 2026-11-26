import { makeWorld } from "../../tests/quayside/harness";
const { w, step, reg } = await makeWorld(5);
const f = w.ferries[0];
// stand on the jetty next to the docked ferry
Object.assign(w.player, { x: f.x + 6, z: f.z });
step(0.2);
console.log("hint:", w.hint);
const cash0 = reg.num("player.cash");
step(0.1, [], ["enter"]);
console.log("mode", w.mode, "mission", w.mission?.title, "cash", cash0, "->", reg.num("player.cash"));
for (let s = 0; s < 260 && !w.mission?.done; s++) step(1);
console.log("crossing done:", w.mission?.done, "cash", reg.num("player.cash"), "where", w.where(w.player.x, w.player.z), "| banner", w.banner);
step(0.1, [], ["enter"]);
console.log("after F: mode", w.mode, "player cls", w.raster.at(w.player.x, w.player.z));
// steal the ferry now docked at Mends: walk back aboard and press G
const fm = w.ferries.find((x) => x.state === "docked" && !x.atEQ) ?? w.ferries[0];
Object.assign(w.player, { x: fm.x + 5, z: fm.z });
step(0.1, [], ["hijack"]);
console.log("hijack: mode", w.mode, "heat", reg.num("player.heat"), "mission", w.mission?.title);
// steer towards Elizabeth Quay's river mouth for 40 s at full throttle
const target = [0, -250];
for (let i = 0; i < 40 * 4; i++) {
  const b = w.boat!;
  const want = Math.atan2(target[0] - b.x, target[1] - b.z);
  const d = Math.atan2(Math.sin(want - b.heading), Math.cos(want - b.heading));
  step(0.25, ["up", ...(d > 0.1 ? ["left"] : d < -0.1 ? ["right"] : [])]);
}
console.log("stolen ferry at", w.boat?.x.toFixed(0), w.boat?.z.toFixed(0), "speed", w.boat?.speed.toFixed(1), "police boats", w.police.length, "nearest", Math.min(...w.police.map((p) => Math.hypot(p.x - w.boat!.x, p.z - w.boat!.z))).toFixed(0), "heat", reg.num("player.heat"), "busted t", w.bustedT.toFixed(1));
