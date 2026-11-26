/**
 * Node benchmark client for the native spreadsheet bridge.
 *
 * Renders synthetic animated frames (gradient sky, skyline, scrolling road,
 * moving car sprites), quantises them with the real FramePipeline (fixed64),
 * and streams them through the real ExcelBridgeBackend to a running bridge,
 * waiting for each ack (as fast as the sink allows). Records per-frame ack
 * latency and the bridge-reported applyMs / cells / calls.
 *
 *   node --import tsx renderers/excel/node-client.ts --width 160 --height 90 \
 *     --frames 120 --mode diff --url ws://127.0.0.1:8765/sgs --out result.json
 *
 * --mode full  forces a keyframe every frame (full-frame updates)
 * --mode diff  differential updates (default)
 * --scene drive (moderate change, default) | pan (camera pans: most cells change)
 */
import { writeFileSync, readFileSync } from "node:fs";
import WebSocket from "ws";
import { FramePipeline } from "../framebuffer/pipeline";
import { ExcelBridgeBackend, type AckMessage, type BridgeManifest, type WebSocketCtor, DEFAULT_BRIDGE_URL } from "./ExcelBridgeBackend";
import type { StatePatch } from "../../engines/core/variables";
import type { InputEvent } from "../../engines/core/input";

export interface ClientArgs {
  url: string;
  width: number;
  height: number;
  frames: number;
  maxSeconds: number;
  mode: "diff" | "full";
  scene: "drive" | "pan";
  out?: string;
  label?: string;
  warmup: number;
  manifest?: string;
  perFrame: boolean;
}

