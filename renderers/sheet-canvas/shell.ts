/**
 * Cellframe - an original spreadsheet-style shell for StudioHost games.
 *
 * Modes:  3D      conventional full-screen view (game canvas + HUD)
 *         Sheet   GAME worksheet: one cell per pixel, gridlines off
 *         Grid    GAME worksheet with cell gridlines
 *         Editor  GAME worksheet + live simulation editor panel
 * Every displayed game pixel is a cell (A4…) whose value is its palette index.
 */
import type { StudioHost, Telemetry } from "../../engines/core/host";
import type { SpreadsheetGame } from "../../engines/core/game";
import { bindKeyboard } from "../../engines/core/input";
import { cellAddress, columnName, RESOLUTION_PRESETS } from "../../engines/core/frame";
import { GridView, SheetModel } from "./grid";
import { SheetCanvasBackend } from "./backend";
import { GameSheet, VariableSheet, RulesSheet, CustomSheetModel, TelemetrySheet, GAME_ORIGIN } from "./sheets";
import { ExcelBridgeBackend, DEFAULT_BRIDGE_URL } from "../excel/ExcelBridgeBackend";
import type { PaletteMode } from "../framebuffer/quantize";

export type Mode = "3d" | "sheet" | "grid" | "editor";

export interface ShellOptions {
  host: StudioHost;
  game: SpreadsheetGame;
  root: HTMLElement;
  fileName: string;
  /** Element the game was initialised into (its 3D canvas lives there). */
  view3d: HTMLElement;
  games?: { id: string; label: string }[];
  onSwitchGame?: (id: string) => void;
  /** Toggle the game's own HUD overlay (3D mode). */
  setGameHud?: (visible: boolean) => void;
}

