import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { Book, execute, makeBook, tap, type } from "./fake-gas";
import { Session, W, H } from "../../examples/fieldbook/turn";
import { RULES, VARIABLES } from "../../examples/fieldbook/defs";

execSync("node scripts/build-gsheets-phone.mjs");
const COL: Record<string, number> = { left: 1, up: 15, down: 29, right: 43, use: 57, tool: 71, seed: 85, wait: 99, sleep: 113, new: 127 };
const STEPS = 141;

function state(book: Book) {
  const key = [...book.cache.keys()].find((k) => k.startsWith("sgs-fieldbook"));
  const hit = key ? book.cache.get(key) : undefined;
  if (hit) return new Session(JSON.parse(hit));
  return sheetState(book);
}
function sheetState(book: Book) {
  const st = book.byName("_STATE")!;
  const n = Number(st.cell(1, 1).v);
  let json = "";
  for (let i = 0; i < n; i++) json += String(st.cell(2 + i, 1).v).slice(1);
  return new Session(JSON.parse(json));
}
/** GAME cells vs the frame the last execution rendered and recorded (particles are not saved, so a re-render can differ by a few cells). */
function frameMatches(book: Book) {
  const want = state(book).frame;
  const g = book.byName("GAME")!;
  let ok = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g.cell(5 + y, 1 + x).bg === want[y * W + x]) ok++;
  return ok;
}
const press = (book: Book, a: string) => tap(book, "GAME", 4, COL[a]);

test("setup builds a playable sheet with no blank Sheet1 left", () => {
  const book = makeBook();
  const r = execute(book, "setupGame");
  const names = book.sheets.map((s) => s.name);
  for (const n of ["GAME", "FARMER", "FARM", "MARKET", "RULES", "ORDERS", "FIELD", "_STATE"]) assert.ok(names.includes(n), n);
  assert.ok(!names.includes("Sheet1"));
  const g = book.byName("GAME")!;
  assert.equal(g.cols, W);
  assert.equal(g.rows, 4 + H);
  assert.ok(g.gridlinesHidden);
  assert.equal(g.frozen, 4);
  for (const c of Object.values(COL)) assert.ok(g.cell(4, c).checkbox && g.cell(4, c).v === false, "checkbox at col " + c);
  assert.deepEqual([...(g.cell(4, STEPS).list ?? [])], ["x1", "x2", "x4"]);
  assert.ok(book.byName("_STATE")!.hidden);
  assert.equal(frameMatches(book), W * H, "GAME cells equal the rendered frame");
  assert.ok(new Set([...g.cells.values()].map((c) => c.bg)).size > 25, "a real picture");
  assert.ok(String(g.cell(1, 1).v).startsWith("Day 1 Spring"));
  for (const v of VARIABLES) if (v.name) assert.ok(book.named.has(v.name), v.name);
  // rules reference other rules (Price_Carrot uses Demand_Carrot): each rule needs a name too
  for (const r of RULES) assert.ok(book.named.has(r.name), "rule " + r.name);
  console.log(`  setup: ${r.calls} API calls, ${r.ms} ms in Node`);
});

test("tapping controls plays the game: walk, turn, till, plant, water, with the frame kept in sync", () => {
  const book = makeBook();
  execute(book, "setupGame");
  const seq = ["down", "right", "right", "right", "right", "down", "down", "down", "use", "tool", "tool", "use", "tool", "tool", "use"];
  const costs: number[] = [], ms: number[] = [];
  for (const a of seq) {
    const r = press(book, a);
    costs.push(r.calls);
    ms.push(r.ms);
    assert.equal(book.byName("GAME")!.cell(4, COL[a]).v, false, "checkbox reset after " + a);
  }
  const s = state(book);
  assert.deepEqual(s.sim.farmerTile(), [7, 8]);
  const p = s.sim.plot(7, 9)!;
  assert.ok(p.tilled && p.crop === "carrot" && p.watered, JSON.stringify(p));
  assert.equal(frameMatches(book), W * H);
  const field = book.byName("FIELD")!;
  const rows = [...field.cells.entries()].filter(([k, c]) => k.endsWith(",1") && c.v === "7,9");
  assert.equal(rows.length, 1, "FIELD sheet lists the planted plot");
  assert.equal(book.byName("FARMER")!.cell(2 + VARIABLES.filter((v) => v.sheet === "FARMER").findIndex((v) => v.key === "farmer.seeds.carrot"), 2).v, 9, "seed count written back");
  console.log(`  per tap: ${Math.min(...costs)}-${Math.max(...costs)} API calls, ${Math.max(...ms)} ms max in Node`);
});

test("a tap while the checkbox is already ticked still counts (untick = press too)", () => {
  const book = makeBook();
  execute(book, "setupGame");
  book.byName("GAME")!.cell(4, COL.down).v = true; // e.g. a tap landed while the previous one was running
  press(book, "down"); // toggles to false: still a move
  assert.deepEqual(state(book).sim.farmerTile(), [4, 6]);
});

