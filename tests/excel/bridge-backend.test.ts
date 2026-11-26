/**
 * ExcelBridgeBackend tests.
 *   node --import tsx --test tests/excel/*.test.ts
 *
 * 1. Against an in-process fake bridge (ws server): hello contents, keyframe +
 *    palette, ack window / drop counting, re-diff after drops (exactness),
 *    edit/rule/input dispatch, resize, palette changes, state throttling,
 *    reconnect with backoff, ack timeout, bye on shutdown.
 * 2. End to end against the real Python bridge (`python3 -m sgs_bridge --sink mock`):
 *    real FramePipeline frames, deliberate drops, then the mock sink's dumped
 *    cells must equal the last frame exactly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { ExcelBridgeBackend, type BridgeManifest, type WebSocketCtor, bridgeUrlFromLocation } from "../../renderers/excel/ExcelBridgeBackend";
import { decodeFrame, encodeFrame } from "../../renderers/framebuffer/protocol";
import { FramePipeline } from "../../renderers/framebuffer/pipeline";
import { renderScene } from "../../renderers/excel/node-client";
import type { StatePatch } from "../../engines/core/variables";
import type { InputEvent } from "../../engines/core/input";
import type { IndexedFrame, FrameDiff } from "../../engines/core/frame";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WS = WebSocket as unknown as WebSocketCtor;

const manifest: BridgeManifest = {
  game: "t",
  title: "Test",
  paletteMode: "fixed64",
  variables: [{ key: "player.health", sheet: "PLAYER", label: "Health", name: "Health", type: "number", default: 100 }],
  rules: [{ name: "Twice", formula: "=Health*2", min: 0, max: 1000, description: "" }],
  sheets: [{ name: "MISSIONS", columns: ["#"] }],
  controls: [["W", "up"]],
  keyBindings: { KeyW: "up" },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FakeBridge {
  port: number;
  texts: Record<string, unknown>[];
  frames: ReturnType<typeof decodeFrame>[];
  sockets: WebSocket[];
  send(obj: unknown): void;
  waitFor<T>(pred: () => T | undefined | false, ms?: number): Promise<T>;
  close(): Promise<void>;
  wss: WebSocketServer;
}

async function fakeBridge(port = 0): Promise<FakeBridge> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port, path: "/sgs" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const fb: FakeBridge = {
    port: (wss.address() as net.AddressInfo).port,
    texts: [],
    frames: [],
    sockets: [],
    wss,
    send(obj) {
      for (const s of fb.sockets) if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(obj));
    },
    async waitFor(pred, ms = 3000) {
      const t = Date.now();
      for (;;) {
        const v = pred();
        if (v) return v as never;
        if (Date.now() - t > ms) throw new Error("waitFor timed out");
        await sleep(5);
      }
    },
    async close() {
      for (const s of fb.sockets) s.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
  wss.on("connection", (s) => {
    fb.sockets.push(s);
    s.on("message", (data, isBinary) => {
      if (isBinary) fb.frames.push(decodeFrame(new Uint8Array(data as Buffer)));
      else fb.texts.push(JSON.parse(String(data)));
    });
  });
  return fb;
}

function makeBackend(port: number, extra: Partial<ConstructorParameters<typeof ExcelBridgeBackend>[0]> = {}) {
  const edits: StatePatch[] = [];
  const inputs: InputEvent[] = [];
  const be = new ExcelBridgeBackend({ url: `ws://127.0.0.1:${port}/sgs`, manifest: () => manifest, WebSocket: WS, reconnectMinMs: 50, reconnectMaxMs: 200, ...extra });
  return { be, edits, inputs, init: (w = 8, h = 4) => be.init({ width: w, height: h, emitInput: (e) => inputs.push(e), emitState: (p) => edits.push(p) }) };
}

function frames(w: number, h: number, n: number, mode: "fixed64" | "fixed256" = "fixed64") {
  const p = new FramePipeline(w, h, { mode, hysteresis: 0 });
  const rgba = new Uint8Array(w * h * 4);
  const out: { frame: IndexedFrame; diff: FrameDiff; indices: Uint8Array }[] = [];
  for (let t = 0; t < n; t++) {
    renderScene("pan", w, h, t * 3, rgba);
    const { frame, diff } = p.process(rgba);
    // the pipeline double-buffers: keep private copies since frames are submitted later
    const own = { ...frame, indices: frame.indices.slice(), palette: frame.palette.slice() };
    out.push({ frame: own, diff, indices: own.indices });
  }
  return { p, out };
}

/** Apply decoded frames onto a shadow the way the bridge does. */
function applyAll(w: number, h: number, decoded: ReturnType<typeof decodeFrame>[]): Uint8Array {
  const s = new Uint8Array(w * h);
  for (const f of decoded) for (const r of f.runs) s.set(r.indices, r.row * w + r.x0);
  return s;
}