const CSS = `
.cf-app{position:fixed;inset:0;display:grid;grid-template-rows:auto auto auto 1fr auto auto;background:#f6f7f9;color:#1f2328;font:13px/1.35 "Segoe UI",system-ui,-apple-system,Roboto,sans-serif;overflow:hidden}
.cf-title{display:flex;align-items:center;gap:10px;padding:6px 12px;background:#283593;color:#fff;min-height:40px;flex-wrap:wrap}
.cf-logo{display:grid;grid-template-columns:repeat(3,6px);gap:2px}
.cf-logo i{width:6px;height:6px;background:#9fa8ff;display:block}.cf-logo i:nth-child(3n+1){background:#ffd23f}.cf-logo i:nth-child(5){background:#ff5c8a}
.cf-brand{font-weight:700;letter-spacing:.3px}
.cf-file{opacity:.85;font-size:12.5px;white-space:nowrap}
.cf-title .sp{flex:1}
.cf-seg{display:flex;background:rgba(255,255,255,.14);border-radius:6px;padding:2px}
.cf-seg button{all:unset;cursor:pointer;padding:5px 11px;border-radius:5px;color:#e8eaff;font-weight:600;font-size:12.5px;min-height:20px}
.cf-seg button[aria-pressed=true]{background:#fff;color:#283593}
.cf-seg button:focus-visible,.cf-tb button:focus-visible,.cf-tabs button:focus-visible{outline:2px solid #ffd23f}
.cf-tb{display:flex;align-items:center;gap:6px;padding:5px 10px;background:#fff;border-bottom:1px solid #dfe2e8;flex-wrap:wrap;min-height:38px}
.cf-tb button,.cf-tb select{font:inherit;height:28px;border:1px solid #d5d9e0;background:#fff;border-radius:5px;padding:0 9px;color:#1f2328;cursor:pointer}
.cf-tb button:hover,.cf-tb select:hover{background:#f1f3f9}
.cf-tb button[aria-pressed=true]{background:#e8eaf6;border-color:#9fa8da;color:#283593}
.cf-tb .grp{display:flex;align-items:center;gap:4px;padding-right:8px;margin-right:2px;border-right:1px solid #eceef2}
.cf-tb label{font-size:11.5px;color:#6b7280}
.cf-perf{margin-left:auto;font:12px ui-monospace,Consolas,monospace;color:#374151;background:#f3f4f6;border-radius:5px;padding:5px 8px;white-space:nowrap}
.cf-fbar{display:flex;align-items:center;gap:6px;padding:4px 10px;background:#fff;border-bottom:1px solid #dfe2e8}
.cf-name{width:92px;font:600 12.5px ui-monospace,Consolas,monospace;border:1px solid #d5d9e0;border-radius:4px;padding:4px 6px;text-align:center;background:#fafbfc}
.cf-fx{font-style:italic;color:#6b7280;font-weight:600;padding:0 4px;border-right:1px solid #e5e7eb}
.cf-formula{flex:1;min-width:0;font:13px ui-monospace,Consolas,monospace;border:1px solid transparent;border-radius:4px;padding:4px 6px}
.cf-formula:focus{border-color:#9fa8da;outline:none;background:#fbfbff}
.cf-swatch{width:22px;height:22px;border-radius:4px;border:1px solid #cfd3da;flex:none}
.cf-main{position:relative;display:grid;grid-template-columns:1fr auto;min-height:0}
.cf-gridwrap{position:relative;min-width:0;min-height:0;overflow:hidden;background:#fff}
.cf-grid{position:absolute;inset:0;outline:none;touch-action:none}
.cf-view3d{position:absolute;inset:0;background:#000;display:none;z-index:4}
.cf-app[data-show3d=true] .cf-view3d{display:block}
.cf-editor{position:absolute;z-index:5;font:13px "Segoe UI",system-ui;border:2px solid #3949ab;padding:0 4px;box-sizing:border-box;outline:none;background:#fff}
.cf-side{width:300px;border-left:1px solid #dfe2e8;background:#fff;overflow:auto;display:none;padding:10px 12px}
.cf-app[data-mode=editor] .cf-side{display:block}
.cf-side h3{margin:4px 0 8px;font-size:13px;color:#283593}
.cf-side .row{display:grid;grid-template-columns:1fr 70px;gap:4px 8px;align-items:center;margin-bottom:8px}
.cf-side .row label{font-size:12px;color:#374151;grid-column:1/3;display:flex;justify-content:space-between}
.cf-side .row label b{color:#1a237e;font-family:ui-monospace,Consolas,monospace;font-weight:600}
.cf-side input[type=range]{grid-column:1/3;width:100%;accent-color:#3949ab;height:22px}
.cf-side select{grid-column:1/3;height:28px}
.cf-side .tabs{display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap}
.cf-side .tabs button{font:600 11.5px inherit;border:1px solid #d5d9e0;background:#fff;border-radius:12px;padding:3px 9px;cursor:pointer}
.cf-side .tabs button[aria-pressed=true]{background:#283593;color:#fff;border-color:#283593}
.cf-tabs{display:flex;gap:0;background:#eef0f4;border-top:1px solid #dfe2e8;overflow-x:auto;padding:0 6px;min-height:32px}
.cf-tabs button{all:unset;cursor:pointer;padding:6px 14px;font-weight:600;font-size:12.5px;color:#4b5563;border-right:1px solid #dde0e6;white-space:nowrap}
.cf-tabs button[aria-selected=true]{background:#fff;color:#283593;box-shadow:inset 0 3px 0 #3949ab}
.cf-status{display:flex;gap:14px;align-items:center;padding:3px 12px;background:#283593;color:#e8eaff;font-size:12px;min-height:24px;white-space:nowrap;overflow:hidden}
.cf-status .msg{flex:1;overflow:hidden;text-overflow:ellipsis}
.cf-status .err{color:#ffb4b4}
.cf-app .gc-hint{bottom:58px}
.cf-pill{position:absolute;left:50%;transform:translateX(-50%);bottom:12px;white-space:nowrap;z-index:6;background:rgba(40,53,147,.92);color:#fff;border-radius:16px;padding:6px 12px;font-size:12px;cursor:pointer;user-select:none}
.cf-pill.off{background:rgba(80,80,90,.88)}
.cf-modal{position:absolute;inset:0;background:rgba(20,24,40,.35);display:none;place-items:center;z-index:20}
.cf-modal.open{display:grid}
.cf-modal .box{background:#fff;border-radius:10px;padding:16px 18px;width:min(460px,92vw);box-shadow:0 10px 40px rgba(0,0,0,.25)}
.cf-modal h2{margin:0 0 8px;font-size:16px;color:#283593}
.cf-modal input{width:100%;box-sizing:border-box;font:13px ui-monospace,monospace;padding:6px;border:1px solid #cfd3da;border-radius:5px;margin:6px 0}
.cf-modal .btns{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
.cf-modal button{font:inherit;padding:6px 12px;border-radius:5px;border:1px solid #cfd3da;background:#fff;cursor:pointer}
.cf-modal button.primary{background:#283593;color:#fff;border-color:#283593}
.cf-modal table{border-collapse:collapse;width:100%;font-size:12.5px}.cf-modal td{padding:3px 6px;border-bottom:1px solid #eee}.cf-modal td:first-child{font-family:ui-monospace,monospace;white-space:nowrap}
.cf-touch{position:absolute;inset:0;pointer-events:none;z-index:7;display:none}
.cf-app[data-touch=true][data-gamevisible=true] .cf-touch{display:block}
.cf-joy{position:absolute;left:18px;bottom:18px;width:130px;height:130px;border-radius:50%;background:rgba(255,255,255,.18);border:2px solid rgba(255,255,255,.5);pointer-events:auto;touch-action:none}
.cf-joy i{position:absolute;left:40px;top:40px;width:50px;height:50px;border-radius:50%;background:rgba(255,255,255,.75)}
.cf-btns{position:absolute;right:14px;bottom:18px;display:grid;grid-template-columns:repeat(2,60px);gap:10px;pointer-events:auto}
.cf-btns button{width:60px;height:60px;border-radius:50%;border:2px solid rgba(255,255,255,.6);background:rgba(40,53,147,.55);color:#fff;font:700 18px system-ui;touch-action:none}
@media (max-width:760px){.cf-perf{display:none}.cf-tb .grp{border:0;padding-right:2px}.cf-file{display:none}.cf-tb label{display:none}.cf-side{position:absolute;right:0;top:0;bottom:0;z-index:8;width:min(300px,85vw);box-shadow:-6px 0 20px rgba(0,0,0,.15)}.cf-seg button{padding:5px 8px}}
`;

