/**
 * Isolated renderer-pipeline benchmark on synthetic game-like frames.
 * Measures quantise/diff/encode cost and transport size per resolution and
 * configuration, comparing full-frame and differential updates.
 *
 *   node --import tsx scripts/bench-pipeline.ts [frames]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { FramePipeline } from "../renderers/framebuffer/pipeline";
import { encodeFrame } from "../renderers/framebuffer/protocol";
import { writtenCells } from "../renderers/framebuffer/diff";
import { Quantizer } from "../renderers/framebuffer/quantize";
import { RESOLUTION_PRESETS } from "../engines/core/frame";

const FRAMES = parseInt(process.argv[2] ?? "180", 10);

/** Synthetic scene: sunset sky, perspective road with lane dashes, buildings, moving cars, camera drift, noise. */
function scene(w: number, h: number, t: number, out: Uint8Array): void {
  const horizon = Math.floor(h * 0.45);
  const camX = Math.sin(t * 0.02) * 0.3 + t * 0.004;
  const speed = t * 0.08;
  let seed = (t * 2654435761) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const u = x / w - 0.5 + camX * 0.2;
      let r: number, g: number, b: number;
      if (y < horizon) {
        const k = y / horizon;
        r = 255 * (0.35 + 0.6 * k); g = 120 + 90 * k; b = 180 - 120 * k;
        // skyline
        const bx = Math.floor((u + 2) * 9);
        const bh = ((bx * 7919) % 13) / 13;
        if (y > horizon * (0.35 + 0.5 * (1 - bh))) {
          const lit = ((x * 31 + y * 17) % 7 === 0) ? 1 : 0;
          r = 40 + 50 * bh + lit * 180; g = 30 + 40 * bh + lit * 140; b = 60 + 30 * bh + lit * 40;
        }
      } else {
        const z = 1 / ((y - horizon + 1) / (h - horizon));
        const lx = u * z;
        const road = Math.abs(lx) < 0.9;
        if (road) {
          const dash = Math.abs(lx) < 0.03 && Math.floor(z * 2 + speed) % 2 === 0;
          const v = 55 + 20 * ((Math.floor(lx * 40) ^ Math.floor(z * 8 + speed * 4)) & 1);
          r = dash ? 230 : v; g = dash ? 210 : v; b = dash ? 90 : v + 8;
        } else {
          const stripe = (Math.floor(z * 3 + speed) & 1) === 0;
          r = stripe ? 200 : 180; g = stripe ? 175 : 160; b = stripe ? 140 : 120;
        }
      }
      // two moving cars as rectangles
      for (let c = 0; c < 2; c++) {
        const cx = w * (0.4 + 0.25 * c + 0.1 * Math.sin(t * 0.05 + c));
        const cy = h * (0.7 + 0.1 * c);
        if (Math.abs(x - cx) < w * 0.06 && Math.abs(y - cy) < h * 0.05) {
          r = c ? 30 : 220; g = c ? 140 : 40; b = c ? 220 : 50;
        }
      }
      const n = (rnd() - 0.5) * 10;
      out[o] = Math.max(0, Math.min(255, r + n));
      out[o + 1] = Math.max(0, Math.min(255, g + n));
      out[o + 2] = Math.max(0, Math.min(255, b + n));
      out[o + 3] = 255;
    }
  }
}

interface Row {
  resolution: string;
  config: string;
  cells: number;
  quantizeMsMedian: number;
  diffMsMedian: number;
  encodeMsMedian: number;
  pipelineMsP95: number;
  changedPct: number;
  writtenPct: number;
  runsPerFrame: number;
  bytesFull: number;
  bytesDiffMedian: number;
  mse: number;
}

const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)];

const configs = [
  { id: "fixed64", opts: { mode: "fixed64" as const, hysteresis: 0 } },
  { id: "fixed64+hyst", opts: { mode: "fixed64" as const, hysteresis: 900 } },
  { id: "adaptive192", opts: { mode: "adaptive" as const, colours: 192, hysteresis: 0 } },
  { id: "adaptive192+hyst", opts: { mode: "adaptive" as const, colours: 192, hysteresis: 140 } },
];

const rows: Row[] = [];
for (const res of RESOLUTION_PRESETS) {
  const { width: w, height: h } = res;
  const frames: Uint8Array[] = [];
  for (let t = 0; t < Math.min(FRAMES, 120); t++) {
    const f = new Uint8Array(w * h * 4);
    scene(w, h, t, f);
    frames.push(f);
  }
  for (const c of configs) {
    const p = new FramePipeline(w, h, c.opts);
    const q: number[] = [], d: number[] = [], e: number[] = [], tot: number[] = [], bytes: number[] = [];
    let changed = 0, written = 0, runs = 0, bytesFull = 0, mse = 0, n = 0;
    for (let i = 0; i < FRAMES; i++) {
      const src = frames[i % frames.length];
      const t0 = performance.now();
      const { frame, diff } = p.process(src);
      const t1 = performance.now();
      const buf = encodeFrame(frame, diff, diff.keyframe);
      const t2 = performance.now();
      if (i === 0) {
        bytesFull = buf.byteLength;
        continue; // first frame is the keyframe
      }
      q.push(p.timings.quantizeMs);
      d.push(p.timings.diffMs);
      e.push(t2 - t1);
      tot.push(t2 - t0);
      bytes.push(buf.byteLength);
      changed += diff.changedCells;
      written += writtenCells(diff);
      runs += diff.runs.length;
      if (i % 20 === 0) {
        mse += Quantizer.mse(src, frame.indices, frame.palette);
        n++;
      }
    }
    const frames_ = FRAMES - 1;
    rows.push({
      resolution: res.id,
      config: c.id,
      cells: w * h,
      quantizeMsMedian: +med(q).toFixed(3),
      diffMsMedian: +med(d).toFixed(3),
      encodeMsMedian: +med(e).toFixed(3),
      pipelineMsP95: +p95(tot).toFixed(3),
      changedPct: +((100 * changed) / frames_ / (w * h)).toFixed(1),
      writtenPct: +((100 * written) / frames_ / (w * h)).toFixed(1),
      runsPerFrame: Math.round(runs / frames_),
      bytesFull,
      bytesDiffMedian: med(bytes),
      mse: +(mse / Math.max(1, n)).toFixed(1),
    });
  }
}

mkdirSync("evals/results", { recursive: true });
const env = { node: process.version, platform: process.platform, arch: process.arch, cpus: (await import("node:os")).cpus().length, cpuModel: (await import("node:os")).cpus()[0]?.model, frames: FRAMES, date: new Date().toISOString() };
writeFileSync("evals/results/pipeline-bench.json", JSON.stringify({ env, rows }, null, 2));
let md = `| Resolution | Config | Quantise ms (med) | Diff ms (med) | Encode ms (med) | Pipeline p95 ms | Changed % | Written % | Runs/frame | Full bytes | Diff bytes (med) | MSE |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
for (const r of rows) md += `| ${r.resolution} | ${r.config} | ${r.quantizeMsMedian} | ${r.diffMsMedian} | ${r.encodeMsMedian} | ${r.pipelineMsP95} | ${r.changedPct} | ${r.writtenPct} | ${r.runsPerFrame} | ${r.bytesFull} | ${r.bytesDiffMedian} | ${r.mse} |\n`;
writeFileSync("evals/results/pipeline-bench.md", `Environment: ${JSON.stringify(env)}\n\n` + md);
console.log(md);
