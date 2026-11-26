/**
 * Google Sheets edition - sidebar client.
 *
 * Runs the unmodified game + StudioHost + FramePipeline inside the Apps Script
 * sidebar and streams changed cells to Code.gs (google.script.run), one update
 * in flight at a time. Player edits made in the sheets come back with each
 * reply and are applied through the same validated StatePatch path as every
 * other backend.
 */
import { StudioHost } from "../../engines/core/host";
import type { SpreadsheetGame } from "../../engines/core/game";
import type { BackendCapabilities, BackendStats, RenderBackend } from "../../engines/core/renderer";
import { RateCounter, Ema, emptyStats } from "../../engines/core/renderer";
import type { FrameDiff, IndexedFrame } from "../../engines/core/frame";
import type { StateSnapshot, StateValue } from "../../engines/core/variables";
import { bindKeyboard } from "../../engines/core/input";

export type Transport = (fn: string, arg: unknown) => Promise<any>;

interface ApplyResult {
  applyMs: number;
  values: Record<string, unknown>;
  formulas: Record<string, string>;
}

export interface Rect {
  r: number;
  c: number;
  colors: string[][];
}

const hex = (c: number) => "#" + (c & 0xffffff).toString(16).padStart(6, "0");

/** Normalise a value the way both the game and Sheets will display it, for echo comparison. */
export function norm(v: unknown): string {
  if (v === true || v === "TRUE" || v === "true") return "TRUE";
  if (v === false || v === "FALSE" || v === "false") return "FALSE";
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  const s = String(v ?? "").trim();
  if (s !== "" && /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return String(Math.round(Number(s) * 100) / 100);
  return s;
}

/**
 * Group changed cells into a few rectangles: rows with changes are merged into
 * bands (allowing small gaps); too many bands collapse into one bounding box.
 * Every cell inside a rectangle is rewritten, so rectangles trade a little
 * redundancy for far fewer Apps Script calls.
 */
export function dirtyRects(prev: Uint32Array | null, next: Uint32Array, w: number, h: number, maxBands = 6): { x0: number; y0: number; x1: number; y1: number }[] {
  const rows: [number, number][] = [];
  for (let y = 0; y < h; y++) {
    let a = -1, b = -1;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!prev || prev[i] !== next[i]) {
        if (a < 0) a = x;
        b = x;
      }
    }
    rows[y] = [a, b];
  }
  const bands: { x0: number; y0: number; x1: number; y1: number }[] = [];
  let cur: (typeof bands)[number] | null = null;
  let gap = 0;
  for (let y = 0; y < h; y++) {
    const [a, b] = rows[y];
    if (a < 0) {
      if (cur && ++gap > 2) {
        bands.push(cur);
        cur = null;
      }
      continue;
    }
    gap = 0;
    if (!cur) cur = { x0: a, y0: y, x1: b + 1, y1: y + 1 };
    else {
      cur.x0 = Math.min(cur.x0, a);
      cur.x1 = Math.max(cur.x1, b + 1);
      cur.y1 = y + 1;
    }
  }
  if (cur) bands.push(cur);
  if (bands.length > maxBands) {
    const all = bands.reduce((u, r) => ({ x0: Math.min(u.x0, r.x0), y0: Math.min(u.y0, r.y0), x1: Math.max(u.x1, r.x1), y1: Math.max(u.y1, r.y1) }));
    return [all];
  }
  return bands;
}

export class GoogleSheetsBackend implements RenderBackend {
  readonly id = "google-sheets";
  readonly label = "Google Sheets (Apps Script)";
  readonly capabilities: BackendCapabilities = { cellFrames: true, directCanvas: false, measuredCellBudget: 0, input: false, stateEdit: true };
  private w: number;
  private h: number;
  private shown: Uint32Array | null = null; // colours currently in the sheet
  private latest: Uint32Array | null = null;
  private inFlight = false;
  private rate = new RateCounter();
  private rtt = new Ema(0.2);
  private s: BackendStats = emptyStats();
  private emit!: (p: Record<string, StateValue>) => void;
  private lastSent = new Map<string, string>(); // what we last wrote (or accepted) per variable
  private lastFormula = new Map<string, string>();
  private snapshot: StateSnapshot | null = null;
  private lastSheets = 0;
  private hudLines: string[] = ["", "", ""];
  lastApplyMs = 0;
  lastCells = 0;
  errors: string[] = [];
  onStatus: (s: string, err?: boolean) => void = () => {};

