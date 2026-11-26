/**
 * StudioHost: runs a SpreadsheetGame, the frame pipeline and any number of
 * render backends off a single simulation.
 *
 *   game.step()  (fixed timestep, decoupled from presentation)
 *      -> game.renderDirect()           (conventional backend, when visible)
 *      -> game.renderCells(w,h,rgba)    (when any cell backend is active)
 *      -> FramePipeline (quantise + diff)
 *      -> backend.submitFrame()  (each backend may drop under backpressure)
 */
import type { SpreadsheetGame } from "./game";
import { InputState, InputEvent } from "./input";
import { VariableRegistry, StatePatch } from "./variables";
import type { RenderBackend } from "./renderer";
import { Ema, RateCounter } from "./renderer";
import { FramePipeline } from "../../renderers/framebuffer/pipeline";
import type { QuantizeOptions } from "../../renderers/framebuffer/quantize";
import { writtenCells } from "../../renderers/framebuffer/diff";
import { RESOLUTION_PRESETS } from "./frame";

export interface Telemetry {
  gameFps: number;
  sheetFps: number;
  simHz: number;
  simMs: number;
  renderMs: number;
  readbackMs: number;
  quantizeMs: number;
  diffMs: number;
  presentMs: number;
  frameLatencyMs: number;
  changedCells: number;
  writtenCells: number;
  totalCells: number;
  transportBytes: number;
  droppedFrames: number;
  entities: number;
  memoryMB: number;
  resolution: string;
  paletteSize: number;
  backends: { id: string; fps: number; connected: boolean; presentMs: number; dropped: number }[];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HostOptions {
  width: number;
  height: number;
  seed?: number;
  quantize?: Partial<QuantizeOptions>;
  /** Automatically step resolution down/up to hold the sheet frame budget. */
  adaptiveResolution?: boolean;
  /** Target ms per cell frame for adaptive resolution. */
  cellFrameBudgetMs?: number;
}

export class StudioHost {
  readonly registry = new VariableRegistry();
  readonly input = new InputState();
  readonly pipeline: FramePipeline;
  private backends: RenderBackend[] = [];
  private rgba: Uint8Array;
  private simTime = 0;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  paused = false;
  /** Conventional view is visible (render the full 3D canvas). */
  directVisible = true;
  /** Render cells this often relative to display frames (1 = every frame). */
  cellEvery = 1;
  private frameCount = 0;
  private gameRate = new RateCounter();
  private sheetRate = new RateCounter();
  private simRate = new RateCounter();
  private ema = { sim: new Ema(), render: new Ema(), read: new Ema(), q: new Ema(), d: new Ema(), lat: new Ema() };
  private lastDiff = { changed: 0, written: 0 };
  private overBudget = 0;
  private underBudget = 0;
  opts: Required<HostOptions>;
  random: () => number;
  onTelemetry: ((t: Telemetry) => void)[] = [];
  onResolution: ((w: number, h: number) => void)[] = [];

  constructor(public game: SpreadsheetGame, opts: HostOptions) {
    this.opts = { seed: 1337, quantize: {}, adaptiveResolution: false, cellFrameBudgetMs: 12, ...opts };
    this.random = mulberry32(this.opts.seed);
    this.registry.define(game.variables).defineRules(game.rules);
    this.pipeline = new FramePipeline(opts.width, opts.height, this.opts.quantize);
    this.rgba = new Uint8Array(opts.width * opts.height * 4);
  }

  get width(): number {
    return this.pipeline.width;
  }
  get height(): number {
    return this.pipeline.height;
  }

  async init(mount: HTMLElement): Promise<void> {
    await this.game.init({ registry: this.registry, input: this.input, mount, random: this.random, time: () => this.simTime });
  }

  async addBackend(b: RenderBackend): Promise<void> {
    await b.init({
      width: this.width,
      height: this.height,
      emitInput: (e) => this.sendInput(e),
      emitState: (p) => this.applyPatch(p, b.id),
    });
    this.backends.push(b);
    this.pipeline.requestKeyframe();
  }

  async removeBackend(id: string): Promise<void> {
    const i = this.backends.findIndex((b) => b.id === id);
    if (i >= 0) {
      const [b] = this.backends.splice(i, 1);
      await b.shutdown();
    }
  }

  backend(id: string): RenderBackend | undefined {
    return this.backends.find((b) => b.id === id);
  }

  sendInput(e: InputEvent): void {
    this.input.apply(e);
  }

