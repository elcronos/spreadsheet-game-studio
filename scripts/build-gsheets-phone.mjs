// Fieldbook, turn-based phone edition (kept for npm run build:gsheets-phone)
import { execFileSync } from "node:child_process";
execFileSync(process.execPath, ["scripts/gsheets-port.mjs", "--game", "examples/fieldbook/turn.ts", "--mode", "turn", "--out", "dist/gsheets-phone"], { stdio: "inherit" });