  constructor(w: number, h: number, private call: Transport, private game: SpreadsheetGame, private host: StudioHost) {
    this.w = w;
    this.h = h;
  }

  async init(i: { emitState: (p: Record<string, StateValue>) => void }): Promise<void> {
    this.emit = i.emitState;
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.shown = null;
    this.latest = null;
  }

  submitFrame(frame: IndexedFrame, _diff: FrameDiff): boolean {
    // keep only colours: the sheet stores fills, so a palette change is just more changed cells
    const n = frame.width * frame.height;
    if (!this.latest || this.latest.length !== n) this.latest = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.latest[i] = frame.palette[frame.indices[i]];
    if (this.inFlight) {
      this.s.droppedFrames++;
      return false;
    }
    void this.send();
    return true;
  }

  syncState(s: StateSnapshot): void {
    this.snapshot = s;
    const hud = this.game.hud();
    this.hudLines = [hud.stats.map(([k, v]) => `${k} ${v}`).join("   ·   "), hud.banner ? `★ ${hud.banner}` : `▸ ${hud.objective}`, hud.hint ?? ""];
  }

  private async send(): Promise<void> {
    if (!this.latest) return;
    this.inFlight = true;
    const frame = this.latest.slice();
    const rects = dirtyRects(this.shown, frame, this.w, this.h).map((r) => {
      const colors: string[][] = [];
      for (let y = r.y0; y < r.y1; y++) {
        const row: string[] = [];
        for (let x = r.x0; x < r.x1; x++) row.push(hex(frame[y * this.w + x]));
        colors.push(row);
      }
      return { r: r.y0, c: r.x0, colors };
    });
    const cells = rects.reduce((s, r) => s + r.colors.length * r.colors[0].length, 0);
    // live values the game changed since we last wrote them
    const values: Record<string, unknown> = {};
    const snap = this.snapshot;
    if (snap)
      for (const d of this.game.variables) {
        const v = snap.values[d.key];
        const n = norm(v);
        if (this.lastSent.get(d.key) !== n) {
          values[d.key] = typeof v === "number" ? Math.round(v * 100) / 100 : v;
          this.lastSent.set(d.key, n);
        }
      }
    const ruleValues: Record<string, number> = {};
    if (snap) for (const r of snap.rules) ruleValues[r.name] = Math.round(r.value * 100) / 100;
    let sheets: { name: string; columns: string[]; rows: (string | number)[][] }[] | null = null;
    if (performance.now() - this.lastSheets > 4000) {
      this.lastSheets = performance.now();
      sheets = this.game.customSheets.map((s) => ({ name: s.name, columns: s.columns, rows: s.rows().map((r) => r.cells.map((c) => (typeof c === "number" ? c : String(c)))) }));
    }
    const t0 = performance.now();
    try {
      const res: ApplyResult = await this.call("applyFrame", { rects, hud: { lines: this.hudLines }, values: Object.keys(values).length ? values : null, ruleValues, sheets });
      this.shown = frame;
      this.lastApplyMs = res.applyMs;
      this.lastCells = cells;
      this.s.lastChangedCells = cells;
      this.s.presentMs = this.rtt.push(performance.now() - t0);
      this.s.connected = true;
      this.rate.tick();
      this.absorbEdits(res);
    } catch (e) {
      this.s.connected = false;
      this.onStatus("Sheet update failed: " + ((e as Error)?.message ?? e), true);
      // retry with a full repaint next time
      this.shown = null;
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      this.inFlight = false;
    }
  }

  /** Values or formulas that differ from what we wrote were typed by the player. */
  private absorbEdits(res: ApplyResult): void {
    const patch: Record<string, StateValue> = {};
    for (const [k, v] of Object.entries(res.values ?? {})) {
      const n = norm(v);
      const prev = this.lastSent.get(k);
      if (prev === undefined) {
        this.lastSent.set(k, n);
        continue;
      }
      if (n !== prev) patch[k] = typeof v === "boolean" ? v : (v as string | number);
    }
    for (const [name, f] of Object.entries(res.formulas ?? {})) {
      const prev = this.lastFormula.get(name);
      this.lastFormula.set(name, f);
      if (prev !== undefined && f && f !== prev) patch["rule:" + name] = f;
    }
    if (!Object.keys(patch).length) return;
    const errors = this.host.applyPatch(patch, "google-sheets");
    for (const k of Object.keys(patch)) {
      if (k.startsWith("rule:")) continue;
      // accepted: remember the cleaned value; rejected: forget it so the game's value is written back
      if (errors[k]) this.lastSent.delete(k);
      else this.lastSent.set(k, norm(this.host.registry.get(k)));
    }
    const msgs = Object.entries(errors).map(([k, e]) => `${k.replace(/^rule:/, "")}: ${e}`);
    this.errors = msgs;
    this.onStatus(msgs.length ? "Rejected - " + msgs.join("; ") : `Applied ${Object.keys(patch).length} edit(s) from the sheet`, msgs.length > 0);
  }

