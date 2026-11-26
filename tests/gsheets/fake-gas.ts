/**
 * An in-memory spreadsheet that implements the Apps Script methods the phone
 * edition calls, and nothing else: an unknown method throws, like a typo would
 * in real Apps Script. Each trigger runs Code.gs in a fresh VM context with only
 * ECMAScript built-ins plus SpreadsheetApp/LockService, the way Apps Script
 * starts every execution with fresh globals (no setTimeout, TextEncoder, DOM).
 * It does not model Google's latency or quotas.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

export interface Cell {
  v: unknown;
  f: string;
  bg: string;
  checkbox?: boolean;
  list?: string[];
}

export class Book {
  sheets: Sheet[] = [];
  named = new Map<string, Range>();
  calls: string[] = [];
  active: Sheet | null = null;
  /** CacheService document cache (survives between executions, like the real one). */
  cache = new Map<string, string>();
  byName(n: string) {
    return this.sheets.find((s) => s.name === n) ?? null;
  }
}

export class Sheet {
  cells = new Map<string, Cell>();
  rows = 1000;
  cols = 26;
  colW: Record<number, number> = {};
  rowH: Record<number, number> = {};
  merges: string[] = [];
  frozen = 0;
  hidden = false;
  gridlinesHidden = false;
  constructor(public book: Book, public name: string) {}
  private log(m: string) {
    this.book.calls.push(m);
  }
  cell(r: number, c: number): Cell {
    const k = r + "," + c;
    let x = this.cells.get(k);
    if (!x) this.cells.set(k, (x = { v: "", f: "", bg: "#ffffff" }));
    return x;
  }
  getName() { return this.name; }
  getMaxRows() { return this.rows; }
  getMaxColumns() { return this.cols; }
  getLastRow() { let m = 0; for (const [k, c] of this.cells) if (c.v !== "" || c.f) m = Math.max(m, +k.split(",")[0]); return m; }
  getLastColumn() { let m = 0; for (const [k, c] of this.cells) if (c.v !== "" || c.f) m = Math.max(m, +k.split(",")[1]); return m; }
  insertRowsAfter(_a: number, n: number) { this.rows += n; return this; }
  insertColumnsAfter(_a: number, n: number) { this.cols += n; return this; }
  deleteRows(start: number, n: number) { if (start + n - 1 > this.rows) throw new Error("deleteRows out of range"); this.rows -= n; return this; }
  deleteColumns(start: number, n: number) { if (start + n - 1 > this.cols) throw new Error("deleteColumns out of range"); this.cols -= n; return this; }
  setColumnWidths(s: number, n: number, w: number) { for (let i = 0; i < n; i++) this.colW[s + i] = w; return this; }
  setColumnWidth(c: number, w: number) { this.colW[c] = w; return this; }
  setRowHeightsForced(s: number, n: number, h: number) { for (let i = 0; i < n; i++) this.rowH[s + i] = h; return this; }
  setFrozenRows(n: number) { this.frozen = n; return this; }
  setTabColor() { return this; }
  setHiddenGridlines(v: boolean) { this.gridlinesHidden = v; return this; }
  hideSheet() { this.hidden = true; return this; }
  clear() { this.log("clear"); this.cells.clear(); this.merges = []; return this; }
  getRange(r: number, c: number, h = 1, w = 1) {
    if (![r, c, h, w].every(Number.isInteger) || r < 1 || c < 1 || h < 1 || w < 1 || r + h - 1 > this.rows || c + w - 1 > this.cols) throw new Error(`Range out of bounds ${this.name}!R${r}C${c} ${h}x${w}`);
    return new Range(this, r, c, h, w);
  }
}

