import { test } from "node:test";
import assert from "node:assert/strict";
import { compileFormula } from "../engines/core/formula";
import { VariableRegistry } from "../engines/core/variables";
import { Quantizer, fixedPalette64 } from "../renderers/framebuffer/quantize";
import { diffFrames, writtenCells } from "../renderers/framebuffer/diff";
import { encodeFrame, decodeFrame } from "../renderers/framebuffer/protocol";
import { FramePipeline } from "../renderers/framebuffer/pipeline";
import { columnName, parseCellAddress, cellAddress } from "../engines/core/frame";

test("column names", () => {
  assert.equal(columnName(0), "A");
  assert.equal(columnName(25), "Z");
  assert.equal(columnName(26), "AA");
  assert.equal(columnName(479), "RL");
  assert.deepEqual(parseCellAddress("RL273"), { col: 479, row: 272 });
  assert.equal(cellAddress(0, 0, 0, 3), "A4");
});

test("formula: arithmetic, functions, names, errors", () => {
  const known = (n: string) => ["Base", "Alert"].includes(n);
  const f = compileFormula("=Base*Alert + MAX(1, 2) ^ 2", known);
  assert.equal(f.evaluate((n) => (n === "Base" ? 3 : 2)), 10);
  assert.throws(() => compileFormula("=window.alert(1)", known), /Unknown/);
  assert.throws(() => compileFormula("=Foo+1", known), /Unknown name/);
  assert.throws(() => compileFormula("=1+", known));
  assert.throws(() => compileFormula("=" + "(".repeat(60) + "1" + ")".repeat(60), known), /deep/);
  assert.throws(() => compileFormula("=1/0", known).evaluate(() => 0), /DIV/);
  assert.equal(compileFormula("=IF(Alert>1, 5, 7)", known).evaluate(() => 2), 5);
  assert.equal(compileFormula("=MEDIAN(0, Alert, 1)", known).evaluate(() => 4), 1);
});

test("registry: validation, rules, cycles", () => {
  const r = new VariableRegistry();
  r.define([
    { key: "a", sheet: "W", label: "A", name: "Alpha", type: "number", default: 2, min: 0, max: 10 },
    { key: "w", sheet: "W", label: "Weather", type: "enum", default: "Clear", options: ["Clear", "Rain"] },
  ]);
  r.defineRules([
    { name: "Twice", formula: "=Alpha*2", min: 0, max: 100, description: "" },
    { name: "Plus", formula: "=Twice+1", min: 0, max: 100, description: "" },
  ]);
  assert.equal(r.rule("Plus"), 5);
  assert.equal(r.edit("a", "4").ok, true);
  assert.equal(r.rule("Plus"), 9);
  assert.equal(r.edit("a", "banana").ok, false);
  assert.equal(r.edit("a", 99).ok, false);
  assert.equal(r.num("a"), 4);
  assert.equal(r.edit("w", "rain").value, "Rain");
  assert.equal(r.setRuleFormula("Twice", "=Plus*2").ok, false, "cycle rejected");
  assert.equal(r.rule("Plus"), 9, "old rule kept after rejected cycle");
  assert.equal(r.setRuleFormula("Twice", "=Alpha/0").ok, true);
  assert.equal(r.rule("Twice"), 8, "runtime error keeps last good value");
  assert.match(r.snapshot().rules[0].error!, /DIV/);
});

function synth(w: number, h: number, t: number): Uint8Array {
  const a = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      a[o] = (x * 3 + t) & 255; a[o + 1] = (y * 5) & 255; a[o + 2] = ((x ^ y) + t * 2) & 255; a[o + 3] = 255;
    }
  return a;
}

test("quantizer maps to nearest palette entry", () => {
  const q = new Quantizer({ mode: "fixed64", colours: 64, hysteresis: 0, dither: false, adaptiveInterval: 10, flipY: false });
  const src = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255, 250, 250, 250, 255]);
  const out = new Uint8Array(3);
  q.quantize(src, 3, 1, out);
  const p = fixedPalette64();
  assert.equal(p[out[0]], 0xff0000);
  assert.equal(p[out[1]], 0x000000);
  assert.equal(p[out[2]], 0xffffff);
});

test("adaptive palette keeps error low", () => {
  const w = 160, h = 90;
  const q = new Quantizer({ mode: "adaptive", colours: 192, hysteresis: 0, dither: false, adaptiveInterval: 1, flipY: false });
  const src = synth(w, h, 0), out = new Uint8Array(w * h);
  q.quantize(src, w, h, out);
  const mse = Quantizer.mse(src, out, q.palette);
  assert.ok(mse < 120, `mse ${mse}`);
});