  stats(): BackendStats {
    return { ...this.s, presentedFps: this.rate.rate };
  }

  async shutdown(): Promise<void> {}
}

export interface SidebarOptions {
  createGame: () => SpreadsheetGame;
  call: Transport;
  root: HTMLElement;
  width?: number;
  height?: number;
}

/** Boot the sidebar UI: lay out the sheets, then run the game loop with an adjustable game speed. */
export async function bootSidebar(o: SidebarOptions): Promise<{ host: StudioHost; backend: GoogleSheetsBackend; game: SpreadsheetGame }> {
  const W = o.width ?? 80, H = o.height ?? 45;
  const game = o.createGame();
  const host = new StudioHost(game, { width: W, height: H, quantize: { mode: "fixed256", hysteresis: 0 } });
  const preview = o.root.querySelector(".preview") as HTMLElement;
  await host.init(preview);
  const status = o.root.querySelector(".status") as HTMLElement;
  const stats = o.root.querySelector(".stats") as HTMLElement;
  const say = (s: string, err = false) => {
    status.textContent = s;
    status.className = "status" + (err ? " err" : "");
  };
  say("Setting up the sheets…");
  const cellPx = W <= 80 ? 8 : 5;
  const res = await o.call("setupLayout", {
    title: game.title,
    width: W,
    height: H,
    cellPx,
    variables: game.variables,
    rules: host.registry.ruleDefs(),
    sheets: game.customSheets.map((s) => ({ name: s.name, columns: s.columns })),
  });
  say(res?.rebuilt ? "Sheets created. Playing - keep this panel focused for the keyboard." : "Playing - keep this panel focused for the keyboard.");
  const backend = new GoogleSheetsBackend(W, H, o.call, game, host);
  backend.onStatus = say;
  await host.addBackend(backend);
  host.directVisible = false;
  bindKeyboard(window, game.keyBindings, (e) => host.sendInput(e), () => document.activeElement?.tagName !== "SELECT");
  // hold-to-press buttons
  o.root.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((b) => {
    const a = b.dataset.action!;
    const down = (e: Event) => {
      e.preventDefault();
      host.sendInput({ type: "action", action: a, down: true });
    };
    const up = () => host.sendInput({ type: "action", action: a, down: false });
    b.addEventListener("pointerdown", down);
    b.addEventListener("pointerup", up);
    b.addEventListener("pointerleave", up);
    b.addEventListener("pointercancel", up);
  });
  o.root.querySelectorAll<HTMLButtonElement>("[data-command]").forEach((b) => b.addEventListener("click", () => game.runCommand(b.dataset.command!)));
  const speed = o.root.querySelector(".speed") as HTMLInputElement;
  const speedLbl = o.root.querySelector(".speedv") as HTMLElement;
  const pv = o.root.querySelector(".pvtoggle") as HTMLInputElement;
  pv.addEventListener("change", () => {
    preview.style.display = pv.checked ? "block" : "none";
    host.directVisible = pv.checked;
  });
  // our own clock so the game can run slower than real time while the sheet catches up
  let clock = performance.now(), last = clock;
  host.stop();
  const tick = (now: number) => {
    const k = +speed.value;
    speedLbl.textContent = `${Math.round(k * 100)}%`;
    clock += (now - last) * k;
    last = now;
    host.frame(clock);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setInterval(() => {
    const s = backend.stats();
    stats.textContent = `sheet ${s.presentedFps} upd/s · round trip ${Math.round(s.presentMs)} ms · Apps Script ${backend.lastApplyMs} ms · ${backend.lastCells} cells last update`;
  }, 500);
  (window as unknown as Record<string, unknown>).sgs = { host, backend, game };
  return { host, backend, game };
}
