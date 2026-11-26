import { runMission } from "./mission-run";
const id = process.argv[2] as any;
const res: string[] = [];
for (let s = 21; s < 29; s++) { const r = runMission(id, s, false, process.argv[3] === "inv"); res.push(`${s}:${r.rec.status === "complete" ? "OK" : r.rec.lastResult}`); }
console.log(id, res.join(" | "));
