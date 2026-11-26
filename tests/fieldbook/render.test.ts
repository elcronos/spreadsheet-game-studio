import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeHarness, mulberry32, type Harness } from "./harness";
import { createFieldbook } from "../../examples/fieldbook/game";
import { StudioHost } from "../../engines/core/host";
import { emptyStats, type RenderBackend } from "../../engines/core/renderer";
import type { FrameDiff, IndexedFrame } from "../../engines/core/frame";
import type { StateSnapshot } from "../../engines/core/variables";

function distinct(buf: Uint8Array): number {
  const s = new Set<number>();
  for (let i = 0; i < buf.length; i += 4) s.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
  return s.size;
}

function frame(h: Harness, w: number, ht: number): Uint8Array {
  const out = new Uint8Array(w * ht * 4);
  h.game.renderCells(w, ht, out);
  return out;
}

test("renderCells works at 80x45, 160x90, 320x180 (and odd sizes) with non-trivial images", async () => {
  const h = await makeHarness(21);
  h.step(60);
  for (const [w, ht] of [[80, 45], [160, 90], [320, 180], [240, 135], [100, 100], [33, 17]] as const) {
    const out = frame(h, w, ht);
    assert.equal(out.length, w * ht * 4);
    const n = distinct(out);
    if (w >= 80) assert.ok(n > 20, `${w}x${ht}: ${n} colours`);
    else assert.ok(n > 3, `${w}x${ht}: ${n} colours`);
    for (let i = 3; i < out.length; i += 4) if (out[i] !== 255) assert.fail(`alpha at ${i}`);
  }
  // 320x180 is an exact 2x nearest-neighbour upscale of the 160x90 frame
  const a = frame(h, 160, 90);
  const b = frame(h, 320, 180);
  for (let y = 0; y < 90; y += 7)
    for (let x = 0; x < 160; x += 5)
      for (let c = 0; c < 3; c++) {
        const v = a[(y * 160 + x) * 4 + c];
        assert.equal(b[(2 * y * 320 + 2 * x) * 4 + c], v);
        assert.equal(b[((2 * y + 1) * 320 + 2 * x + 1) * 4 + c], v);
      }
});

test("scenes differ: night is darker than day, rain changes the frame, the camera follows the farmer", async () => {
  const h = await makeHarness(22, { "farm.rainChance": 0 });
  h.step(10);
  const lum = (buf: Uint8Array) => {
    let s = 0;
    for (let i = 0; i < buf.length; i += 4) s += buf[i] * 0.3 + buf[i + 1] * 0.59 + buf[i + 2] * 0.11;
    return s / (buf.length / 4);
  };
  h.registry.edit("farm.hour", 11);
  h.step();
  const day = frame(h, 160, 90);
  h.registry.edit("farm.hour", 23);
  h.step();
  const night = frame(h, 160, 90);
  assert.ok(lum(night) < lum(day) * 0.7, `night ${lum(night)} vs day ${lum(day)}`);
  h.registry.edit("farm.hour", 11);
  h.registry.edit("farm.weather", "Rain");
  h.step();
  const rain = frame(h, 160, 90);
  assert.notDeepEqual(rain, day);
  h.registry.edit("farm.weather", "Sunny");
  h.hold("down", 90);
  assert.notDeepEqual(frame(h, 160, 90), day);
});

async function scripted(seed: number): Promise<{ hash: string; state: string }> {
  const h = await makeHarness(seed, { "farm.dayLength": 40 });
  const script: [string, number][] = [["down", 20], ["right", 25], ["down", 30], ["use", 1], ["seed1", 1], ["use", 1], ["tool", 1], ["use", 1], ["left", 40], ["up", 50]];
  for (const [a, n] of script) h.hold(a, n);
  h.step(600); // passes a night (day length 40s): weather, eggs, orders all roll from ctx.random
  h.game.runCommand("skip-day");
  h.step(90);
  const out = frame(h, 160, 90);
  const sim = h.game.sim;
  const state = JSON.stringify({ day: sim.day, f: sim.farmer, eggs: sim.eggs, orders: sim.orders, chickens: sim.chickens, snap: h.registry.snapshot().values });
  return { hash: createHash("sha256").update(out).digest("hex"), state };
}

test("determinism: same seed => identical frame bytes and state after N steps", async () => {
  const a = await scripted(1234);
  const b = await scripted(1234);
  assert.equal(a.hash, b.hash);
  assert.equal(a.state, b.state);
  const c = await scripted(999);
  assert.notEqual(c.state, a.state, "a different seed gives a different world");
});

test("rendering does not consume the simulation RNG", async () => {
  const h1 = await makeHarness(77);
  const h2 = await makeHarness(77);
  for (let i = 0; i < 200; i++) {
    h1.step();
    h2.step();
    if (i % 3 === 0) frame(h1, 160, 90); // only h1 renders
  }
  h1.game.runCommand("skip-day");
  h2.game.runCommand("skip-day");
  assert.equal(JSON.stringify(h1.game.sim.chickens), JSON.stringify(h2.game.sim.chickens));
  assert.equal(h1.registry.str("farm.weather"), h2.registry.str("farm.weather"));
});

test("unchanged core: StudioHost + FramePipeline drive Fieldbook headless", async () => {
  const frames: IndexedFrame[] = [];
  let snap: StateSnapshot | null = null;
  const sink: RenderBackend = {
    id: "test-sink",
    label: "Test sink",
    capabilities: { cellFrames: true, directCanvas: false, measuredCellBudget: 0, input: false, stateEdit: true },
    async init() {},
    resize() {},
    submitFrame(f: IndexedFrame, _d: FrameDiff) {
      frames.push({ ...f, indices: f.indices.slice() });
      return true;
    },
    syncState(s) {
      snap = s;
    },
    stats: emptyStats,
    async shutdown() {},
  };
  const host = new StudioHost(createFieldbook(), { width: 160, height: 90, seed: 5 });
  host.directVisible = false;
  await host.init({} as HTMLElement);
  await host.addBackend(sink);
  let now = 1000;
  host.frame(now);
  for (let i = 0; i < 30; i++) host.frame((now += 1000 / 30));
  assert.ok(frames.length >= 30);
  const last = frames[frames.length - 1];
  assert.equal(last.width, 160);
  assert.ok(new Set(last.indices).size > 20, "quantised frame keeps > 20 palette entries");
  assert.ok(snap, "state synced to the backend");
  // spreadsheet edits through the host's patch path
  const errs = host.applyPatch({ "market.base.carrot": 30, "rule:Price_Carrot": "=BasePrice_Carrot*2", "rule:Price_Tomato": "=1+" , "farm.rainChance": "often" });
  assert.deepEqual(Object.keys(errs).sort(), ["farm.rainChance", "rule:Price_Tomato"]);
  assert.equal(host.registry.rule("Price_Carrot"), 60);
  host.input.apply({ type: "action", action: "down", down: true });
  for (let i = 0; i < 20; i++) host.frame((now += 1000 / 30));
  assert.ok(host.telemetry().entities > 1);
  host.setResolution(80, 45);
  host.frame((now += 1000 / 30));
  assert.equal(frames[frames.length - 1].width, 80);
  // StudioHost.shutdown() -> stop() calls cancelAnimationFrame unguarded (not defined in Node); shim it for this test.
  const g = globalThis as { cancelAnimationFrame?: (id: number) => void };
  const had = typeof g.cancelAnimationFrame === "function";
  if (!had) g.cancelAnimationFrame = () => {};
  await host.shutdown();
  if (!had) delete g.cancelAnimationFrame;
  void mulberry32;
});