export class Range {
  constructor(public sh: Sheet, public r: number, public c: number, public h: number, public w: number) {}
  private log(m: string) { this.sh.book.calls.push(m); }
  private each(fn: (cell: Cell, y: number, x: number) => void) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) fn(this.sh.cell(this.r + y, this.c + x), y, x); }
  private shape(a: unknown[][], what: string) { if (!Array.isArray(a) || a.length !== this.h || a.some((row) => !Array.isArray(row) || row.length !== this.w)) throw new Error(`${what}: data does not match range ${this.h}x${this.w}`); }
  getSheet() { return this.sh; }
  getRow() { return this.r; }
  getColumn() { return this.c; }
  getNumRows() { return this.h; }
  getNumColumns() { return this.w; }
  merge() { this.sh.merges.push(`${this.r},${this.c},${this.h},${this.w}`); return this; }
  breakApart() { this.sh.merges = []; return this; }
  insertCheckboxes() { this.each((c) => { c.checkbox = true; c.v = false; }); return this; }
  setDataValidation(rule: { list: string[] }) { this.each((c) => (c.list = rule.list)); return this; }
  setBackgrounds(a: string[][]) { this.log("setBackgrounds"); this.shape(a, "setBackgrounds"); this.each((c, y, x) => { if (!/^#[0-9a-f]{6}$/i.test(a[y][x])) throw new Error("bad colour " + a[y][x]); c.bg = a[y][x]; }); return this; }
  setBackground(b: string) { this.each((c) => (c.bg = b)); return this; }
  setFontColor() { return this; }
  setFontWeight() { return this; }
  setFontSize() { return this; }
  setHorizontalAlignment() { return this; }
  setVerticalAlignment() { return this; }
  setValues(a: unknown[][]) { this.log("setValues"); this.shape(a, "setValues"); this.each((c, y, x) => { const v = a[y][x]; if (typeof v === "string" && v.startsWith("=")) { c.f = v; c.v = ""; } else { c.v = v; c.f = ""; } }); return this; }
  setValue(v: unknown) { this.log("setValue"); this.each((c) => { c.v = v; c.f = ""; }); return this; }
  setFormula(f: string) { this.log("setFormula"); this.each((c) => { c.f = f; c.v = ""; }); return this; }
  getValue() { this.log("getValue"); return this.sh.cell(this.r, this.c).v; }
  getValues() { this.log("getValues"); const out: unknown[][] = []; for (let y = 0; y < this.h; y++) { const row: unknown[] = []; for (let x = 0; x < this.w; x++) row.push(this.sh.cell(this.r + y, this.c + x).v); out.push(row); } return out; }
  getFormula() { this.log("getFormula"); return this.sh.cell(this.r, this.c).f; }
  clearContent() { this.each((c) => { c.v = ""; c.f = ""; }); return this; }
}

export function makeBook(): Book {
  const b = new Book();
  b.sheets.push(new Sheet(b, "Sheet1"));
  return b;
}

let codePath = "dist/gsheets-phone/Code.gs";
/** Point the fake at another built Code.gs (e.g. a different game). */
export function useCode(path: string) {
  codePath = path;
}
const CODE = () => readFileSync(codePath, "utf8");

/** Run one Apps Script execution (fresh globals) of `fn` against the book. */
export function execute(book: Book, fn: "setupGame" | "onOpen" | "onEdit", arg?: unknown) {
  const spreadsheet = {
    getSheetByName: (n: string) => book.byName(n),
    insertSheet: (n: string) => { if (book.byName(n)) throw new Error("exists " + n); const s = new Sheet(book, n); book.sheets.push(s); return s; },
    deleteSheet: (s: Sheet) => { if (book.sheets.length === 1) throw new Error("cannot delete the only sheet"); book.sheets = book.sheets.filter((x) => x !== s); },
    getNamedRanges: () => [...book.named.keys()].map((k) => ({ remove: () => book.named.delete(k) })),
    setNamedRange: (n: string, r: Range) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) || /^[A-Za-z]{1,3}\d+$/.test(n) || /^(true|false)$/i.test(n)) throw new Error("Invalid named range " + n);
      book.named.set(n, r);
    },
    setActiveSheet: (s: Sheet) => { book.active = s; return s; },
  };
  const ctx = vm.createContext({
    SpreadsheetApp: {
      getActive: () => spreadsheet,
      getUi: () => ({ createMenu: () => ({ addItem() { return this; }, addToUi() {} }) }),
      newDataValidation: () => {
        const rule = { list: [] as string[] };
        const b = { requireValueInList: (l: string[]) => { rule.list = l; return b; }, setAllowInvalid: () => b, build: () => rule };
        return b;
      },
    },
    CacheService: { getDocumentCache: () => ({ get: (k: string) => book.cache.get(k) ?? null, put: (k: string, v: string) => { if (v.length > 100000) throw new Error("cache value too large"); book.cache.set(k, v); }, remove: (k: string) => book.cache.delete(k) }) },
    LockService: { getDocumentLock: () => ({ waitLock() {}, releaseLock() {} }) },
    console: { log() {} },
  });
  vm.runInContext(CODE(), ctx, { filename: "Code.gs" });
  book.calls = [];
  const t = Date.now();
  vm.runInContext(`${fn}(__arg)`, Object.assign(ctx, { __arg: arg }));
  return { ms: Date.now() - t, calls: book.calls.length };
}

/** The player taps (toggles) a cell in the sheet, then the onEdit trigger runs. */
export function tap(book: Book, sheetName: string, row: number, col: number) {
  const sh = book.byName(sheetName)!;
  const c = sh.cell(row, col);
  const old = c.v;
  c.v = !(old === true);
  return execute(book, "onEdit", { range: sh.getRange(row, col), value: String(c.v).toUpperCase(), oldValue: String(old).toUpperCase() });
}

/** The player types into a cell (value or formula), then the onEdit trigger runs. */
export function type(book: Book, sheetName: string, row: number, col: number, text: string) {
  const sh = book.byName(sheetName)!;
  const c = sh.cell(row, col);
  const old = c.v;
  if (text.startsWith("=")) { c.f = text; c.v = "(computed)"; } else { c.v = isNaN(Number(text)) || text === "" ? text : Number(text); c.f = ""; }
  return execute(book, "onEdit", { range: sh.getRange(row, col), value: c.v, oldValue: old });
}
