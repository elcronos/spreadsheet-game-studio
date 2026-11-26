/** Worksheet models for the browser spreadsheet: GAME, variable sheets, RULES, custom sheets, TELEMETRY. */
import type { CellView, Merge, SheetModel } from "./grid";
import type { CellStore } from "./backend";
import type { StudioHost, Telemetry } from "../../engines/core/host";
import type { VariableDef, StateValue } from "../../engines/core/variables";
import type { CustomSheet, HudState } from "../../engines/core/game";
import { cellAddress, columnName, hex } from "../../engines/core/frame";

export const GAME_ORIGIN = { col: 0, row: 3 };
export const BASE_CELL = 6;

const HEADER_FILL = "#eceef6";
const INPUT_FILL = "#fff8dc";

export class GameSheet implements SheetModel {
  readonly name = "GAME";
  frozenRows = 3;
  hud: HudState = { stats: [], objective: "" };
  painted = 0;
  /** CSS px per frame column (set by the shell after layout) for compact HUD labels. */
  pxPerCol = 6;
  frame: SheetModel["frame"];
  constructor(private store: CellStore, private host: StudioHost) {
    this.frame = { row: GAME_ORIGIN.row, col: GAME_ORIGIN.col, width: store.width, height: store.height, bitmap: store.bitmap, drawMode: "blit", cellFill: (x, y) => store.fill(x, y) };
  }
  sync(): void {
    this.frame!.width = this.store.width;
    this.frame!.height = this.store.height;
  }
  rows(): number {
    return GAME_ORIGIN.row + this.store.height;
  }
  cols(): number {
    return GAME_ORIGIN.col + this.store.width;
  }
  colWidth(): number {
    return BASE_CELL;
  }
  rowHeight(): number {
    return BASE_CELL;
  }
  fixedRowPx(r: number): number | undefined {
    return r === 0 ? 26 : r === 1 ? 24 : r === 2 ? 20 : undefined;
  }
  private segments(): number[] {
    const n = Math.max(1, this.hud.stats.length);
    const w = this.store.width;
    const out: number[] = [];
    for (let i = 0; i <= n; i++) out.push(Math.round((w * i) / n));
    return out;
  }
  merges(): Merge[] {
    const seg = this.segments();
    const m: Merge[] = [];
    for (let i = 0; i + 1 < seg.length; i++) m.push({ r0: 0, c0: seg[i], r1: 0, c1: seg[i + 1] - 1 });
    const split = Math.round(this.store.width * 0.68);
    m.push({ r0: 1, c0: 0, r1: 1, c1: split - 1 }, { r0: 1, c0: split, r1: 1, c1: this.store.width - 1 }, { r0: 2, c0: 0, r1: 2, c1: this.store.width - 1 });
    return m;
  }
  cell(r: number, c: number): CellView | null {
    if (r === 0) {
      const seg = this.segments();
      const i = seg.findIndex((s, k) => k + 1 < seg.length && c >= s && c < seg[k + 1]);
      const st = this.hud.stats[i];
      if (!st) return { fill: "#1c2033" };
      const colours: Record<string, string> = { CASH: "#7dffa8", HEALTH: "#ff8fa3", HEAT: "#ff7a8a", SPEED: "#22e6ff", STAMINA: "#9ff5ee" };
      const segPx = ((seg[i + 1] - seg[i]) * this.pxPerCol);
      const text = segPx > (st[0].length + st[1].length + 2) * 7.2 ? `${st[0]}  ${st[1]}` : st[1];
      return { text, fill: "#1c2033", color: colours[st[0]] ?? "#e8ebff", bold: true, align: "center" };
    }
    if (r === 1) {
      const split = Math.round(this.store.width * 0.68);
      if (c < split) return this.hud.banner ? { text: this.hud.banner, fill: "#3a1030", color: "#ffd23f", bold: true } : { text: "▸ " + this.hud.objective, fill: "#f3f4fb", color: "#283593", bold: true };
      return { text: this.hud.hint ?? "", fill: "#f3f4fb", color: "#5f6670", align: "right" };
    }
    if (r === 2) {
      const t = this.host.telemetry();
      return { text: `GAME!A4:${columnName(this.store.width - 1)}${GAME_ORIGIN.row + this.store.height} · ${this.store.width}×${this.store.height} = ${(this.store.width * this.store.height).toLocaleString()} cells · ${t.changedCells.toLocaleString()} changed last frame`, color: "#7a808a", italic: true, fill: "#ffffff" };
    }
    return null;
  }
  inFrame(r: number, c: number): boolean {
    return r >= GAME_ORIGIN.row && c >= GAME_ORIGIN.col && r < this.rows() && c < this.cols();
  }
  raw(r: number, c: number): string {
    if (this.inFrame(r, c)) return String(this.store.value(c - GAME_ORIGIN.col, r - GAME_ORIGIN.row));
    const v = this.cell(r, c);
    return v?.text ?? "";
  }
  describe(r: number, c: number): string {
    if (!this.inFrame(r, c)) return "";
    const x = c - GAME_ORIGIN.col, y = r - GAME_ORIGIN.row;
    const col = this.store.fill(x, y);
    return `pixel (${x}, ${y}) · palette index ${this.store.value(x, y)} · ${hex(col)} · rgb(${(col >> 16) & 255}, ${(col >> 8) & 255}, ${col & 255})`;
  }
  edit(r: number, c: number, text: string): string | null {
    if (!this.inFrame(r, c)) return "HUD cells are written by the game";
    const n = parseInt(text, 10);
    if (!Number.isInteger(n) || n < 0 || n >= this.store.palette.length) return `GAME cells hold a palette index 0-${this.store.palette.length - 1}`;
    const x = c - GAME_ORIGIN.col, y = r - GAME_ORIGIN.row;
    // value + pixel + bitmap updated together; it stays until the renderer next changes this cell
    this.store.setCell(x, y, n);
    this.painted++;
    return null;
  }
}