test("bridgeUrlFromLocation", () => {
  assert.equal(bridgeUrlFromLocation("?bridge=ws://127.0.0.1:9000/sgs"), "ws://127.0.0.1:9000/sgs");
  assert.equal(bridgeUrlFromLocation("?bridge=1"), "ws://127.0.0.1:8765/sgs");
  assert.equal(bridgeUrlFromLocation("?x=1"), null);
});

test("hello, keyframe with palette, capabilities", async () => {
  const fb = await fakeBridge();
  const { be, init } = makeBackend(fb.port);
  assert.equal(be.id, "excel-bridge");
  assert.equal(be.capabilities.cellFrames, true);
  await init(8, 4);
  assert.ok(await be.whenConnected());
  const hello = await fb.waitFor(() => fb.texts.find((m) => m.t === "hello"));
  assert.equal(hello.width, 8);
  assert.equal(hello.height, 4);
  assert.deepEqual(hello.origin, { col: 0, row: 3 });
  assert.equal((hello.palette as number[]).length, 64);
  assert.deepEqual(hello.keyBindings, { KeyW: "up" });
  assert.equal((hello.variables as unknown[]).length, 1);
  const { out } = frames(8, 4, 1);
  assert.equal(be.submitFrame(out[0].frame, out[0].diff), true);
  const f = await fb.waitFor(() => fb.frames[0]);
  assert.equal(f.keyframe, true);
  assert.equal(f.palette?.length, 64);
  assert.deepEqual(applyAll(8, 4, [f]), out[0].indices);
  assert.equal(be.stats().lastFrameBytes, encodeFrame(out[0].frame, out[0].diff, true).byteLength);
  await be.shutdown();
  await fb.close();
});

test("ack window drops frames and re-diffs against what was actually sent", async () => {
  const fb = await fakeBridge();
  const { be, init } = makeBackend(fb.port);
  await init(40, 20);
  await be.whenConnected();
  const { out } = frames(40, 20, 6);
  assert.equal(be.submitFrame(out[0].frame, out[0].diff), true);
  assert.equal(be.submitFrame(out[1].frame, out[1].diff), false); // window = 1
  assert.equal(be.submitFrame(out[2].frame, out[2].diff), false);
  assert.equal(be.stats().droppedFrames, 2);
  await fb.waitFor(() => fb.frames.length === 1);
  fb.send({ t: "ack", frameId: out[0].frame.id, applyMs: 1, cells: 800, calls: 1 });
  await fb.waitFor(() => be.pending === 0);
  assert.equal(be.submitFrame(out[3].frame, out[3].diff), true); // frames 2,3 missed -> re-diff
  await fb.waitFor(() => fb.frames.length === 2);
  assert.equal(fb.frames[1].keyframe, false);
  assert.deepEqual(applyAll(40, 20, fb.frames), out[3].indices, "bridge shadow equals frame 3 exactly");
  assert.equal(be.counters.rediffs, 1);
  fb.send({ t: "ack", frameId: out[3].frame.id, applyMs: 1, cells: 10, calls: 1 });
  await fb.waitFor(() => be.pending === 0);
  assert.equal(be.submitFrame(out[4].frame, out[4].diff), true); // consecutive: host diff used as is
  await fb.waitFor(() => fb.frames.length === 3);
  assert.equal(be.counters.rediffs, 1);
  assert.deepEqual(applyAll(40, 20, fb.frames), out[4].indices);
  assert.equal(be.stats().lastChangedCells, 10);
  await be.shutdown();
  await fb.close();
});

