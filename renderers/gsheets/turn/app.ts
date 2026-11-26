/**
 * Apps Script side of the turn-based Google Sheets port, for any TurnApp.
 *
 * The build bundles this, the game and a tiny entry into one Code.gs, and
 * appends top-level onOpen/onEdit/setup wrappers. Only services that simple
 * triggers may use are touched (SpreadsheetApp on this file, CacheService,
 * LockService), so players are never asked to authorise anything and it works
 * in the Sheets phone app.
 *
 * Each tap on a GAME checkbox fires onEdit: load the saved game (cache first,
 * sheet as backup), play one move, paint only the changed cells, save.
 */
import type { SavedBase, TurnApp, TurnSessionLike } from "./kit";
import { changedRects } from "./kit";

declare const SpreadsheetApp: any;
declare const LockService: any;
declare const CacheService: any;

export const GAME = "GAME";
export const STATE = "_STATE";
const HUD_ROWS = 4; // 1 status, 2 message, 3 control labels, 4 control checkboxes
const CTRL_ROW = 4;
const CHUNK = 40000;
/** Every Nth tap the game is also written to the hidden _STATE tab (the cache can expire after 6 hours). */
const SHEET_EVERY = 4;
const TINTS = ["#f1f8e9", "#fff8e1", "#e3f2fd", "#fce4ec", "#ede7f6", "#e0f2f1"];