function fmt(v: StateValue, d?: VariableDef): string {
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (d?.unit === "$") return Math.round(v).toLocaleString("en-US");
    if (Number.isInteger(v)) return String(v);
    return String(Math.round(v * 100) / 100);
  }
  return String(v);
}

export class VariableSheet implements SheetModel {
  errors = new Map<string, string>();
  readonly columns = ["Variable", "Value", "Min", "Max", "Unit", "Description", "Defined name"];
  private widths = [250, 110, 64, 74, 82, 380, 170];
  constructor(readonly name: string, private defs: VariableDef[], private host: StudioHost) {}
  rows(): number {
    return this.defs.length + 1;
  }
  cols(): number {
    return this.columns.length;
  }
  colWidth(c: number): number {
    return this.widths[c];
  }
  rowHeight(): number {
    return 24;
  }
  frozenRows = 1;
  cell(r: number, c: number): CellView | null {
    if (r === 0) return { text: this.columns[c], fill: HEADER_FILL, bold: true };
    const d = this.defs[r - 1];
    if (!d) return null;
    const v = this.host.registry.get(d.key);
    switch (c) {
      case 0:
        return { text: d.label + (d.live ? "  ·live" : ""), color: "#1f2328" };
      case 1: {
        const err = this.errors.get(d.key);
        return { text: fmt(v, d), fill: d.readOnly ? "#f3f3f3" : INPUT_FILL, bold: true, align: typeof v === "number" ? "right" : "left", editable: !d.readOnly, flag: err ? "#e53935" : undefined, color: d.readOnly ? "#666" : "#1a237e" };
      }
      case 2:
        return { text: d.min !== undefined ? String(d.min) : d.options ? "list" : "", align: "right", color: "#6b7280" };
      case 3:
        return { text: d.max !== undefined ? String(d.max) : "", align: "right", color: "#6b7280" };
      case 4:
        return { text: d.unit ?? (d.type === "bool" ? "TRUE/FALSE" : ""), color: "#6b7280" };
      case 5:
        return { text: d.description ?? "", color: "#4b5563" };
      case 6:
        return { text: d.name ?? "", color: "#3949ab" };
    }
    return null;
  }
  raw(r: number, c: number): string {
    if (r === 0) return this.columns[c];
    const d = this.defs[r - 1];
    if (!d) return "";
    if (c === 1) return fmt(this.host.registry.get(d.key), d);
    return this.cell(r, c)?.text ?? "";
  }
  describe(r: number, c: number): string {
    const d = this.defs[r - 1];
    if (!d || c !== 1) return "";
    const e = this.errors.get(d.key);
    if (e) return "⚠ " + e;
    return d.options ? `Allowed: ${d.options.join(", ")}` : d.min !== undefined ? `Allowed: ${d.min} to ${d.max}${d.unit ? " " + d.unit : ""}` : "";
  }
  edit(r: number, c: number, text: string): string | null {
    const d = this.defs[r - 1];
    if (!d || c !== 1) return "Only the Value column is editable";
    const errs = this.host.applyPatch({ [d.key]: text }, "sheet");
    const e = errs[d.key];
    if (e) this.errors.set(d.key, e);
    else this.errors.delete(d.key);
    return e ?? null;
  }
  keyAt(r: number): string | undefined {
    return this.defs[r - 1]?.key;
  }
}