test("edit, rule and input messages reach the host", async () => {
  const fb = await fakeBridge();
  const { be, init, edits, inputs } = makeBackend(fb.port);
  await init();
  await be.whenConnected();
  await fb.waitFor(() => fb.sockets.length === 1);
  fb.send({ t: "ready", sink: "mock", strategy: "values-cf" });
  fb.send({ t: "edit", key: "player.health", value: 55 });
  fb.send({ t: "rule", name: "Twice", formula: "=Health*3", value: 165 });
  fb.send({ t: "input", action: "up", down: true });
  fb.send({ t: "input", action: "up", down: false });
  await fb.waitFor(() => inputs.length === 2);
  assert.deepEqual(edits, [{ "player.health": 55 }, { "rule:Twice": "=Health*3" }]);
  assert.deepEqual(inputs, [{ type: "action", action: "up", down: true }, { type: "action", action: "up", down: false }]);
  assert.equal(be.ready?.sink, "mock");
  await be.shutdown();
  await fb.close();
});

test("resize sends a new hello and a keyframe; palette changes travel with frames", async () => {
  const fb = await fakeBridge();
  const { be, init } = makeBackend(fb.port);
  await init(8, 4);
  await be.whenConnected();
  const a = frames(8, 4, 2);
  be.submitFrame(a.out[0].frame, a.out[0].diff);
  await fb.waitFor(() => fb.frames.length === 1);
  fb.send({ t: "ack", frameId: a.out[0].frame.id, applyMs: 0, cells: 0, calls: 0 });
  await fb.waitFor(() => be.pending === 0);
  be.resize(6, 3);
  const hellos = await fb.waitFor(() => fb.texts.filter((m) => m.t === "hello").length === 2 && fb.texts.filter((m) => m.t === "hello"));
  assert.equal(hellos[1].width, 6);
  const b = frames(6, 3, 1);
  // pipeline's diff is not a keyframe here on purpose: the backend must upgrade it
  const fakeDiff: FrameDiff = { keyframe: false, changedCells: 1, runs: [{ row: 0, x0: 0, length: 1 }], bounds: null };
  be.submitFrame(b.out[0].frame, fakeDiff);
  const kf = await fb.waitFor(() => fb.frames[1]);
  assert.equal(kf.keyframe, true);
  assert.equal(kf.width, 6);
  assert.deepEqual(applyAll(6, 3, [kf]), b.out[0].indices);
  fb.send({ t: "ack", frameId: b.out[0].frame.id, applyMs: 0, cells: 0, calls: 0 });
  await fb.waitFor(() => be.pending === 0);
  // palette mode change fixed64 -> fixed256: new hello carrying the 256 palette, then a keyframe
  const c = frames(6, 3, 1, "fixed256");
  const f = { ...c.out[0].frame, id: b.out[0].frame.id + 1, paletteVersion: 7 };
  be.submitFrame(f, c.out[0].diff);
  const h3 = await fb.waitFor(() => fb.texts.filter((m) => m.t === "hello")[2]);
  assert.equal((h3.palette as number[]).length, 256);
  const f3 = await fb.waitFor(() => fb.frames[2]);
  assert.equal(f3.palette?.length, 256);
  assert.equal(f3.paletteVersion, 7);
  await be.shutdown();
  await fb.close();
});

test("state is throttled and sent as deltas; hud/sheets/telemetry providers", async () => {
  const fb = await fakeBridge();
  let hp = 100;
  const { be, init } = makeBackend(fb.port, {
    stateHz: 20,
    hud: () => ({ stats: [["HP", String(hp)]], objective: "Go" }),
    sheets: () => [{ name: "MISSIONS", columns: ["#", "Name"], rows: [{ cells: [1, "Delivery"] }] }],
    telemetry: () => ({ fps: 30 }),
  });
  await init();
  await be.whenConnected();
  const snap = (v: number) => ({ version: v, values: { "player.health": hp, "player.cash": 5 }, rules: [{ name: "Twice", formula: "=Health*2", value: hp * 2 }] });
  be.syncState(snap(1));
  be.syncState(snap(2)); // too soon: throttled
  await sleep(70);
  hp = 90;
  be.syncState(snap(3));
  await fb.waitFor(() => fb.texts.filter((m) => m.t === "state").length === 2);
  const states = fb.texts.filter((m) => m.t === "state");
  assert.deepEqual(states[0].values, { "player.health": 100, "player.cash": 5 });
  assert.deepEqual(states[1].values, { "player.health": 90 }, "delta only");
  assert.ok(states[1].rules, "rules changed -> included");
  assert.ok(fb.texts.find((m) => m.t === "hud"));
  const sheets = fb.texts.filter((m) => m.t === "sheet");
  assert.equal(sheets.length, 1, "unchanged sheet content is not resent");
  assert.ok(fb.texts.find((m) => m.t === "telemetry" && m.fps === 30));
  await be.shutdown();
  await fb.close();
});

