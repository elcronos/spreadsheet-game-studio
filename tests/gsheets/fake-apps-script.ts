/**
 * A small in-memory stand-in for the parts of Apps Script that Code.gs uses
 * (SpreadsheetApp ranges, named ranges, document properties). It records
 * every API call so tests can count round trips. It does not model Google's
 * latency or quotas.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

type Cell = { v: unknown; bg: string; f: string };

export class FakeSheet {
  cells = new Map<string, Cell>();
  maxRows = 1000;
  maxCols = 26;
  colW = new Map<number, number>();
  rowH = new Map<number, number>();
  frozen = 0;
  constructor(public name: string, private log: string[]) {}
  cell(r: number, c: number): Cell {
    const k = r + "," + c;
    let x = this.cells.get(k);
    if (!x) this.cells.set(k, (x = { v: "", bg: "#ffffff", f: "" }));
    return x;
  }
  clear() { this.log.push("clear"); this.cells.clear(); }
  getMaxColumns() { return this.maxCols; }
  getMaxRows() { return this.maxRows; }
  insertColumnsAfter(_a: number, n: number) { this.maxCols += n; }
  insertRowsAfter(_a: number, n: number) { this.maxRows += n; }
  setColumnWidths(s: number, n: number, w: number) { for (let i = 0; i < n; i++) this.colW.set(s + i, w); }
  setRowHeights(s: number, n: number, h: number) { for (let i = 0; i < n; i++) this.rowH.set(s + i, h); }
  setColumnWidth(c: number, w: number) { this.colW.set(c, w); }
  setFrozenRows(n: number) { this.frozen = n; }
  getLastRow() { let m = 0; for (const [k, c] of this.cells) if (c.v !== "" || c.f) m = Math.max(m, +k.split(",")[0]); return m; }
  getRange(r: number, c: number, h = 1, w = 1) {
    if (r < 1 || c < 1 || r + h - 1 > this.maxRows || c + w - 1 > this.maxCols) throw new Error(`Range out of bounds ${this.name}!R${r}C${c} ${h}x${w}`);
    return new FakeRange(this, r, c, h, w, this.log);
  }
}

export class FakeRange {
  constructor(public sh: FakeSheet, public r: number, public c: number, public h: number, public w: number, private log: string[]) {}
  private each(fn: (cell: Cell, y: number, x: number) => void) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) fn(this.sh.cell(this.r + y, this.c + x), y, x); }
  private shape(a: unknown[][], what: string) { if (a.length !== this.h || a.some((row) => row.length !== this.w)) throw new Error(`${what}: data is ${a.length}x${a[0]?.length}, range is ${this.h}x${this.w}`); }
  setBackgrounds(a: string[][]) { this.log.push("setBackgrounds"); this.shape(a, "setBackgrounds"); this.each((c, y, x) => (c.bg = a[y][x])); return this; }
  setBackground(b: string) { this.log.push("setBackground"); this.each((c) => (c.bg = b)); return this; }
  setFontColor() { return this; }
  setFontWeight() { return this; }
  setFontStyle() { return this; }
  setValues(a: unknown[][]) { this.log.push("setValues"); this.shape(a, "setValues"); this.each((c, y, x) => { c.v = a[y][x]; c.f = ""; }); return this; }
  setValue(v: unknown) { this.log.push("setValue"); this.each((c) => { c.v = v; c.f = ""; }); return this; }
  setFormula(f: string) { this.log.push("setFormula"); this.each((c) => (c.f = f)); return this; }
  getValues() { this.log.push("getValues"); const out: unknown[][] = []; for (let y = 0; y < this.h; y++) { const row: unknown[] = []; for (let x = 0; x < this.w; x++) row.push(this.sh.cell(this.r + y, this.c + x).v); out.push(row); } return out; }
  getFormulas() { this.log.push("getFormulas"); const out: string[][] = []; for (let y = 0; y < this.h; y++) { const row: string[] = []; for (let x = 0; x < this.w; x++) row.push(this.sh.cell(this.r + y, this.c + x).f); out.push(row); } return out; }
  clearContent() { this.each((c) => { c.v = ""; c.f = ""; }); return this; }
}

export function loadCodeGs(path = "renderers/gsheets/Code.gs") {
  const log: string[] = [];
  const sheets = new Map<string, FakeSheet>();
  const named = new Map<string, FakeRange>();
  const props = new Map<string, string>();
  const ss = {
    getSheetByName: (n: string) => sheets.get(n) ?? null,
    insertSheet: (n: string) => { const s = new FakeSheet(n, log); sheets.set(n, s); return s; },
    getNamedRanges: () => [...named.keys()].map((k) => ({ remove: () => named.delete(k) })),
    setNamedRange: (n: string, r: FakeRange) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) || /^[A-Za-z]{1,3}\d+$/.test(n)) throw new Error("Invalid named range " + n);
      named.set(n, r);
    },
    setActiveSheet: () => {},
  };
  const context = {
    SpreadsheetApp: { getActive: () => ss, getUi: () => ({ createMenu: () => ({ addItem() { return this; }, addToUi() {} }), showSidebar() {}, alert() {} }) },
    HtmlService: { createHtmlOutputFromFile: () => ({ setTitle() { return this; } }) },
    PropertiesService: { getDocumentProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => props.set(k, v), deleteProperty: (k: string) => props.delete(k) }) },
    JSON, Object, Math, Date,
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(path, "utf8"), context);
  const api = context as unknown as { setupLayout: (m: unknown) => { rebuilt: boolean }; applyFrame: (p: unknown) => { applyMs: number; values: Record<string, unknown>; formulas: Record<string, string> } };
  return { api, sheets, named, log, ss };
}
