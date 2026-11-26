// Fieldbook, real-time sidebar edition (kept for npm run build:gsheets)
import { execFileSync } from "node:child_process";
execFileSync(process.execPath, ["scripts/gsheets-port.mjs", "--game", "examples/fieldbook/game.ts", "--mode", "sidebar", "--out", "dist/gsheets"], { stdio: "inherit" });