export class SheetApp {
  readonly el: HTMLDivElement;
  readonly grid: GridView;
  readonly backend: SheetCanvasBackend;
  readonly gameSheet: GameSheet;
  readonly sheets: SheetModel[];
  readonly telemetrySheet = new TelemetrySheet();
  mode: Mode = "sheet";
  active = "GAME";
  capture = true;
  private editing: HTMLInputElement | null = null;
  private nameBox!: HTMLInputElement;
  private formula!: HTMLInputElement;
  private swatch!: HTMLDivElement;
  private statusMsg!: HTMLSpanElement;
  private statusSel!: HTMLSpanElement;
  private statusFps!: HTMLSpanElement;
  private perf!: HTMLDivElement;
  private pill!: HTMLDivElement;
  private tabsEl!: HTMLElement;
  private sidePanel!: HTMLElement;
  private sideSheet = "WORLD";
  private bridge: ExcelBridgeBackend | null = null;
  private sheetDrawPending = false;
  private lastSideRefresh = 0;
  private fpsHistory: number[] = [];

  constructor(private o: ShellOptions) {
    const { host, game } = o;
    if (!document.getElementById("cf-css")) {
      const s = document.createElement("style");
      s.id = "cf-css";
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    this.el = document.createElement("div");
    this.el.className = "cf-app";
    this.el.dataset.touch = String(matchMedia("(pointer: coarse)").matches);
    o.root.appendChild(this.el);
    this.el.innerHTML = this.template();
    const $ = <T extends Element>(s: string) => this.el.querySelector(s) as T;
    this.nameBox = $(".cf-name");
    this.formula = $(".cf-formula");
    this.swatch = $(".cf-swatch");
    this.statusMsg = $(".cf-status .msg");
    this.statusSel = $(".cf-status .sel");
    this.statusFps = $(".cf-status .fps");
    this.perf = $(".cf-perf");
    this.pill = $(".cf-pill");
    this.tabsEl = $(".cf-tabs");
    this.sidePanel = $(".cf-side");
    const wrap = $<HTMLDivElement>(".cf-gridwrap");
    // 3D view lives inside the grid area so switching is instant
    const v3 = $<HTMLDivElement>(".cf-view3d");
    while (o.view3d.firstChild) v3.appendChild(o.view3d.firstChild);
    o.view3d.remove();
    (game as unknown as { attachTo?: (el: HTMLElement) => void }).attachTo?.(v3);

    this.backend = new SheetCanvasBackend(host.width, host.height);
    this.gameSheet = new GameSheet(this.backend.store, host);
    const varSheets = [...new Set(game.variables.map((v) => v.sheet))].map((s) => new VariableSheet(s, game.variables.filter((v) => v.sheet === s), host));
    this.sheets = [this.gameSheet, ...varSheets, ...game.customSheets.map((c) => new CustomSheetModel(c)), new RulesSheet(host), this.telemetrySheet];
    this.grid = new GridView(wrap, this.gameSheet);
    this.grid.onSelect = (r, c) => this.onSelect(r, c);
    this.grid.onEditRequest = (r, c, init) => this.startEdit(r, c, init);
    this.backend.onPresent = () => this.requestSheetDraw();
    host.onTelemetry.push((t) => this.onTelemetry(t));
    host.onResolution.push(() => {
      this.gameSheet.sync();
      this.grid.layout();
      if (this.active === "GAME") this.grid.fitFrame();
      this.syncResolutionSelect();
    });
    this.buildTabs();
    this.wire();
    this.setMode("sheet");
    requestAnimationFrame(() => {
      this.grid.resize();
      this.grid.fitFrame();
      this.grid.select(GAME_ORIGIN.row + Math.floor(host.height / 2), Math.floor(host.width / 2));
    });
  }

  private template(): string {
    const res = RESOLUTION_PRESETS.map((p) => `<option value="${p.id}">${p.width} × ${p.height}</option>`).join("");
    const cmds = this.o.game.commands.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join("");
    const games = (this.o.games ?? []).map((g) => `<option value="${g.id}">${esc(g.label)}</option>`).join("");
    return `
<header class="cf-title">
  <span class="cf-logo" aria-hidden="true">${"<i></i>".repeat(9)}</span>
  <span class="cf-brand">Cellframe</span>${games ? "" : `<span class="cf-file">${esc(this.o.fileName)}</span>`}
  ${games ? `<select class="cf-game" aria-label="Open workbook" style="height:26px;border-radius:5px;border:0">${games}</select>` : ""}
  <span class="sp"></span>
  <div class="cf-seg" role="group" aria-label="View mode">
    <button data-mode="3d">3D</button><button data-mode="sheet">Sheet</button><button data-mode="grid">Gridlines</button><button data-mode="editor">Sim editor</button>
  </div>
</header>
<div class="cf-tb">
  <div class="grp"><button class="cf-play" title="Pause / resume simulation">⏸ Pause</button></div>
  <div class="grp"><label for="cf-res">Cells</label><select id="cf-res" class="cf-res" title="GAME range size (one cell per pixel)">${res}</select></div>
  <div class="grp"><label for="cf-pal">Palette</label><select id="cf-pal" class="cf-pal" title="Colour quantisation"><option value="adaptive">Adaptive 192</option><option value="fixed256">Fixed 256</option><option value="fixed64">Fixed 64 (Excel)</option></select></div>
  <div class="grp"><button class="cf-zo" title="Zoom out">−</button><button class="cf-zfit" title="Fit GAME range">Fit</button><button class="cf-zi" title="Zoom in">+</button></div>
  <div class="grp"><select class="cf-cmd" aria-label="Commands"><option value="">Commands…</option>${cmds}</select></div>
  <div class="grp"><button class="cf-help">Controls</button><button class="cf-bridge" title="Stream frames into a native spreadsheet app (Excel or LibreOffice Calc) through the local bridge">Native bridge</button></div>
  <div class="cf-perf">-</div>
</div>
<div class="cf-fbar"><input class="cf-name" aria-label="Cell address" value="A4"><span class="cf-fx">fx</span><div class="cf-swatch" title="Cell fill"></div><input class="cf-formula" aria-label="Formula bar" spellcheck="false"></div>
<div class="cf-main">
  <div class="cf-gridwrap"><div class="cf-view3d"></div><div class="cf-pill" role="button" tabindex="0"></div>
    <div class="cf-touch"><div class="cf-joy"><i></i></div><div class="cf-btns">${this.o.game.touchButtons.map((b) => `<button data-action="${b.action}" aria-label="${b.action}">${esc(b.label)}</button>`).join("")}</div></div>
  </div>
  <aside class="cf-side" aria-label="Simulation editor"></aside>
</div>
<nav class="cf-tabs" role="tablist"></nav>
<footer class="cf-status"><span class="msg">Ready</span><span class="sel"></span><span class="fps"></span></footer>
<div class="cf-modal" role="dialog"><div class="box"></div></div>`;
  }

  private buildTabs(): void {
    this.tabsEl.innerHTML = this.sheets.map((s) => `<button role="tab" data-sheet="${s.name}" aria-selected="${s.name === this.active}">${s.name}</button>`).join("");
    this.tabsEl.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => this.showSheet(b.dataset.sheet!)));
  }

  showSheet(name: string): void {
    const m = this.sheets.find((s) => s.name === name);
    if (!m) return;
    this.cancelEdit();
    this.active = name;
    this.tabsEl.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.sheet === name)));
    this.grid.setModel(m);
    if (m === this.gameSheet) this.grid.fitFrame();
    else this.grid.zoom = 1;
    this.grid.layout();
    this.grid.select(m === this.gameSheet ? this.grid.sel.r : 1, m === this.gameSheet ? this.grid.sel.c : 1);
    this.applyVisibility();
  }

  setMode(m: Mode): void {
    this.mode = m;
    this.el.dataset.mode = m;
    this.el.querySelectorAll(".cf-seg button").forEach((b) => b.setAttribute("aria-pressed", String((b as HTMLElement).dataset.mode === m)));
    this.grid.frameGridlines = m === "grid";
    if (m !== "3d" && this.active !== "GAME" && m !== "editor") this.showSheet("GAME");
    if (m === "3d") this.showSheet("GAME");
    if (m === "editor") this.renderSide();
    this.applyVisibility();
    requestAnimationFrame(() => {
      this.grid.resize();
      if (this.active === "GAME") this.grid.fitFrame();
      this.grid.draw();
    });
  }

  private async applyVisibility(): Promise<void> {
    const { host } = this.o;
    const show3d = this.mode === "3d" && this.active === "GAME";
    this.el.dataset.show3d = String(show3d);
    this.el.dataset.gamevisible = String(this.active === "GAME");
    host.directVisible = show3d;
    this.o.setGameHud?.(show3d);
    const has = !!host.backend("sheet-canvas");
    // cells are produced whenever a sheet view (or a bridge) needs them
    if (!show3d && !has) await host.addBackend(this.backend);
    if (show3d && has && !this.bridge) await host.removeBackend("sheet-canvas");
    this.updatePill();
  }

  private requestSheetDraw(): void {
    if (this.active === "GAME" && this.mode !== "3d") {
      this.gameSheet.hud = this.o.game.hud();
      this.gameSheet.pxPerCol = this.grid.cellRect(3, 1).w;
      this.grid.draw();
    } else if (!this.sheetDrawPending) {
      this.sheetDrawPending = true;
      setTimeout(() => {
        this.sheetDrawPending = false;
        if (!this.editing) this.grid.draw();
      }, 200);
    }
  }

  private onTelemetry(t: Telemetry): void {
    this.telemetrySheet.t = t;
    this.fpsHistory.push(t.gameFps);
    if (this.fpsHistory.length > 60) this.fpsHistory.shift();
    this.telemetrySheet.history = this.fpsHistory;
    this.perf.textContent = `game ${t.gameFps} fps · sheet ${t.sheetFps} fps · ${t.changedCells.toLocaleString()} cells Δ · ${t.frameLatencyMs.toFixed(1)} ms`;
    this.statusFps.textContent = `${t.resolution} · ${t.entities} entities`;
    if (this.active !== "GAME" || this.mode === "3d") {
      if (!this.editing) this.grid.draw();
    }
    if (this.mode === "editor" && performance.now() - this.lastSideRefresh > 500) this.refreshSideValues();
    // keep the formula bar live for the selected cell
    if (!this.editing && document.activeElement !== this.formula) this.onSelect(this.grid.sel.r, this.grid.sel.c, true);
  }

  private onSelect(r: number, c: number, quiet = false): void {
    const m = this.grid.model;
    this.nameBox.value = cellAddress(c, r);
    if (document.activeElement !== this.formula) this.formula.value = m.raw?.(r, c) ?? "";
    const isFrame = m === this.gameSheet && this.gameSheet.inFrame(r, c);
    if (isFrame) {
      const col = this.backend.store.fill(c - GAME_ORIGIN.col, r - GAME_ORIGIN.row);
      this.swatch.style.background = "#" + col.toString(16).padStart(6, "0");
      this.swatch.style.display = "";
    } else this.swatch.style.display = "none";
    this.statusSel.textContent = m.describe?.(r, c) ?? "";
    if (!quiet && m !== this.gameSheet) this.status("Ready");
  }

  status(msg: string, err = false): void {
    this.statusMsg.textContent = msg;
    this.statusMsg.classList.toggle("err", err);
  }

  private startEdit(r: number, c: number, initial?: string): void {
    const m = this.grid.model;
    if (!m.edit) return;
    const cell = m.cell(r, c);
    if (m !== this.gameSheet && !cell?.editable) {
      this.status("This cell is read-only", true);
      return;
    }
    this.cancelEdit();
    const rect = this.grid.cellRect(r, c);
    const inp = document.createElement("input");
    inp.className = "cf-editor";
    inp.value = initial ?? m.raw?.(r, c) ?? "";
    Object.assign(inp.style, { left: rect.x + "px", top: rect.y + "px", width: Math.max(rect.w, 120) + "px", height: Math.max(rect.h, 24) + "px" });
    this.grid.canvas.parentElement!.appendChild(inp);
    inp.focus();
    if (initial === undefined) inp.select();
    this.editing = inp;
    this.capture = false;
    this.updatePill();
    const commit = (move: number) => {
      const v = inp.value;
      this.cancelEdit();
      this.commit(r, c, v);
      if (move) this.grid.select(r + move, c);
      this.grid.canvas.focus();
    };
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit(1);
      else if (e.key === "Tab") {
        e.preventDefault();
        commit(0);
      } else if (e.key === "Escape") {
        this.cancelEdit();
        this.grid.canvas.focus();
      }
    });
    inp.addEventListener("blur", () => this.editing === inp && commit(0));
  }

  private cancelEdit(): void {
    if (this.editing) {
      const e = this.editing;
      this.editing = null;
      e.remove();
    }
  }

  commit(r: number, c: number, text: string): string | null {
    const m = this.grid.model;
    const err = m.edit?.(r, c, text) ?? null;
    if (err) this.status(`${m.name}!${cellAddress(c, r)}: ${err}`, true);
    else this.status(`${m.name}!${cellAddress(c, r)} = ${text}`);
    this.grid.draw();
    this.onSelect(r, c, true);
    if (this.mode === "editor") this.refreshSideValues();
    return err;
  }

  started = false;

  /** Start the simulation; the GAME cells fill in from left to right. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.o.host.start();
    const t0 = performance.now();
    this.grid.reveal = 0;
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / 1400);
      this.grid.reveal = k * k * (3 - 2 * k);
      if (k < 1) requestAnimationFrame(tick);
    };
    tick();
    this.capture = true;
    this.updatePill();
    this.grid.canvas.focus();
  }

  private updatePill(): void {
    const gameVisible = this.active === "GAME";
    if (!this.started) {
      this.pill.style.display = gameVisible ? "" : "none";
      this.pill.classList.remove("off");
      this.pill.textContent = "▶ Start game";
      return;
    }
    this.pill.style.display = gameVisible ? "" : "none";
    this.pill.classList.toggle("off", !this.capture);
    this.pill.textContent = this.capture ? "● Playing - Esc to select cells" : "○ Selecting cells - Esc or click to play";
  }

  private wire(): void {
    const { host, game } = this.o;
    this.el.querySelectorAll(".cf-seg button").forEach((b) => b.addEventListener("click", () => this.setMode((b as HTMLElement).dataset.mode as Mode)));
    const play = this.el.querySelector(".cf-play") as HTMLButtonElement;
    play.addEventListener("click", () => {
      host.paused = !host.paused;
      play.textContent = host.paused ? "▶ Resume" : "⏸ Pause";
    });
    const res = this.el.querySelector(".cf-res") as HTMLSelectElement;
    res.addEventListener("change", () => {
      const p = RESOLUTION_PRESETS.find((x) => x.id === res.value)!;
      host.setResolution(p.width, p.height);
      this.status(`GAME range is now ${p.width} × ${p.height} = ${(p.width * p.height).toLocaleString()} cells`);
    });
    this.syncResolutionSelect();
    const pal = this.el.querySelector(".cf-pal") as HTMLSelectElement;
    pal.value = host.pipeline.quantizer.opts.mode;
    pal.addEventListener("change", () => {
      host.pipeline.quantizer.setOptions({ mode: pal.value as PaletteMode });
      host.pipeline.requestKeyframe();
    });
    (this.el.querySelector(".cf-zi") as HTMLButtonElement).addEventListener("click", () => {
      this.grid.setZoom(this.grid.zoom * 1.5);
      this.grid.draw();
    });
    (this.el.querySelector(".cf-zo") as HTMLButtonElement).addEventListener("click", () => {
      this.grid.setZoom(this.grid.zoom / 1.5);
      this.grid.draw();
    });
    (this.el.querySelector(".cf-zfit") as HTMLButtonElement).addEventListener("click", () => {
      this.grid.fitFrame();
      this.grid.draw();
    });
    const cmd = this.el.querySelector(".cf-cmd") as HTMLSelectElement;
    cmd.addEventListener("change", () => {
      if (cmd.value) {
        game.runCommand(cmd.value);
        this.status(`Ran: ${cmd.selectedOptions[0].text}`);
      }
      cmd.value = "";
      this.grid.canvas.focus();
      this.capture = true;
      this.updatePill();
    });
    (this.el.querySelector(".cf-help") as HTMLButtonElement).addEventListener("click", () => this.showHelp());
    (this.el.querySelector(".cf-bridge") as HTMLButtonElement).addEventListener("click", () => this.showBridge());
    const gs = this.el.querySelector(".cf-game") as HTMLSelectElement | null;
    if (gs) {
      gs.value = game.id;
      gs.addEventListener("change", () => this.o.onSwitchGame?.(gs.value));
    }
    this.pill.addEventListener("click", () => {
      if (!this.started) return void this.start();
      this.capture = !this.capture;
      this.updatePill();
      this.grid.canvas.focus();
    });
    // formula bar
    this.formula.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        this.commit(this.grid.sel.r, this.grid.sel.c, this.formula.value);
        this.grid.canvas.focus();
      } else if (e.key === "Escape") {
        this.onSelect(this.grid.sel.r, this.grid.sel.c, true);
        this.grid.canvas.focus();
      }
    });
    this.nameBox.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const m = /^([A-Z]+)(\d+)$/i.exec(this.nameBox.value.trim());
        if (m) {
          let c = 0;
          for (const ch of m[1].toUpperCase()) c = c * 26 + ch.charCodeAt(0) - 64;
          this.grid.select(parseInt(m[2], 10) - 1, c - 1);
          this.grid.canvas.focus();
        }
      }
    });
    // game keyboard (only while capturing on the GAME sheet)
    bindKeyboard(window, game.keyBindings, (e) => host.sendInput(e), () => this.capture && this.active === "GAME" && !this.editing && document.activeElement !== this.formula && document.activeElement !== this.nameBox);
    window.addEventListener("keydown", (e) => {
      if (this.editing || document.activeElement === this.formula || document.activeElement === this.nameBox) return;
      if ((e.target as HTMLElement)?.tagName === "SELECT") return;
      if (e.key === "Escape" && this.active === "GAME") {
        this.capture = !this.capture;
        if (!this.capture) host.input.releaseAll();
        this.updatePill();
        e.preventDefault();
        return;
      }
      if (this.capture && this.active === "GAME") return;
      const { r, c } = this.grid.sel;
      const mv: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, 1] };
      if (mv[e.key]) {
        e.preventDefault();
        const k = e.ctrlKey ? 10 : 1;
        this.grid.select(r + mv[e.key][0] * k, c + mv[e.key][1] * k);
      } else if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        this.startEdit(r, c);
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this.startEdit(r, c, e.key);
      }
    });
    this.grid.canvas.addEventListener("pointerdown", () => {
      // clicking cells selects them; play resumes with Esc or the pill
      if (this.active === "GAME" && this.capture) {
        this.capture = false;
        host.input.releaseAll();
        this.updatePill();
      }
    });
    this.wireTouch();
  }

  private wireTouch(): void {
    const { host } = this.o;
    const joy = this.el.querySelector(".cf-joy") as HTMLDivElement;
    const knob = joy.querySelector("i") as HTMLElement;
    let id: number | null = null;
    const move = (e: PointerEvent) => {
      const r = joy.getBoundingClientRect();
      let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const l = Math.hypot(dx, dy);
      if (l > 1) {
        dx /= l;
        dy /= l;
      }
      knob.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
      host.sendInput({ type: "axis", axis: "moveX", value: dx });
      host.sendInput({ type: "axis", axis: "moveY", value: -dy });
    };
    joy.addEventListener("pointerdown", (e) => {
      id = e.pointerId;
      joy.setPointerCapture(e.pointerId);
      move(e);
    });
    joy.addEventListener("pointermove", (e) => e.pointerId === id && move(e));
    const end = () => {
      id = null;
      knob.style.transform = "";
      host.sendInput({ type: "axis", axis: "moveX", value: 0 });
      host.sendInput({ type: "axis", axis: "moveY", value: 0 });
    };
    joy.addEventListener("pointerup", end);
    joy.addEventListener("pointercancel", end);
    this.el.querySelectorAll(".cf-btns button").forEach((b) => {
      const a = (b as HTMLElement).dataset.action!;
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        host.sendInput({ type: "action", action: a, down: true });
      });
      for (const ev of ["pointerup", "pointercancel", "pointerleave"]) b.addEventListener(ev, () => host.sendInput({ type: "action", action: a, down: false }));
    });
  }

  private syncResolutionSelect(): void {
    const res = this.el.querySelector(".cf-res") as HTMLSelectElement;
    res.value = `${this.o.host.width}x${this.o.host.height}`;
  }

  // ------------------------------------------------------------ sim editor panel
  private renderSide(): void {
    const { game } = this.o;
    const sheets = [...new Set(game.variables.map((v) => v.sheet))];
    if (!sheets.includes(this.sideSheet)) this.sideSheet = sheets[0];
    const defs = game.variables.filter((v) => v.sheet === this.sideSheet && !v.readOnly);
    this.sidePanel.innerHTML = `<h3>Simulation editor</h3><div class="tabs">${sheets.map((s) => `<button data-s="${s}" aria-pressed="${s === this.sideSheet}">${s}</button>`).join("")}</div>
      ${defs
        .map((d) => {
          const id = "sv-" + d.key.replace(/\W/g, "_");
          if (d.type === "enum") return `<div class="row"><label for="${id}">${esc(d.label)}</label><select id="${id}" data-k="${d.key}">${d.options!.map((o) => `<option>${esc(o)}</option>`).join("")}</select></div>`;
          if (d.type === "bool") return `<div class="row"><label for="${id}">${esc(d.label)} <input id="${id}" type="checkbox" data-k="${d.key}"></label></div>`;
          if (d.type === "text") return "";
          const max = d.max !== undefined && d.max < 1e6 ? d.max : Math.max(10, Number(d.default) * 4);
          const step = d.type === "int" ? 1 : (max - (d.min ?? 0)) / 200;
          return `<div class="row"><label for="${id}">${esc(d.label)} <b data-v="${d.key}"></b></label><input id="${id}" type="range" min="${d.min ?? 0}" max="${max}" step="${step}" data-k="${d.key}"></div>`;
        })
        .join("")}
      <p style="font-size:11.5px;color:#6b7280">Every control writes the same cell you can edit on the ${this.sideSheet} sheet. Rules on the RULES sheet recompute from these values.</p>`;
    this.sidePanel.querySelectorAll(".tabs button").forEach((b) =>
      b.addEventListener("click", () => {
        this.sideSheet = (b as HTMLElement).dataset.s!;
        this.renderSide();
      }),
    );
    this.sidePanel.querySelectorAll("[data-k]").forEach((el) => {
      const k = (el as HTMLElement).dataset.k!;
      const ev = (el as HTMLInputElement).type === "range" ? "input" : "change";
      el.addEventListener(ev, () => {
        const inp = el as HTMLInputElement;
        const v = inp.type === "checkbox" ? inp.checked : inp.value;
        const errs = this.o.host.applyPatch({ [k]: v as string | boolean });
        if (errs[k]) this.status(errs[k], true);
        this.refreshSideValues(k);
      });
    });
    this.refreshSideValues();
  }

  private refreshSideValues(skip?: string): void {
    this.lastSideRefresh = performance.now();
    const reg = this.o.host.registry;
    this.sidePanel.querySelectorAll("[data-k]").forEach((el) => {
      const k = (el as HTMLElement).dataset.k!;
      const v = reg.get(k);
      const inp = el as HTMLInputElement;
      if (k !== skip && document.activeElement !== inp) {
        if (inp.type === "checkbox") inp.checked = !!v;
        else inp.value = String(v);
      }
      const b = this.sidePanel.querySelector(`[data-v="${k}"]`);
      if (b) b.textContent = typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v);
    });
  }

  // ------------------------------------------------------------ dialogs
  private modal(html: string): HTMLDivElement {
    const m = this.el.querySelector(".cf-modal") as HTMLDivElement;
    (m.querySelector(".box") as HTMLDivElement).innerHTML = html;
    m.classList.add("open");
    const close = () => m.classList.remove("open");
    m.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
    m.onclick = (e) => e.target === m && close();
    return m;
  }

  private showHelp(): void {
    const { game } = this.o;
    this.modal(`<h2>${esc(game.title)} - controls</h2><table>${game.controls.map(([k, d]) => `<tr><td>${esc(k)}</td><td>${esc(d)}</td></tr>`).join("")}</table>
      <p style="font-size:12px;color:#4b5563">Esc switches between playing and selecting cells. Click any GAME cell to see its address, palette index and colour in the formula bar. Edit values on the variable sheets or formulas on RULES; changes apply immediately.</p>
      <div class="btns"><button class="primary" data-close>Close</button></div>`);
  }

  private showBridge(): void {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    const m = this.modal(`<h2>Native spreadsheet bridge</h2>
      <p style="font-size:12.5px">Streams GAME frames (palette-indexed dirty runs) to a local bridge that writes real worksheet cells in Excel or LibreOffice Calc, and syncs edits back. Start the bridge first: <code>python -m sgs_bridge --sink excel-xlwings</code>.</p>
      ${local ? "" : `<p style="font-size:12.5px;color:#c62828">This page is hosted, so the browser blocks connections to your computer. Run the local build (<code>npm run serve</code>) to use the bridge.</p>`}
      <label style="font-size:12px">Bridge URL</label><input class="cf-burl" value="${DEFAULT_BRIDGE_URL}">
      <p class="cf-bstat" style="font-size:12px;color:#374151">${this.bridge ? "Connected: " + esc(this.bridge.url) : "Not connected"}</p>
      <div class="btns"><button data-close>Close</button>${this.bridge ? `<button class="cf-bdis">Disconnect</button>` : ""}<button class="primary cf-bcon">Connect</button></div>`);
    m.querySelector(".cf-bcon")?.addEventListener("click", () => this.connectBridge((m.querySelector(".cf-burl") as HTMLInputElement).value));
    m.querySelector(".cf-bdis")?.addEventListener("click", async () => {
      await this.o.host.removeBackend("excel-bridge");
      this.bridge = null;
      m.classList.remove("open");
      this.status("Bridge disconnected");
    });
  }

  async connectBridge(url: string): Promise<void> {
    const { host, game } = this.o;
    if (this.bridge) await host.removeBackend("excel-bridge");
    host.pipeline.quantizer.setOptions({ mode: "fixed64" });
    (this.el.querySelector(".cf-pal") as HTMLSelectElement).value = "fixed64";
    const b = new ExcelBridgeBackend({
      url,
      manifest: () => ({ game: game.id, title: game.title, variables: game.variables, rules: host.registry.ruleDefs(), sheets: game.customSheets.map((s) => ({ name: s.name, columns: s.columns })), controls: game.controls, paletteMode: "fixed64", keyBindings: game.keyBindings, origin: GAME_ORIGIN }),
      hud: () => game.hud(),
      sheets: () => game.customSheets.map((s) => ({ name: s.name, columns: s.columns, rows: s.rows() })),
      telemetry: () => {
        const t = host.telemetry();
        return { gameFps: t.gameFps, sheetFps: t.sheetFps, changedCells: t.changedCells, frameLatencyMs: +t.frameLatencyMs.toFixed(2), entities: t.entities, resolution: t.resolution };
      },
      onConnection: (c) => this.status(c ? `Bridge connected (${url})` : "Bridge offline - retrying", !c),
      onError: (e) => this.status("Bridge: " + e, true),
    });
    this.bridge = b;
    await host.addBackend(b);
    (this.el.querySelector(".cf-modal") as HTMLDivElement).classList.remove("open");
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export { columnName };
