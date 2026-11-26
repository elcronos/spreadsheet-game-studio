// Scripted-driver completion rates over seeds (physics-driven autopilot; weaker than a human player).
//   node --import tsx scripts/eval-missions.ts  -> evals/results/missions-scripted.json
import { writeFileSync, mkdirSync } from "node:fs";
import { runMission } from "./dev/mission-run";
const out: Record<string, unknown> = { note: "Autopilot drives with the same vehicle physics as the player through traffic (population 0.15). Escape: after stealing the car, the scripted player relocates out of sight once; police search, star decay and the drive to the hideout are real.", seeds: [21, 22, 23, 24, 25, 26, 27, 28] };
for (const id of ["race", "delivery", "escape"] as const) {
  const rows = (out.seeds as number[]).map((s) => { const r = runMission(id, s); return { seed: s, status: r.rec.status, result: r.rec.lastResult, reward: r.rec.reward }; });
  out[id] = { completed: rows.filter((r) => r.status === "complete").length, of: rows.length, rows };
  console.log(id, (out[id] as any).completed, "/", rows.length);
}
mkdirSync("evals/results", { recursive: true });
writeFileSync("evals/results/missions-scripted.json", JSON.stringify(out, null, 2));
