/**
 * Turn-based Google Sheets port: the parts every game shares.
 *
 * A TurnApp describes one game for app.ts (the Apps Script side): its size,
 * its buttons and how to make a session from a saved game. Games that declare
 * `turn` support on the SpreadsheetGame contract get one for free from
 * turnAppFromGame(); a game can also write its own session when it needs
 * smarter turns (Fieldbook walks exactly one tile per tap, for example).
 */
import type { SpreadsheetGame, TurnControl } from "../../../engines/core/game";
import { InputState } from "../../../engines/core/input";
import { VariableRegistry } from "../../../engines/core/variables";
import type { StateValue } from "../../../engines/core/variables";

export interface SavedBase {
  v: 1;
  layout: string;
  rng: number;
  values: Record<string, StateValue>;
  formulas: Record<string, string>;
  steps: number;
  frame: PackedFrame | string[];
  written: Record<string, string>;
  turns: number;
  /** Game-specific state. */
  game: unknown;
}

export interface TurnSessionLike {
  readonly game: SpreadsheetGame;
  readonly registry: VariableRegistry;
  message: string;
  steps: number;
  /** Frame last painted into the sheet (W*H hex colours). */
  frame: string[];
  /** Signature of what was last written to each sheet, so unchanged sheets are skipped. */
  written: Record<string, string>;
  turns: number;
  play(controlId: string): void;
  render(): string[];
  hudLines(): [string, string];
  save(): SavedBase;
}

export interface TurnApp {
  /** Changes whenever the sheet layout changes; a mismatch makes the script rebuild the sheets. */
  layout: string;
  title: string;
  width: number;
  height: number;
  /** Cell size in px (4 suits 160 columns on a phone). */
  cellPx?: number;
  controls: TurnControl[];
  /** Options for the Steps dropdown (repeat a move); omit to hide it. */
  stepOptions?: string[];
  /** First message shown after setup. */
  intro?: string;
  create(saved?: SavedBase | null): TurnSessionLike;
}