  applyPatch(p: StatePatch, source = "sheet"): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const [k, v] of Object.entries(p)) {
      if (k.startsWith("rule:")) {
        const r = this.registry.setRuleFormula(k.slice(5), String(v));
        if (!r.ok) errors[k] = r.error!;
      } else {
        const r = this.registry.edit(k, v, source);
        if (!r.ok) errors[k] = r.error!;
      }
    }
    return errors;
  }

  setResolution(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    this.pipeline.resize(w, h);
    this.rgba = new Uint8Array(w * h * 4);
    for (const b of this.backends) b.resize(w, h);
    for (const f of this.onResolution) f(w, h);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.raf);
  }

  /** One display frame. Public so headless tests can drive the loop deterministically. */
  frame(now: number): void {
    const step = this.game.fixedStep;
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.25) dt = 0.25; // tab switch / stall guard
    const t0 = performance.now();
    if (!this.paused) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= step && steps < 8) {
        this.game.step(step);
        this.input.endFrame();
        this.simTime += step;
        this.acc -= step;
        steps++;
        this.simRate.tick(now);
      }
      if (steps === 8) this.acc = 0;
    }
    const t1 = performance.now();
    this.ema.sim.push(t1 - t0);
    if (this.directVisible) this.game.renderDirect(this.acc / step, 0, 0);
    const t2 = performance.now();
    this.ema.render.push(t2 - t1);
    this.gameRate.tick(now);
    this.frameCount++;

    const cellBackends = this.backends.filter((b) => b.capabilities.cellFrames);
    if (cellBackends.length && this.frameCount % this.cellEvery === 0) this.produceCells(cellBackends, t0);
    if (this.frameCount % 6 === 0) {
      const snap = this.registry.snapshot();
      for (const b of this.backends) b.syncState(snap);
    }
    if (this.frameCount % 15 === 0) this.emitTelemetry();
  }

  private produceCells(cellBackends: RenderBackend[], frameStart: number): void {
    const a = performance.now();
    this.game.renderCells(this.width, this.height, this.rgba);
    const b = performance.now();
    const { frame, diff } = this.pipeline.process(this.rgba);
    this.ema.read.push(b - a);
    this.ema.q.push(this.pipeline.timings.quantizeMs);
    this.ema.d.push(this.pipeline.timings.diffMs);
    this.lastDiff = { changed: diff.changedCells, written: writtenCells(diff) };
    let presentedAny = false;
    for (const be of cellBackends) {
      if (be.submitFrame(frame, diff)) presentedAny = true;
    }
    if (presentedAny) this.sheetRate.tick();
    this.ema.lat.push(performance.now() - frameStart);
    if (this.opts.adaptiveResolution) this.adapt(performance.now() - a);
  }

  private adapt(cellMs: number): void {
    const budget = this.opts.cellFrameBudgetMs;
    if (cellMs > budget) this.overBudget++;
    else this.overBudget = Math.max(0, this.overBudget - 1);
    if (cellMs < budget * 0.35) this.underBudget++;
    else this.underBudget = 0;
    const idx = RESOLUTION_PRESETS.findIndex((p) => p.width === this.width && p.height === this.height);
    if (idx < 0) return;
    if (this.overBudget > 30 && idx > 0) {
      const p = RESOLUTION_PRESETS[idx - 1];
      this.setResolution(p.width, p.height);
      this.overBudget = 0;
    } else if (this.underBudget > 240 && idx < RESOLUTION_PRESETS.length - 1) {
      const p = RESOLUTION_PRESETS[idx + 1];
      this.setResolution(p.width, p.height);
      this.underBudget = 0;
    }
  }

  telemetry(): Telemetry {
    const perf = (globalThis.performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const bstats = this.backends.map((b) => ({ id: b.id, s: b.stats() }));
    const cellB = bstats.filter((x) => this.backends.find((b) => b.id === x.id)!.capabilities.cellFrames);
    return {
      gameFps: this.gameRate.rate,
      sheetFps: cellB.length ? Math.max(...cellB.map((x) => x.s.presentedFps)) : 0,
      simHz: this.simRate.rate,
      simMs: this.ema.sim.value,
      renderMs: this.ema.render.value,
      readbackMs: this.ema.read.value,
      quantizeMs: this.ema.q.value,
      diffMs: this.ema.d.value,
      presentMs: cellB.length ? Math.max(...cellB.map((x) => x.s.presentMs)) : 0,
      frameLatencyMs: this.ema.lat.value,
      changedCells: this.lastDiff.changed,
      writtenCells: this.lastDiff.written,
      totalCells: this.width * this.height,
      transportBytes: Math.max(0, ...bstats.map((x) => x.s.lastFrameBytes)),
      droppedFrames: bstats.reduce((s, x) => s + x.s.droppedFrames, 0),
      entities: this.game.entityCount(),
      memoryMB: perf ? perf.usedJSHeapSize / 1048576 : -1,
      resolution: `${this.width}x${this.height}`,
      paletteSize: this.pipeline.quantizer.palette.length,
      backends: bstats.map((x) => ({ id: x.id, fps: x.s.presentedFps, connected: x.s.connected, presentMs: x.s.presentMs, dropped: x.s.droppedFrames })),
    };
  }

  private emitTelemetry(): void {
    const t = this.telemetry();
    for (const f of this.onTelemetry) f(t);
  }

  async shutdown(): Promise<void> {
    this.stop();
    for (const b of [...this.backends]) await this.removeBackend(b.id);
    this.game.dispose();
  }
}