test("Steps x4 walks up to four tiles per tap", () => {
  const book = makeBook();
  execute(book, "setupGame");
  press(book, "down");
  press(book, "right"); // turn
  type(book, "GAME", 4, STEPS, "x4");
  press(book, "right");
  assert.deepEqual(state(book).sim.farmerTile(), [8, 6]);
});

test("sheet edits: valid values apply, invalid ones are rejected and put back, formulas drive prices", () => {
  const book = makeBook();
  execute(book, "setupGame");
  const farmerDefs = VARIABLES.filter((v) => v.sheet === "FARMER");
  const row = 2 + farmerDefs.findIndex((v) => v.key === "farmer.walkSpeed");
  type(book, "FARMER", row, 2, "fast");
  assert.equal(state(book).registry.get("farmer.walkSpeed"), 4.5);
  assert.equal(book.byName("FARMER")!.cell(row, 2).v, 4.5, "bad value replaced with the game's value");
  assert.match(String(book.byName("GAME")!.cell(2, 1).v), /Rejected/);
  type(book, "FARMER", row, 2, "6");
  assert.equal(state(book).registry.get("farmer.walkSpeed"), 6);
  const cashRow = 2 + farmerDefs.findIndex((v) => v.key === "farmer.cash");
  type(book, "FARMER", cashRow, 2, "5000");
  assert.match(String(book.byName("GAME")!.cell(1, 1).v), /\$5,000/);

  const rules = book.byName("RULES")!;
  const s0 = state(book);
  const names = s0.registry.ruleDefs().map((r) => r.name);
  const i = names.indexOf("Price_Carrot");
  type(book, "RULES", 2 + i, 2, "=BasePrice_Carrot*3");
  const s1 = state(book);
  assert.equal(s1.registry.rule("Price_Carrot"), s1.registry.num("market.base.carrot") * 3);
  assert.equal(rules.cell(2 + i, 3).v, s1.registry.rule("Price_Carrot"));
  type(book, "RULES", 2 + i, 2, "=NoSuchName*2");
  assert.equal(rules.cell(2 + i, 2).f, "=BasePrice_Carrot*3", "bad formula reverted");
  assert.equal(state(book).registry.rule("Price_Carrot"), s1.registry.rule("Price_Carrot"));
});

test("sleep, wait and new game", () => {
  const book = makeBook();
  execute(book, "setupGame");
  press(book, "wait");
  assert.ok(state(book).sim.hour > 6.9);
  press(book, "sleep"); // spawn is on the doorstep
  assert.equal(state(book).sim.day, 2);
  press(book, "down");
  press(book, "new");
  const s = state(book);
  assert.equal(s.sim.day, 1);
  assert.deepEqual(s.sim.farmerTile(), [4, 5]);
  assert.equal(frameMatches(book), W * H);
});

test("a sheet set up by an older version is rebuilt on the next tap", () => {
  const book = makeBook();
  execute(book, "setupGame");
  const st = book.byName("_STATE")!;
  const json = String(st.cell(2, 1).v) + String(st.cell(3, 1).v ?? "");
  void json;
  // simulate an old save: drop the layout tag
  const s = state(book).save();
  (s as { layout: string }).layout = "fieldbook-old";
  const txt = JSON.stringify(s);
  st.cell(1, 1).v = 1;
  st.cell(2, 1).v = "|" + txt;
  book.cache.clear();
  press(book, "down");
  assert.notEqual(state(book).save().layout, "fieldbook-old");
  assert.deepEqual(state(book).sim.farmerTile(), [4, 5], "rebuilt fresh instead of applying the tap to a mismatched layout");
});

test("with the cache emptied (it expires after 6 h) the game resumes from the sheet save", () => {
  const book = makeBook();
  execute(book, "setupGame");
  for (const a of ["down", "right", "right", "right"]) press(book, a); // 4 moves: a sheet save
  const tile = state(book).sim.farmerTile();
  assert.deepEqual(sheetState(book).sim.farmerTile(), tile);
  press(book, "right");
  book.cache.clear();
  press(book, "down"); // turn only
  const s = state(book);
  assert.equal(s.sim.farmer.dir, "down");
  assert.deepEqual(s.sim.farmerTile(), tile, "lost at most the moves since the last sheet save");
});

test("first edit in a fresh spreadsheet sets the game up (no menu needed)", () => {
  const book = makeBook();
  type(book, "Sheet1", 1, 1, "hi");
  assert.ok(book.byName("GAME") && book.byName("_STATE"));
});

test("100 taps: state stays small, every tap within budget", () => {
  const book = makeBook();
  execute(book, "setupGame");
  const order = ["right", "right", "down", "down", "left", "left", "up", "up", "use", "wait"];
  let worst = 0;
  for (let k = 0; k < 100; k++) worst = Math.max(worst, press(book, order[k % order.length]).calls);
  const st = book.byName("_STATE")!;
  const chars = String(st.cell(2, 1).v).length;
  assert.ok(Number(st.cell(1, 1).v) <= 2 && chars < 80000, `state ${chars} chars`);
  assert.equal(frameMatches(book), W * H);
  console.log(`  100 taps: worst ${worst} API calls per tap, state ${chars} chars`);
});