export class RulesSheet implements SheetModel {
  readonly name = "RULES";
  readonly columns = ["Rule (defined name)", "Formula (editable)", "Value used by the game", "Min", "Max", "What it drives"];
  private widths = [190, 340, 170, 60, 70, 360];
  errors = new Map<string, string>();
  frozenRows = 1;
  constructor(private host: StudioHost) {}
  private rules() {
    return this.host.registry.snapshot().rules;
  }
  rows(): number {
    return this.rules().length + 1;
  }
  cols(): number {
    return 6;
  }
  colWidth(c: number): number {
    return this.widths[c];
  }
  rowHeight(): number {
    return 24;
  }
  cell(r: number, c: number): CellView | null {
    if (r === 0) return { text: this.columns[c], fill: HEADER_FILL, bold: true };
    const ru = this.rules()[r - 1];
    if (!ru) return null;
    const def = this.host.registry.ruleDefs().find((d) => d.name === ru.name)!;
    const err = this.errors.get(ru.name) ?? ru.error;
    switch (c) {
      case 0:
        return { text: ru.name, bold: true, color: "#3949ab" };
      case 1:
        return { text: ru.formula, fill: INPUT_FILL, color: "#1a237e", editable: true, flag: err ? "#e53935" : undefined };
      case 2:
        return ru.error ? { text: ru.error.split(" ")[0] + "  (using " + round(ru.value) + ")", color: "#c62828", align: "right" } : { text: String(round(ru.value)), align: "right", bold: true };
      case 3:
        return { text: String(def.min), align: "right", color: "#6b7280" };
      case 4:
        return { text: String(def.max), align: "right", color: "#6b7280" };
      case 5:
        return { text: def.description, color: "#4b5563" };
    }
    return null;
  }
  raw(r: number, c: number): string {
    const ru = this.rules()[r - 1];
    if (r === 0 || !ru) return this.columns[c] ?? "";
    if (c === 1) return ru.formula;
    return this.cell(r, c)?.text ?? "";
  }
  describe(r: number, c: number): string {
    const ru = this.rules()[r - 1];
    if (!ru || c !== 1) return "";
    const e = this.errors.get(ru.name) ?? ru.error;
    return e ? "⚠ " + e : "Names: any Defined name from PLAYER, VEHICLES, WORLD or another rule. Functions: MIN MAX ROUND IF ABS SQRT MEDIAN …";
  }
  edit(r: number, c: number, text: string): string | null {
    const ru = this.rules()[r - 1];
    if (!ru || c !== 1) return "Only the Formula column is editable";
    const errs = this.host.applyPatch({ ["rule:" + ru.name]: text });
    const e = errs["rule:" + ru.name];
    if (e) this.errors.set(ru.name, e);
    else this.errors.delete(ru.name);
    return e ?? null;
  }
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

export class CustomSheetModel implements SheetModel {
  frozenRows = 1;
  constructor(private sheet: CustomSheet) {}
  get name(): string {
    return this.sheet.name;
  }
  rows(): number {
    return this.sheet.rows().length + 1;
  }
  cols(): number {
    return this.sheet.columns.length;
  }
  colWidth(c: number): number {
    const h = this.sheet.columns[c];
    return /Objective|Description|Mission|Progress/.test(h) ? 260 : 110;
  }
  rowHeight(): number {
    return 26;
  }
  cell(r: number, c: number): CellView | null {
    if (r === 0) return { text: this.sheet.columns[c], fill: HEADER_FILL, bold: true };
    const row = this.sheet.rows()[r - 1];
    if (!row) return null;
    const v = row.cells[c];
    const fill = row.style === "active" ? "#e8f5e9" : row.style === "done" ? "#e3f2fd" : row.style === "failed" ? "#fdecea" : undefined;
    const isNum = typeof v === "number";
    return { text: isNum ? (this.sheet.columns[c].includes("$") ? "$" + v.toLocaleString("en-US") : String(v)) : String(v ?? ""), fill, align: isNum ? "right" : "left", bold: c === 0 || this.sheet.columns[c] === "Status" };
  }
  raw(r: number, c: number): string {
    return this.cell(r, c)?.text ?? "";
  }
}

const METRICS: [keyof Telemetry, string, string][] = [
  ["gameFps", "Game FPS (display frames/s)", "fps"],
  ["sheetFps", "Spreadsheet FPS (cell frames presented/s)", "fps"],
  ["simHz", "Simulation steps per second", "Hz"],
  ["frameLatencyMs", "Frame latency (sim start → cells presented)", "ms"],
  ["simMs", "Simulation time per frame", "ms"],
  ["renderMs", "3D render time (conventional view)", "ms"],
  ["readbackMs", "Cell render + GPU readback", "ms"],
  ["quantizeMs", "Colour quantisation", "ms"],
  ["diffMs", "Frame differencing", "ms"],
  ["presentMs", "Spreadsheet present (cell store + draw)", "ms"],
  ["changedCells", "Cells changed last frame", "cells"],
  ["writtenCells", "Cells written (incl. merged runs)", "cells"],
  ["totalCells", "Cells in GAME range", "cells"],
  ["transportBytes", "Frame transport size (bridge)", "bytes"],
  ["droppedFrames", "Dropped frames (backpressure)", "frames"],
  ["entities", "Active entities", ""],
  ["memoryMB", "JS heap used", "MB"],
  ["paletteSize", "Palette size", "colours"],
  ["resolution", "Cell resolution", ""],
];

export class TelemetrySheet implements SheetModel {
  readonly name = "TELEMETRY";
  frozenRows = 1;
  t: Telemetry | null = null;
  history: number[] = [];
  extra: [string, string][] = [];
  rows(): number {
    return METRICS.length + 2 + this.extra.length + (this.t ? this.t.backends.length : 0);
  }
  cols(): number {
    return 4;
  }
  colWidth(c: number): number {
    return [340, 130, 80, 320][c];
  }
  rowHeight(): number {
    return 24;
  }
  cell(r: number, c: number): CellView | null {
    if (r === 0) return { text: ["Metric", "Value", "Unit", "Last 60 samples (game FPS)"][c], fill: HEADER_FILL, bold: true };
    const t = this.t;
    if (!t) return null;
    if (r - 1 < METRICS.length) {
      const [k, label, unit] = METRICS[r - 1];
      const v = t[k];
      if (c === 0) return { text: label };
      if (c === 1) return { text: typeof v === "number" ? (v < 0 ? "n/a" : Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)) : String(v), align: "right", bold: true };
      if (c === 2) return { text: unit, color: "#6b7280" };
      if (c === 3 && r === 1) return { text: spark(this.history), color: "#3949ab" };
      return null;
    }
    const i = r - 1 - METRICS.length;
    if (i === 0) return c === 0 ? { text: "Backends", bold: true, fill: HEADER_FILL } : { fill: HEADER_FILL };
    const b = t.backends[i - 1];
    if (b) {
      if (c === 0) return { text: `  ${b.id}` };
      if (c === 1) return { text: `${b.fps} fps`, align: "right" };
      if (c === 2) return { text: b.connected ? "connected" : "offline", color: b.connected ? "#2e7d32" : "#c62828" };
      return { text: `present ${b.presentMs.toFixed(2)} ms · dropped ${b.dropped}`, color: "#6b7280" };
    }
    const e = this.extra[i - 1 - t.backends.length];
    if (e) return c === 0 ? { text: e[0] } : c === 1 ? { text: e[1], align: "right" } : null;
    return null;
  }
  raw(r: number, c: number): string {
    return this.cell(r, c)?.text ?? "";
  }
}

function spark(h: number[]): string {
  const bars = "▁▂▃▄▅▆▇█";
  const max = Math.max(1, ...h);
  return h.map((v) => bars[Math.min(7, Math.floor((v / max) * 7.99))]).join("");
}

export { cellAddress };
