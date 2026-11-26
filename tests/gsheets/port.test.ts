// The port is generic: Cell Catch (the template game) gets a working turn edition with no game-specific glue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { execute, makeBook, tap, useCode } from "./fake-gas";
import { readFileSync, existsSync } from "node:fs";

execFileSync(process.execPath, ["scripts/gsheets-port.mjs", "--game", "examples/cell-catch/game.ts", "--mode", "both", "--out", ".build/port-cell-catch"]);

test("port CLI builds both editions for the template game", () => {
  for (const f of ["turn/Code.gs", "turn/INSTALL.md", "sidebar/Code.gs", "sidebar/Sidebar.html", "sidebar/INSTALL.md"]) assert.ok(existsSync(".build/port-cell-catch/" + f), f);
  const html = readFileSync(".build/port-cell-catch/sidebar/Sidebar.html", "utf8");
  assert.match(html, /Cell Catch \(Google Sheets edition\)/);
  assert.ok(!html.includes("__TITLE__") && !readFileSync(".build/port-cell-catch/sidebar/Code.gs", "utf8").includes("__TITLE__"));
});

test("generic turn edition: setup, taps move the paddle, score sheet updates, frame painted", () => {
  useCode(".build/port-cell-catch/turn/Code.gs");
  try {
    const book = makeBook();
    execute(book, "setupGame");
    for (const n of ["GAME", "PLAYER", "WORLD", "RULES", "LOG", "_STATE"]) assert.ok(book.byName(n), n);
    const g = book.byName("GAME")!;
    // 4 controls over 160 columns, no Steps dropdown: 40 columns each
    for (const c of [1, 41, 81, 121]) assert.ok(g.cell(4, c).checkbox, "checkbox at " + c);
    const key = () => [...book.cache.keys()][0];
    const x0 = (JSON.parse(book.cache.get(key())!).game as { x: number }).x;
    tap(book, "GAME", 4, 41); // right
    tap(book, "GAME", 4, 41);
    const s1 = JSON.parse(book.cache.get(key())!);
    assert.ok(s1.game.x > x0, `paddle moved ${x0} -> ${s1.game.x}`);
    for (let i = 0; i < 12; i++) tap(book, "GAME", 4, 81); // wait: cells fall
    const s2 = JSON.parse(book.cache.get(key())!);
    assert.ok(s2.game.t > 5, "time advanced");
    assert.match(String(g.cell(1, 1).v), /SCORE \d+ · LEVEL 1/);
    const fills = new Set([...g.cells.entries()].filter(([k]) => +k.split(",")[0] > 4).map(([, c]) => c.bg));
    assert.ok(fills.size >= 3, "background, paddle and drops painted");
  } finally {
    useCode("dist/gsheets-phone/Code.gs");
  }
});
