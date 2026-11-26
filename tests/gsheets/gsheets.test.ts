import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCodeGs } from "./fake-apps-script";
import { dirtyRects, norm } from "../../renderers/gsheets/client";
import { VARIABLES, RULES } from "../../examples/fieldbook/defs";

const manifest = { title: "Fieldbook", width: 80, height: 45, cellPx: 8, variables: VARIABLES, rules: RULES, sheets: [{ name: "ORDERS", columns: ["Order", "Item"] }] };

test("setupLayout builds GAME, variable sheets, RULES with named ranges and real formulas", () => {
  const g = loadCodeGs();
  assert.equal(g.api.setupLayout(manifest).rebuilt, true);
  assert.equal(g.api.setupLayout(manifest).rebuilt, false, "layout reused on the next Play");
  const game = g.sheets.get("GAME")!;
  assert.ok(game.maxCols >= 80 && game.colW.get(80) === 8 && game.rowH.get(4 + 44) === 8);
  for (const s of new Set(VARIABLES.map((v) => v.sheet))) assert.ok(g.sheets.get(s), s);
  for (const v of VARIABLES) if (v.name) assert.ok(g.named.has(v.name), v.name);
  const rules = g.sheets.get("RULES")!;
  RULES.forEach((r, i) => assert.equal(rules.cell(2 + i, 2).f, r.formula));
});

test("applyFrame paints rectangles, writes live values, returns the player's edits", () => {
  const g = loadCodeGs();
  g.api.setupLayout(manifest);
  g.log.length = 0;
  const colors = [["#112233", "#445566"], ["#778899", "#aabbcc"]];
  const v0 = VARIABLES.find((v) => v.sheet === "FARMER")!;
  const res = g.api.applyFrame({ rects: [{ r: 10, c: 20, colors }], hud: { lines: ["a", "b", "c"] }, values: { [v0.key]: 123 }, ruleValues: {}, sheets: null });
  const game = g.sheets.get("GAME")!;
  assert.equal(game.cell(4 + 10, 1 + 20).bg, "#112233");
  assert.equal(game.cell(4 + 11, 1 + 21).bg, "#aabbcc");
  assert.equal(res.values[v0.key], 123);
  // calls per update: one setBackgrounds per rect, one read+write per variable sheet, one formula read
  const counts = g.log.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {} as Record<string, number>);
  assert.equal(counts.setBackgrounds, 1);
  // the player types into the sheet; the next update returns it
  const farmer = g.sheets.get("FARMER")!;
  farmer.cell(2, 2).v = 999;
  const res2 = g.api.applyFrame({ rects: [], hud: null, values: null, ruleValues: {}, sheets: null });
  assert.equal(res2.values[v0.key], 999);
});

test("dirty rectangles cover every changed cell and stay few", () => {
  const w = 80, h = 45;
  const a = new Uint32Array(w * h), b = new Uint32Array(w * h);
  for (const [x, y] of [[1, 1], [70, 2], [5, 30], [6, 31], [40, 44]]) b[y * w + x] = 0xff0000;
  const rects = dirtyRects(a, b, w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (a[y * w + x] !== b[y * w + x]) assert.ok(rects.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1));
  assert.ok(rects.length <= 6);
  assert.equal(dirtyRects(null, b, w, h).length, 1, "first frame is one full rectangle");
  assert.equal(dirtyRects(b, b, w, h).length, 0);
  assert.equal(norm(true), "TRUE");
  assert.equal(norm("2.50"), "2.5");
});