export function createTurnApp(app: TurnApp) {
  const W = app.width, H = app.height;
  const CELL = app.cellPx ?? (W > 100 ? 4 : 6);
  const controls = app.controls;
  const stepsW = app.stepOptions ? Math.max(8, Math.round(W / (controls.length + 1))) : 0;
  const CW = Math.max(1, Math.floor((W - stepsW) / controls.length));
  const STEPS_COL = app.stepOptions ? controls.length * CW + 1 : 0;
  const CACHE_KEY = `sgs-${app.layout}`;
  const T: Record<string, number> = {};
  const mark = (k: string) => (T[k] = Date.now());

  const ss = () => SpreadsheetApp.getActive();
  const sheet = (name: string, create = true) => ss().getSheetByName(name) || (create ? ss().insertSheet(name) : null);
  const ensureSize = (sh: any, rows: number, cols: number) => {
    if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
    if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
  };
  const varSheets = (s: TurnSessionLike) => [...new Set(s.game.variables.map((v) => v.sheet))];
  const tint = (name: string, s: TurnSessionLike) => {
    const all = [...varSheets(s), "RULES", ...s.game.customSheets.map((c) => c.name)];
    return TINTS[Math.max(0, all.indexOf(name)) % TINTS.length];
  };

  // ---- state ----------------------------------------------------------------
  function cache(): any {
    try {
      return CacheService.getDocumentCache();
    } catch {
      return null;
    }
  }
  function loadState(): SavedBase | null {
    try {
      const hit = cache()?.get(CACHE_KEY);
      if (hit) return JSON.parse(hit) as SavedBase;
    } catch {
      /* fall through to the sheet */
    }
    const sh = sheet(STATE, false);
    if (!sh) return null;
    const col = sh.getRange(1, 1, Math.min(sh.getMaxRows(), 8), 1).getValues();
    const n = Number(col[0][0]) || 0;
    if (!n || n > col.length - 1) return null;
    try {
      return JSON.parse(col.slice(1, 1 + n).map((r: unknown[]) => String(r[0]).slice(1)).join("")) as SavedBase;
    } catch {
      return null;
    }
  }
  function saveState(s: SavedBase, force = false) {
    const json = JSON.stringify(s);
    let cached = false;
    try {
      const c = cache();
      if (c && json.length < 100000) {
        c.put(CACHE_KEY, json, 21600);
        cached = true;
      }
    } catch {
      cached = false;
    }
    if (!force && cached && s.turns % SHEET_EVERY !== 0) return;
    const sh = sheet(STATE);
    // each chunk starts with "|" so Sheets never reads one as a number or a formula
    const rows: (string | number)[][] = [];
    for (let i = 0; i < json.length; i += CHUNK) rows.push(["|" + json.slice(i, i + CHUNK)]);
    rows.unshift([rows.length]);
    ensureSize(sh, Math.max(8, rows.length), 1);
    sh.getRange(1, 1, rows.length, 1).setValues(rows);
  }

  // ---- layout -----------------------------------------------------------------
  function setup() {
    const session = app.create(null);
    const g = sheet(GAME);
    g.clear();
    try {
      g.getRange(1, 1, g.getMaxRows(), g.getMaxColumns()).breakApart();
    } catch {
      /* nothing merged */
    }
    ensureSize(g, HUD_ROWS + H, W);
    if (g.getMaxColumns() > W) g.deleteColumns(W + 1, g.getMaxColumns() - W);
    if (g.getMaxRows() > HUD_ROWS + H) g.deleteRows(HUD_ROWS + H + 1, g.getMaxRows() - HUD_ROWS - H);
    g.setColumnWidths(1, W, CELL);
    g.setRowHeightsForced(1, 2, 22);
    g.setRowHeightsForced(3, 1, 18);
    g.setRowHeightsForced(4, 1, 34);
    g.setRowHeightsForced(HUD_ROWS + 1, H, CELL);
    for (const r of [1, 2]) g.getRange(r, 1, 1, W).merge().setFontSize(r === 1 ? 9 : 10).setFontWeight(r === 2 ? "bold" : "normal").setVerticalAlignment("middle").setBackground(r === 1 ? "#2e3b1f" : "#f4f8f0").setFontColor(r === 1 ? "#ffffff" : "#33501a");
    controls.forEach((c, i) => {
      const col = 1 + i * CW;
      g.getRange(3, col, 1, CW).merge().setValue(c.label).setHorizontalAlignment("center").setFontWeight("bold").setFontSize(10).setBackground("#dcebd0");
      g.getRange(4, col, 1, CW).merge().setHorizontalAlignment("center").setVerticalAlignment("middle").setBackground("#f4f8f0");
      g.getRange(4, col).insertCheckboxes();
    });
    if (app.stepOptions) {
      g.getRange(3, STEPS_COL, 1, W - STEPS_COL + 1).merge().setValue("Steps").setHorizontalAlignment("center").setFontWeight("bold").setFontSize(10).setBackground("#dcebd0");
      g.getRange(4, STEPS_COL, 1, W - STEPS_COL + 1).merge().setHorizontalAlignment("center").setVerticalAlignment("middle").setFontSize(10);
      g.getRange(4, STEPS_COL).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(app.stepOptions, true).setAllowInvalid(false).build()).setValue(app.stepOptions[0]);
    }
    g.setFrozenRows(HUD_ROWS);
    g.setHiddenGridlines(true); // gridlines between small cells wash the picture out
    g.setTabColor("#3a7d2c");

    // variable sheets: Variable | Value | Min | Max | Unit | Description, one named range per value
    for (const r of ss().getNamedRanges()) r.remove();
    for (const name of varSheets(session)) {
      const sh = sheet(name);
      sh.clear();
      const defs = session.game.variables.filter((v) => v.sheet === name);
      ensureSize(sh, defs.length + 1, 6);
      sh.getRange(1, 1, 1, 6).setValues([["Variable", "Value", "Min", "Max", "Unit", "Description"]]).setFontWeight("bold").setBackground(tint(name, session));
      sh.getRange(2, 1, defs.length, 6).setValues(defs.map((d) => [d.label, session.registry.get(d.key), d.min ?? (d.options ? d.options.join(" / ") : ""), d.max ?? "", d.unit ?? "", (d.description ?? "") + (d.readOnly ? " (read-only)" : "")]));
      sh.getRange(2, 2, defs.length, 1).setBackground("#fffde7").setFontWeight("bold");
      sh.setColumnWidth(1, 170);
      sh.setColumnWidth(6, 320);
      sh.setFrozenRows(1);
      sh.setTabColor(tint(name, session));
      defs.forEach((d, i) => {
        if (!d.name) return;
        try {
          ss().setNamedRange(d.name, sh.getRange(2 + i, 2));
        } catch {
          /* a name Sheets refuses: the game still evaluates the rule itself */
        }
      });
    }
    // RULES: Rule | Formula (live Sheets formula over the named ranges) | Value the game uses | Description
    const defs = session.registry.ruleDefs();
    if (defs.length) {
      const rules = sheet("RULES");
      rules.clear();
      ensureSize(rules, defs.length + 1, 4);
      rules.getRange(1, 1, 1, 4).setValues([["Rule", "Formula", "Value in game", "Description"]]).setFontWeight("bold").setBackground(tint("RULES", session));
      rules.getRange(2, 1, defs.length, 4).setValues(defs.map((r) => [r.name, "", session.registry.rule(r.name), r.description ?? ""]));
      // rules refer to other rules (Price_Carrot uses Demand_Carrot), so each rule's formula cell
      // gets a named range too; names first, then formulas, so Sheets resolves every reference
      defs.forEach((r, i) => {
        try {
          ss().setNamedRange(r.name, rules.getRange(2 + i, 2));
        } catch {
          /* a name Sheets refuses: the game still evaluates the rule itself */
        }
      });
      defs.forEach((r, i) => {
        try {
          rules.getRange(2 + i, 2).setFormula(r.formula);
        } catch {
          rules.getRange(2 + i, 2).setValue("'" + r.formula);
        }
      });
      rules.getRange(2, 2, defs.length, 1).setBackground("#fffde7").setFontWeight("bold");
      rules.setColumnWidth(1, 150);
      rules.setColumnWidth(2, 260);
      rules.setColumnWidth(4, 320);
      rules.setFrozenRows(1);
      rules.setTabColor(tint("RULES", session));
    }
    for (const c of session.game.customSheets) {
      const sh = sheet(c.name);
      sh.clear();
      ensureSize(sh, 2, c.columns.length);
      sh.getRange(1, 1, 1, c.columns.length).setValues([c.columns]).setFontWeight("bold").setBackground(tint(c.name, session));
      sh.setFrozenRows(1);
      sh.setTabColor(tint(c.name, session));
    }
    const st = sheet(STATE);
    st.clear();
    st.hideSheet();
    const blank = ss().getSheetByName("Sheet1");
    if (blank && blank.getLastRow() === 0 && blank.getLastColumn() === 0) {
      try {
        ss().deleteSheet(blank);
      } catch {
        /* keep it */
      }
    }
    try {
      cache()?.remove(CACHE_KEY);
    } catch {
      /* ignore */
    }
    session.message = app.intro ?? ""; // empty: the game's own objective is shown
    paint(session);
    saveState(session.save(), true);
    ss().setActiveSheet(g);
  }

  // ---- turn ---------------------------------------------------------------------
  function paint(session: TurnSessionLike) {
    const g = sheet(GAME);
    const frame = session.render();
    mark("rendered");
    let cells = 0, rects = 0;
    for (const r of changedRects(session.frame.length === W * H ? session.frame : null, frame, W, H)) {
      g.getRange(HUD_ROWS + 1 + r.r, 1 + r.c, r.colors.length, r.colors[0].length).setBackgrounds(r.colors);
      cells += r.colors.length * r.colors[0].length;
      rects++;
    }
    T.cells = cells;
    T.rects = rects;
    session.frame = frame;
    const [top, msg] = session.hudLines();
    g.getRange(1, 1, 2, 1).setValues([[top], [msg]]);
    writeSheets(session);
  }

  function writeOnce(session: TurnSessionLike, key: string, rows: unknown[][], write: () => void) {
    const sig = JSON.stringify(rows);
    if (session.written[key] === sig) return;
    write();
    session.written[key] = sig;
  }

  function writeSheets(session: TurnSessionLike) {
    const reg = session.registry;
    for (const name of varSheets(session)) {
      const rows = session.game.variables.filter((v) => v.sheet === name).map((d) => [reg.get(d.key)]);
      writeOnce(session, name, rows, () => sheet(name).getRange(2, 2, rows.length, 1).setValues(rows));
    }
    const rdefs = reg.ruleDefs();
    if (rdefs.length) {
      const rv = rdefs.map((r) => [Math.round(reg.rule(r.name) * 100) / 100]);
      writeOnce(session, "RULES", rv, () => sheet("RULES").getRange(2, 3, rv.length, 1).setValues(rv));
    }
    for (const c of session.game.customSheets) {
      const rows = c.rows().map((r) => r.cells.map((v) => (v === undefined || v === null ? "" : v)));
      writeOnce(session, c.name, rows, () => {
        const sh = sheet(c.name);
        const old = Math.max(0, sh.getLastRow() - 1);
        if (old > rows.length) sh.getRange(2 + rows.length, 1, old - rows.length, c.columns.length).clearContent();
        if (rows.length) {
          ensureSize(sh, rows.length + 1, c.columns.length);
          sh.getRange(2, 1, rows.length, c.columns.length).setValues(rows);
        }
      });
    }
  }

  function withLock<R>(fn: () => R): R {
    let lock: any = null;
    try {
      lock = LockService.getDocumentLock();
      lock.waitLock(25000);
    } catch {
      lock = null;
    }
    try {
      return fn();
    } finally {
      try {
        lock?.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  function handle(e: any) {
    const range = e.range;
    const name: string = range.getSheet().getName();
    const row: number = range.getRow();
    const col: number = range.getColumn();
    const saved = loadState();
    mark("loaded");
    if (!saved && (!sheet(GAME, false) || !sheet(STATE, false))) return setup();
    // a sheet set up by another version (e.g. a copy made before an update): rebuild it
    if (!saved || saved.layout !== app.layout) return setup();
    const s = app.create(saved);

    if (name === GAME && row === CTRL_ROW) {
      if (app.stepOptions && col >= STEPS_COL) {
        s.steps = Number(String(range.getValue()).replace(/\D/g, "")) || 1;
        return saveState(s.save(), true);
      }
      const i = Math.floor((col - 1) / CW);
      const ctl = controls[i];
      if (!ctl) return;
      s.play(ctl.id);
      mark("played");
      paint(s);
      saveState(s.save());
      sheet(GAME).getRange(CTRL_ROW, 1 + i * CW).setValue(false);
      return;
    }

    if (varSheets(s).includes(name) && col === 2 && row >= 2) {
      const defs = s.game.variables.filter((v) => v.sheet === name);
      const n = range.getNumRows();
      const vals = range.getValues();
      const bad: string[] = [];
      for (let k = 0; k < n; k++) {
        const d = defs[row - 2 + k];
        if (!d) continue;
        const r = s.registry.edit(d.key, vals[k][0]);
        if (!r.ok) bad.push(`${d.label}: ${r.error}`);
      }
      delete s.written[name]; // rewrite the column: rejected cells are put back, accepted ones clamped
      s.message = bad.length ? "Rejected: " + bad.join("; ") : `Updated ${n === 1 ? defs[row - 2]?.label ?? "value" : n + " values"}`;
      paint(s);
      return saveState(s.save(), true);
    }

    if (name === "RULES" && col === 2 && row >= 2) {
      const d = s.registry.ruleDefs()[row - 2];
      if (!d) return;
      const f = String(range.getFormula() || range.getValue() || "");
      const old = d.formula;
      const r = s.registry.setRuleFormula(d.name, f);
      if (!r.ok) {
        try {
          range.setFormula(old);
        } catch {
          range.setValue("'" + old);
        }
        s.message = `Rejected: ${d.name}: ${r.error}`;
      } else s.message = `${d.name} is now ${f.startsWith("=") ? f : "=" + f}`;
      delete s.written.RULES;
      paint(s);
      return saveState(s.save(), true);
    }
  }

  return {
    setup: () => withLock(setup),
    onEdit(e: any) {
      mark("start");
      try {
        withLock(() => handle(e));
      } finally {
        // shown in Apps Script > Executions: where each tap's time goes
        console.log(JSON.stringify({ load: (T.loaded ?? T.start) - T.start, play: (T.played ?? T.loaded) - T.loaded, render: (T.rendered ?? T.played) - T.played, write: Date.now() - (T.rendered ?? T.start), cells: T.cells, rects: T.rects }));
      }
    },
    onOpen() {
      try {
        SpreadsheetApp.getUi().createMenu(app.title).addItem("Set up / restart from scratch", "setupGame").addToUi();
      } catch {
        /* no UI (phone app) */
      }
    },
  };
}
