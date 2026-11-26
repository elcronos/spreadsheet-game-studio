/**
 * Writes tests/excel/fixtures/sample_hello.json: a realistic `hello` manifest
 * (Gridlock City variables and rules, fixed 64-colour palette, 80x45 frame).
 * The JSON is committed; re-run only to refresh it from the game config.
 *
 *   node --import tsx tests/excel/gen_sample_hello.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VARIABLES, RULES } from "../../examples/gridlock-city/src/config";
import { fixedPalette64 } from "../../renderers/framebuffer/quantize";

const here = dirname(fileURLToPath(import.meta.url));
const hello = {
  t: "hello",
  game: "gridlock-city",
  title: "Gridlock City",
  width: 80,
  height: 45,
  origin: { col: 0, row: 3 },
  palette: Array.from(fixedPalette64()),
  paletteMode: "fixed64",
  variables: VARIABLES,
  rules: RULES,
  sheets: [{ name: "MISSIONS", columns: ["#", "Mission", "Status", "Reward", "Best time", "Notes"] }],
  controls: [
    ["WASD / arrows", "Move / drive"],
    ["Shift", "Sprint"],
    ["Space", "Handbrake / jump"],
    ["F", "Enter / exit vehicle"],
    ["H", "Horn"],
    ["R", "Restart mission"],
  ],
  keyBindings: {
    KeyW: "up", ArrowUp: "up", KeyS: "down", ArrowDown: "down", KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right",
    ShiftLeft: "sprint", ShiftRight: "sprint", Space: "handbrake", KeyF: "enter", Enter: "enter", KeyH: "horn", KeyR: "restart",
    KeyC: "lookback", KeyQ: "camLeft", KeyE: "camRight", KeyV: "walk",
  },
};
writeFileSync(join(here, "fixtures", "sample_hello.json"), JSON.stringify(hello, null, 1) + "\n");
console.log(`sample_hello.json: ${VARIABLES.length} variables, ${RULES.length} rules`);