function parseArgs(argv: string[]): ClientArgs {
  const a: ClientArgs = { url: DEFAULT_BRIDGE_URL, width: 160, height: 90, frames: 120, maxSeconds: 30, mode: "diff", scene: "drive", warmup: 2, perFrame: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    switch (k) {
      case "--url": a.url = v; i++; break;
      case "--width": a.width = parseInt(v, 10); i++; break;
      case "--height": a.height = parseInt(v, 10); i++; break;
      case "--res": { const [w, h] = v.split("x").map(Number); a.width = w; a.height = h; i++; break; }
      case "--frames": a.frames = parseInt(v, 10); i++; break;
      case "--max-seconds": a.maxSeconds = parseFloat(v); i++; break;
      case "--mode": a.mode = v as ClientArgs["mode"]; i++; break;
      case "--scene": a.scene = v as ClientArgs["scene"]; i++; break;
      case "--out": a.out = v; i++; break;
      case "--label": a.label = v; i++; break;
      case "--warmup": a.warmup = parseInt(v, 10); i++; break;
      case "--manifest": a.manifest = v; i++; break;
      case "--per-frame": a.perFrame = true; break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  return a;
}

/** Deterministic game-like scene at cell resolution. */
export function renderScene(scene: "drive" | "pan", w: number, h: number, t: number, out: Uint8Array): void {
  const horizon = Math.floor(h * 0.42);
  const pan = scene === "pan" ? t * 1.5 : 0;
  const scroll = t * 0.35;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const wx = x + pan;
      let r: number, g: number, b: number;
      if (y < horizon) {
        const k = y / horizon;
        r = 70 + 150 * k; g = 110 + 80 * k; b = 200 - 90 * k;
        const bx = Math.floor(wx / Math.max(3, w / 24));
        const bh = ((bx * 7919) % 11) / 11;
        if (y > horizon * (0.25 + 0.6 * (1 - bh))) {
          const lit = (Math.floor(wx) % 3 === 0 && y % 3 === 0) ? 1 : 0;
          r = 45 + 40 * bh + lit * 170; g = 40 + 30 * bh + lit * 150; b = 70 + 30 * bh + lit * 30;
        }
      } else {
        const depth = (y - horizon + 1) / (h - horizon);
        const half = w * (0.12 + 0.38 * depth);
        const cx = w / 2 + (scene === "pan" ? Math.sin(t * 0.05) * w * 0.1 : 0);
        if (Math.abs(x - cx) < half) {
          const dash = Math.abs(x - cx) < Math.max(1, w * 0.008) && Math.floor((1 / depth) * 3 + scroll) % 2 === 0;
          r = dash ? 235 : 70; g = dash ? 215 : 72; b = dash ? 90 : 80;
        } else {
          const stripe = Math.floor((1 / depth) * 2 + scroll * 0.5) % 2 === 0;
          r = stripe ? 60 : 50; g = stripe ? 150 : 130; b = stripe ? 60 : 50;
        }
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  // moving sprites (cars), sizes scale with resolution
  const sw = Math.max(2, Math.round(w * 0.05)), sh = Math.max(2, Math.round(h * 0.06));
  const colours = [[220, 40, 40], [40, 120, 230], [240, 200, 30], [250, 250, 250], [30, 30, 30], [200, 60, 200]];
  for (let s = 0; s < 6; s++) {
    const px = Math.floor(((s * 0.17 + t * (0.004 + s * 0.0015)) % 1) * (w - sw));
    const py = Math.floor(horizon + 2 + ((s * 37) % Math.max(1, h - horizon - sh - 2)));
    const [cr, cg, cb] = colours[s];
    for (let y = py; y < Math.min(h, py + sh); y++)
      for (let x = px; x < Math.min(w, px + sw); x++) {
        const o = (y * w + x) * 4;
        out[o] = cr; out[o + 1] = cg; out[o + 2] = cb;
      }
  }
}

const defaultManifest: BridgeManifest = {
  game: "bench",
  title: "Bridge benchmark",
  paletteMode: "fixed64",
  variables: [
    { key: "player.health", sheet: "PLAYER", label: "Health", name: "Health", type: "number", default: 100, min: 0, max: 500 },
    { key: "world.baseBudget", sheet: "WORLD", label: "Police base budget", name: "BaseBudget", type: "number", default: 1.2, min: 0, max: 10 },
    { key: "player.alert", sheet: "PLAYER", label: "Alert level", name: "AlertLevel", type: "number", default: 0, min: 0, max: 5 },
  ],
  rules: [{ name: "PoliceBudget", formula: "=BaseBudget*AlertLevel", min: 0, max: 14, description: "Police cars allowed" }],
  sheets: [{ name: "MISSIONS", columns: ["#", "Mission", "Status"] }],
  controls: [["WASD", "Drive"]],
};

function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface FrameRecord {
  frameId: number;
  rttMs: number;
  applyMs: number;
  cells: number;
  calls: number;
  bytes: number;
  changedCells: number;
  keyframe: boolean;
}

export async function runClient(a: ClientArgs) {
  const manifest: BridgeManifest = a.manifest ? JSON.parse(readFileSync(a.manifest, "utf8")) : defaultManifest;
  manifest.paletteMode = "fixed64";
  delete manifest.palette;
  const pipe = new FramePipeline(a.width, a.height, { mode: "fixed64" });
  const rgba = new Uint8Array(a.width * a.height * 4);
  let waiter: ((m: AckMessage, rtt: number) => void) | null = null;
  const edits: StatePatch[] = [];
  const inputs: InputEvent[] = [];
  const be = new ExcelBridgeBackend({
    url: a.url,
    manifest: () => manifest,
    WebSocket: WebSocket as unknown as WebSocketCtor,
    reconnect: false,
    ackTimeoutMs: 120000,
    onAck: (m, rtt) => {
      if (waiter && !m.coalesced) waiter(m, rtt);
    },
    onError: (e) => console.error("bridge error:", e),
  });
  await be.init({ width: a.width, height: a.height, emitInput: (e) => inputs.push(e), emitState: (p) => edits.push(p) });
  if (!(await be.whenConnected(10000))) throw new Error(`could not connect to ${a.url}`);
  const records: FrameRecord[] = [];
  const t0 = performance.now();
  let tStats = 0;
  for (let i = 0; i < a.frames; i++) {
    if (i === a.warmup) tStats = performance.now();
    renderScene(a.scene, a.width, a.height, i, rgba);
    if (a.mode === "full") pipe.requestKeyframe();
    const { frame, diff } = pipe.process(rgba);
    const ackP = new Promise<{ m: AckMessage; rtt: number }>((resolve) => {
      waiter = (m, rtt) => {
        waiter = null;
        resolve({ m, rtt });
      };
    });
    const before = be.counters.skippedEmpty;
    if (!be.submitFrame(frame, diff)) throw new Error("frame unexpectedly dropped (window full)");
    if (be.counters.skippedEmpty !== before) {
      waiter = null;
      records.push({ frameId: frame.id, rttMs: 0, applyMs: 0, cells: 0, calls: 0, bytes: 0, changedCells: 0, keyframe: false });
      continue;
    }
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`ack timeout for frame ${frame.id}`)), 120000));
    const { m, rtt } = await Promise.race([ackP, timeout]);
    records.push({ frameId: frame.id, rttMs: rtt, applyMs: m.applyMs, cells: m.cells, calls: m.calls, bytes: be.stats().lastFrameBytes, changedCells: diff.changedCells, keyframe: diff.keyframe });
    if ((performance.now() - t0) / 1000 > a.maxSeconds && i >= a.warmup + 5) break;
  }
  const tEnd = performance.now();
  const ready = be.ready;
  await be.shutdown();
  const st = records.slice(a.warmup);
  const measured = st.length;
  const wall = (tEnd - (tStats || t0)) / 1000;
  const cellsTotal = a.width * a.height;
  const result = {
    label: a.label ?? `${a.width}x${a.height}-${a.mode}`,
    sink: ready?.sink ?? "?",
    strategy: ready?.strategy ?? "?",
    appVersion: (ready?.appVersion as string) ?? (ready?.excelVersion as string) ?? null,
    resolution: `${a.width}x${a.height}`,
    width: a.width,
    height: a.height,
    totalCells: cellsTotal,
    mode: a.mode,
    scene: a.scene,
    framesMeasured: measured,
    warmupFrames: a.warmup,
    wallSeconds: r3(wall),
    fps: r3(measured / wall),
    applyMs: { median: r3(pct(st.map((r) => r.applyMs), 50)), p95: r3(pct(st.map((r) => r.applyMs), 95)), mean: r3(mean(st.map((r) => r.applyMs))) },
    ackLatencyMs: { median: r3(pct(st.map((r) => r.rttMs), 50)), p95: r3(pct(st.map((r) => r.rttMs), 95)), mean: r3(mean(st.map((r) => r.rttMs))) },
    cellsWritten: { median: pct(st.map((r) => r.cells), 50), mean: r3(mean(st.map((r) => r.cells))) },
    calls: { median: pct(st.map((r) => r.calls), 50), mean: r3(mean(st.map((r) => r.calls))) },
    bytesPerFrame: { median: pct(st.map((r) => r.bytes), 50), mean: r3(mean(st.map((r) => r.bytes))) },
    changedCellsPct: r3((100 * mean(st.map((r) => r.changedCells))) / cellsTotal),
    droppedFrames: be.stats().droppedFrames,
    edits: edits.length,
    inputs: inputs.length,
    ...(a.perFrame ? { perFrame: records } : {}),
  };
  if (a.out) writeFileSync(a.out, JSON.stringify(result, null, 1));
  return result;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  runClient(parseArgs(process.argv.slice(2)))
    .then((r) => {
      const { perFrame: _p, ...summary } = r as typeof r & { perFrame?: unknown };
      console.log(JSON.stringify(summary));
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
