// Runs one mission with the scripted driver and logs progress: node --import tsx scripts/dev/mission-run.ts <id> [seed]
import { makeWorld, autopilot } from "../../tests/gridlock/harness";
export function runMission(id: "delivery" | "race" | "escape", seed = 21, log = false, invincible = false) {
  const { world, step, reg } = makeWorld(seed);
  reg.edit("world.population", 0.15);
  if (id === "escape") reg.edit("world.spawn.police", 0); // no random patrols stumbling on the hiding spot
  if (id === "race") reg.edit("world.difficulty", 0.6);
  if (invincible) reg.edit("player.invincible", true);
  world.missions.start(id, true);
  let pilot: any = null, hidden = false, n = 0;
  const orig = (world as any).onImpact.bind(world);
  (world as any).onImpact = (e: any) => { if (log && (e.vehicle === world.playerVehicle || e.other === world.playerVehicle) && e.speed > 6) console.log("  impact", world.t.toFixed(1), e.speed.toFixed(1), e.other?.kind ?? "static", Math.round(e.x), Math.round(e.z)); orig(e); };
  const limit = id === "delivery" ? 240 : id === "race" ? 260 : 300;
  step(limit, () => {
    const rec = world.missions.records.get(id)!;
    if (rec.status !== "active") return;
    const m = world.missions;
    if (!world.playerVehicle) {
      const v = world.vehicles.filter((v) => v.tag.mission && !v.destroyed).sort((a, b) => Math.hypot(a.x - world.player.x, a.z - world.player.z) - Math.hypot(b.x - world.player.x, b.z - world.player.z))[0];
      if (v) { world.player.x = v.x + 2; world.player.z = v.z; world.enterVehicle(v); pilot = null; world.autopilot = null; }
      return;
    }
    if (!pilot) { pilot = autopilot(world, world.playerVehicle, () => (id === "escape" && world.police.stars > 0 ? null : m.target), id === "race" ? 32 : 17, id === "race" ? m.raceLegs() : undefined); world.autopilot = pilot; }
    if (id === "escape" && world.police.stars > 0 && !hidden) { world.playerVehicle.place(150, -178.2, Math.PI / 2); pilot = null; hidden = true; }
    if (log && n++ % 600 === 0) { const v = world.playerVehicle; console.log(world.t.toFixed(0), Math.round(v.x), Math.round(v.z), "spd", v.speed.toFixed(1), "hp", Math.round(v.health), "|", m.running?.objective, "|", m.running?.progress, "| alert", world.police.alert, world.police.state); }
  });
  return { rec: world.missions.records.get(id)!, cash: reg.num("player.cash"), world };
}
if (process.argv[2]) { const r = runMission(process.argv[2] as any, +(process.argv[3] ?? 21), true); console.log(r.rec); }