// ---- seeded RNG whose state can be saved --------------------------------------
export function savableRng(seed = 0x5eed1234) {
  const state = { a: seed >>> 0 };
  const next = () => {
    state.a = (state.a + 0x6d2b79f5) >>> 0;
    let t = state.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { state, next };
}

export function rgbaToHex(d: Uint8Array, n: number): string[] {
  const out = new Array<string>(n);
  for (let i = 0; i < n; i++) out[i] = "#" + ((1 << 24) | (d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2]).toString(16).slice(1);
  return out;
}

export function registrySnapshot(reg: VariableRegistry) {
  const snap = reg.snapshot();
  const formulas: Record<string, string> = {};
  for (const r of snap.rules) formulas[r.name] = r.formula;
  return { values: snap.values, formulas };
}

export function restoreRegistry(reg: VariableRegistry, s: Pick<SavedBase, "values" | "formulas">) {
  for (const [name, f] of Object.entries(s.formulas ?? {})) reg.setRuleFormula(name, f);
  for (const [k, v] of Object.entries(s.values ?? {})) if (reg.def(k)) reg.setLive(k, v);
  reg.recomputeRules();
}

export function hudLinesOf(game: SpreadsheetGame, message: string): [string, string] {
  const h = game.hud();
  const top = h.stats.map(([k, v]) => `${k} ${v}`).join(" · ");
  return [top, message || h.banner || h.hint || h.objective || ""];
}

// ---- generic session for games that declare `turn` support ----------------------
export class GenericTurnSession implements TurnSessionLike {
  readonly game: SpreadsheetGame;
  readonly registry: VariableRegistry;
  readonly input = new InputState();
  private rng = savableRng();
  message = "";
  steps = 1;
  frame: string[] = [];
  written: Record<string, string> = {};
  turns = 0;
  private buf: Uint8Array;

  constructor(createGame: () => SpreadsheetGame, readonly app: { layout: string; width: number; height: number }, saved?: SavedBase | null) {
    this.game = createGame();
    if (!this.game.turn) throw new Error(`${this.game.title} has no turn support (add \`turn\` to the game, see engines/core/game.ts)`);
    this.registry = new VariableRegistry().define(this.game.variables).defineRules(this.game.rules);
    this.buf = new Uint8Array(app.width * app.height * 4);
    void this.game.init({ registry: this.registry, input: this.input, mount: {} as HTMLElement, random: this.rng.next, time: () => 0 });
    if (saved) {
      restoreRegistry(this.registry, saved);
      if (saved.game !== undefined) this.game.turn!.load(saved.game);
      this.rng.state.a = saved.rng >>> 0;
      this.steps = saved.steps || 1;
      this.frame = unpackFrame(saved.frame);
      this.written = saved.written ?? {};
      this.turns = saved.turns ?? 0;
    }
  }

  private tick(seconds: number) {
    const n = Math.max(0, Math.round(seconds / this.game.fixedStep));
    for (let i = 0; i < n; i++) {
      this.game.step(this.game.fixedStep);
      this.input.endFrame();
    }
  }

  play(id: string) {
    this.message = "";
    const c = this.game.turn!.controls.find((x) => x.id === id);
    if (!c) return;
    for (let k = 0; k < (c.action ? this.steps : 1); k++) {
      if (c.command) this.game.runCommand(c.command);
      if (c.action) {
        this.input.apply({ type: "action", action: c.action, down: true });
        this.tick(Math.max(this.game.fixedStep, c.hold ?? this.game.fixedStep));
        this.input.apply({ type: "action", action: c.action, down: false });
      }
      this.tick(c.after ?? 0);
    }
    this.turns++;
  }

  render(): string[] {
    this.game.renderCells(this.app.width, this.app.height, this.buf);
    return rgbaToHex(this.buf, this.app.width * this.app.height);
  }

  hudLines(): [string, string] {
    return hudLinesOf(this.game, this.message);
  }

  save(): SavedBase {
    return { v: 1, layout: this.app.layout, rng: this.rng.state.a, ...registrySnapshot(this.registry), steps: this.steps, frame: packFrame(this.frame), written: this.written, turns: this.turns, game: JSON.parse(JSON.stringify(this.game.turn!.save() ?? null)) };
  }
}

/** A TurnApp for any game with `turn` support and a DOM-free renderCells. */
export function turnAppFromGame(createGame: () => SpreadsheetGame, opts: { width?: number; height?: number; cellPx?: number; stepOptions?: string[]; intro?: string; version?: string } = {}): TurnApp {
  const probe = createGame();
  if (!probe.turn) throw new Error(`${probe.title} has no turn support`);
  const width = opts.width ?? 160, height = opts.height ?? 90;
  const app: TurnApp = {
    layout: `${probe.id}-${width}x${height}-${opts.version ?? "1"}`,
    title: probe.title,
    width,
    height,
    cellPx: opts.cellPx,
    controls: probe.turn.controls,
    stepOptions: opts.stepOptions,
    intro: opts.intro,
    create: (saved) => new GenericTurnSession(createGame, app, saved),
  };
  return app;
}

// ---- frame helpers -----------------------------------------------------------------
export interface Rect {
  r: number;
  c: number;
  colors: string[][];
}

/**
 * Changed cells between two frames as at most `max` rectangles (one setBackgrounds call each).
 * Rows with changes are grouped into bands; the closest bands are merged until `max` remain.
 */
export function changedRects(prev: string[] | null, next: string[], w: number, h: number, max = 12): Rect[] {
  type B = { y0: number; y1: number; x0: number; x1: number };
  const bands: B[] = [];
  for (let y = 0; y < h; y++) {
    let x0 = -1, x1 = -1;
    for (let x = 0; x < w; x++)
      if (!prev || prev[y * w + x] !== next[y * w + x]) {
        if (x0 < 0) x0 = x;
        x1 = x;
      }
    if (x0 < 0) continue;
    const b = bands[bands.length - 1];
    if (b && y - b.y1 <= 1 && x0 <= b.x1 + 8 && x1 >= b.x0 - 8) {
      b.y1 = y;
      b.x0 = Math.min(b.x0, x0);
      b.x1 = Math.max(b.x1, x1);
    } else bands.push({ y0: y, y1: y, x0, x1 });
  }
  const area = (b: B) => (b.y1 - b.y0 + 1) * (b.x1 - b.x0 + 1);
  const union = (a: B, b: B): B => ({ y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1), x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1) });
  while (bands.length > max) {
    let bi = 0, bj = 1, best = Infinity;
    for (let i = 0; i < bands.length; i++)
      for (let j = i + 1; j < bands.length; j++) {
        const cost = area(union(bands[i], bands[j])) - area(bands[i]) - area(bands[j]);
        if (cost < best) [best, bi, bj] = [cost, i, j];
      }
    bands[bi] = union(bands[bi], bands[bj]);
    bands.splice(bj, 1);
  }
  return bands.map((b) => {
    const colors: string[][] = [];
    for (let y = b.y0; y <= b.y1; y++) colors.push(next.slice(y * w + b.x0, y * w + b.x1 + 1));
    return { r: b.y0, c: b.x0, colors };
  });
}

export interface PackedFrame {
  p: string[];
  d: string;
}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** Frame as palette + two characters per cell (about 30k characters at 160x90). */
export function packFrame(f: string[]): PackedFrame {
  const idx = new Map<string, number>();
  const p: string[] = [];
  let d = "";
  for (const c of f) {
    let i = idx.get(c);
    if (i === undefined) {
      i = p.length;
      idx.set(c, i);
      p.push(c);
    }
    d += B64[(i >> 6) & 63] + B64[i & 63];
  }
  return { p, d };
}
export function unpackFrame(x: PackedFrame | string[] | undefined): string[] {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  const out = new Array<string>(x.d.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = x.p[(B64.indexOf(x.d[2 * k]) << 6) | B64.indexOf(x.d[2 * k + 1])];
  return out;
}