test("diff + protocol round trip reconstructs frame exactly", () => {
  const w = 160, h = 90;
  const p = new FramePipeline(w, h, { mode: "adaptive", hysteresis: 100 });
  const recon = new Uint8Array(w * h);
  let pal: Uint32Array | null = null;
  for (let t = 0; t < 30; t++) {
    const { frame, diff } = p.process(synth(w, h, t));
    const dec = decodeFrame(encodeFrame(frame, diff, diff.keyframe || t % 5 === 0 || true));
    if (dec.palette) pal = dec.palette;
    for (const r of dec.runs) recon.set(r.indices, r.row * w + r.x0);
    for (let i = 0; i < w * h; i++) assert.equal(pal![recon[i]], frame.palette[frame.indices[i]]);
  }
});

test("diff merges runs", () => {
  const a = new Uint8Array(20), b = new Uint8Array(20);
  b[2] = 1; b[5] = 1; b[15] = 1;
  const d = diffFrames(a, b, 20, 1, 4);
  assert.equal(d.changedCells, 3);
  assert.equal(d.runs.length, 2);
  assert.equal(writtenCells(d), 5);
});

test("formula: text variables compare as strings", () => {
  const r = new VariableRegistry();
  r.define([{ key: "w", sheet: "W", label: "Weather", name: "Weather", type: "enum", default: "Rain", options: ["Clear", "Rain"] }]);
  r.defineRules([{ name: "Wet", formula: '=IF(Weather="rain", 1, 0)', min: 0, max: 1, description: "" }]);
  assert.equal(r.rule("Wet"), 1);
  r.edit("w", "Clear");
  assert.equal(r.rule("Wet"), 0);
});

test("formula: Excel semantics found by the critic's fuzzing", () => {
  const known = (n: string) => n === "X";
  assert.equal(compileFormula("=IF(X=0, 0, 1/X)", known).evaluate(() => 0), 0, "IF is lazy");
  assert.equal(compileFormula("=ROUND(-2.5)", known).evaluate(() => 0), -3, "half away from zero");
  assert.equal(compileFormula("=FLOOR(7, 5)", known).evaluate(() => 0), 5);
  assert.throws(() => compileFormula('="12abc"*2', known).evaluate(() => 0), /VALUE/);
  assert.throws(() => compileFormula("=SQRT(-1)<>1", known).evaluate(() => 0), /NUM/);
  assert.throws(() => compileFormula("=10^400", known).evaluate(() => 0), /NUM/);
});

test("variables: strict number parsing", () => {
  const r = new VariableRegistry();
  r.define([{ key: "a", sheet: "W", label: "A", type: "number", default: 1, min: 0, max: 100000 }]);
  assert.equal(r.edit("a", "5abc").ok, false);
  assert.equal(r.edit("a", "0x5").ok, false);
  assert.equal(r.edit("a", "$1,250").value, 1250);
  assert.equal(r.edit("a", "50%").value, 50);
  assert.equal(r.edit("a", " 3.5e2 ").value, 350);
});

test("adaptive palette: colours written by diffs never drift more than the slot threshold (critic finding #1)", () => {
  const w = 160, h = 90;
  const p = new FramePipeline(w, h, { mode: "adaptive", colours: 96, hysteresis: 140, adaptiveInterval: 3 });
  const drawn = new Uint32Array(w * h); // what an out-of-process sink shows: colour at the time each cell was last written
  let worst = 0;
  for (let t = 0; t < 120; t++) {
    const src = synth(w, h, t * 3);
    const { frame, diff } = p.process(src);
    for (const r of diff.runs) for (let x = r.x0; x < r.x0 + r.length; x++) drawn[r.row * w + x] = frame.palette[frame.indices[r.row * w + x]];
    if (t < 5) continue;
    for (let i = 0; i < w * h; i++) {
      const a = drawn[i], b = frame.palette[frame.indices[i]];
      const d = ((a >> 16 & 255) - (b >> 16 & 255)) ** 2 + ((a >> 8 & 255) - (b >> 8 & 255)) ** 2 + ((a & 255) - (b & 255)) ** 2;
      if (d > worst) worst = d;
    }
  }
  assert.ok(worst <= 48, `max squared drift ${worst}`);
});