test("reconnects with backoff, re-sends hello and a keyframe; bye on shutdown", async () => {
  const fb = await fakeBridge();
  const port = fb.port;
  const { be, init } = makeBackend(port);
  await init(8, 4);
  await be.whenConnected();
  const { out } = frames(8, 4, 3);
  be.submitFrame(out[0].frame, out[0].diff);
  await fb.waitFor(() => fb.frames.length === 1);
  await fb.close();
  await sleep(50);
  assert.equal(be.stats().connected, false);
  assert.equal(be.submitFrame(out[1].frame, out[1].diff), false);
  const fb2 = await fakeBridge(port);
  assert.ok(await be.whenConnected(5000));
  await fb2.waitFor(() => fb2.texts.find((m) => m.t === "hello"));
  assert.equal(be.counters.reconnects, 1);
  assert.equal(be.submitFrame(out[2].frame, out[2].diff), true);
  const f = await fb2.waitFor(() => fb2.frames[0]);
  assert.equal(f.keyframe, true);
  assert.deepEqual(applyAll(8, 4, [f]), out[2].indices);
  await be.shutdown();
  await fb2.waitFor(() => fb2.texts.find((m) => m.t === "bye"));
  await fb2.close();
});

test("ack timeout frees the window", async () => {
  const fb = await fakeBridge();
  const { be, init } = makeBackend(fb.port, { ackTimeoutMs: 100 });
  await init(8, 4);
  await be.whenConnected();
  const { out } = frames(8, 4, 3);
  assert.equal(be.submitFrame(out[0].frame, out[0].diff), true);
  assert.equal(be.submitFrame(out[1].frame, out[1].diff), false);
  await sleep(150);
  assert.equal(be.submitFrame(out[2].frame, out[2].diff), true);
  assert.equal(be.counters.ackTimeouts, 1);
  await be.shutdown();
  await fb.close();
});

// ---------------------------------------------------------------------------
function python(): string | null {
  for (const p of ["python3", "python"]) if (spawnSync(p, ["-c", "import websockets, numpy"]).status === 0) return p;
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

test("end to end with the Python bridge (mock sink): exact cells after drops", { skip: python() ? false : "python3 with websockets+numpy not available" }, async () => {
  const py = python()!;
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "sgs-e2e-"));
  const dump = join(dir, "dump.json");
  const proc = spawn(py, ["-m", "sgs_bridge", "--sink", "mock", "--strategy", "interior", "--port", String(port), "--mock-dump", dump], { cwd: join(ROOT, "renderers", "excel", "bridge"), stdio: "ignore" });
  try {
    const acks: number[] = [];
    const { be, init } = makeBackend(port, { reconnectMinMs: 100, onAck: (a) => acks.push(a.frameId) });
    await init(64, 36);
    assert.ok(await be.whenConnected(15000), "bridge reachable");
    const { out } = frames(64, 36, 30);
    let last = out[0];
    for (let i = 0; i < out.length; i++) {
      const ok = be.submitFrame(out[i].frame, out[i].diff);
      if (ok) last = out[i];
      if (i % 3 === 2) {
        // let some frames drop, then wait for the in-flight ack
        const t = Date.now();
        while (be.pending > 0 && Date.now() - t < 5000) await sleep(2);
      }
    }
    const t = Date.now();
    while (be.pending > 0 && Date.now() - t < 5000) await sleep(2);
    assert.ok(be.stats().droppedFrames > 0, "some frames were dropped by the ack window");
    assert.equal(be.ready?.sink, "mock");
    await be.shutdown(); // bye -> bridge dumps sink state
    const t2 = Date.now();
    while (!existsSync(dump) && Date.now() - t2 < 5000) await sleep(20);
    await sleep(100);
    const d = JSON.parse(readFileSync(dump, "utf8"));
    const pal = last.frame.palette;
    for (let y = 0; y < 36; y++)
      for (let x = 0; x < 64; x++) assert.equal(d.rendered[y][x], pal[last.indices[y * 64 + x]], `cell (${x},${y})`);
    assert.ok(acks.length >= 10);
  } finally {
    proc.kill("SIGINT");
    await new Promise((r) => proc.once("exit", r));
    rmSync(dir, { recursive: true, force: true });
  }
});
