/**
 * Fieldbook - a top-down farming & market simulator on the SpreadsheetGame
 * contract. The simulation is FarmSim (sim.ts), the art is drawn by the
 * raster2d engine (render.ts), and this file wires both to the host.
 */
import type { CustomSheet, GameCommand, GameContext, HudState, SheetRow, SpreadsheetGame } from "../../engines/core/game";
import type { InputState } from "../../engines/core/input";
import { CanvasPresenter, Surface, hasDom, present } from "../../engines/raster2d";
import { CONTROLS, CROPS, KEY_BINDINGS, RULES, TOUCH_BUTTONS, VARIABLES } from "./defs";
import { LOGICAL_H, LOGICAL_W, renderScene } from "./render";
import { FarmSim, ITEM_NAME } from "./sim";

export class FieldbookGame implements SpreadsheetGame {
  readonly id = "fieldbook";
  readonly title = "Fieldbook";
  readonly tagline = "Till, plant, water, and play the market - prices are spreadsheet formulas.";
  readonly fixedStep = 1 / 30;
  readonly variables = VARIABLES;
  readonly rules = RULES;
  readonly keyBindings = KEY_BINDINGS;
  readonly touchButtons = TOUCH_BUTTONS;
  readonly controls = CONTROLS;
  readonly commands: GameCommand[] = [
    { id: "new-game", label: "New game" },
    { id: "skip-day", label: "Sleep / skip to next day" },
  ];
  readonly customSheets: CustomSheet[];

  /** The simulation; public for tests, screenshots and tooling. */
  sim!: FarmSim;
  private input!: InputState;
  private frame = new Surface(LOGICAL_W, LOGICAL_H);
  private presenter: CanvasPresenter | null = null;

  constructor() {
    this.customSheets = [
      {
        name: "ORDERS",
        columns: ["Order", "Item", "Qty", "Delivered", "Due day", "Reward", "Status"],
        rows: (): SheetRow[] =>
          (this.sim?.orders ?? []).map((o) => ({
            cells: [`#${o.id}`, ITEM_NAME[o.item], o.qty, o.delivered, o.due, o.reward, o.status],
            style: o.status === "DONE" ? "done" : o.status === "LATE" ? "failed" : o.due - this.sim.day <= 1 ? "active" : undefined,
          })),
      },
      {
        name: "FIELD",
        columns: ["Plot", "Crop", "Stage", "Growth", "Days", "Watered", "Dry days"],
        rows: (): SheetRow[] => {
          if (!this.sim) return [];
          const out: SheetRow[] = [];
          for (let ty = 0; ty < 20; ty++)
            for (let tx = 0; tx < 32; tx++) {
              const p = this.sim.plot(tx, ty);
              if (!p || !p.tilled) continue;
              const stage = p.withered ? "Withered" : !p.crop ? "Tilled" : ["Seeded", "Sprout", "Growing", "Ripe"][this.sim.stage(p)];
              out.push({
                cells: [`${tx},${ty}`, p.crop ? CROPS[p.crop].name : "-", stage, Math.round(p.growth * 100) / 100, p.crop ? CROPS[p.crop].days : 0, p.watered ? "Yes" : "No", p.dry],
                style: p.withered ? "failed" : this.sim.isRipe(p) ? "done" : p.crop ? "active" : "muted",
              });
            }
          return out;
        },
      },
    ];
  }

  async init(ctx: GameContext): Promise<void> {
    this.input = ctx.input;
    this.sim = new FarmSim(ctx.registry, ctx.random);
    if (hasDom()) {
      this.presenter = new CanvasPresenter();
      this.presenter.canvas.className = "fieldbook-canvas";
      this.presenter.canvas.style.width = "100%";
      this.presenter.canvas.style.height = "100%";
      this.presenter.canvas.style.objectFit = "contain";
      if (ctx.mount && typeof ctx.mount.appendChild === "function") ctx.mount.appendChild(this.presenter.canvas);
    }
  }

  step(dt: number): void {
    this.sim.step(dt, this.input);
  }

  renderDirect(_alpha: number, width: number, height: number): void {
    if (!this.presenter) return;
    renderScene(this.sim, this.frame);
    const parent = this.presenter.canvas.parentElement;
    const w = width || parent?.clientWidth || LOGICAL_W * 6;
    const h = height || parent?.clientHeight || LOGICAL_H * 6;
    this.presenter.present(this.frame, "fit", w * (globalThis.devicePixelRatio || 1), h * (globalThis.devicePixelRatio || 1));
  }

  renderCells(width: number, height: number, out: Uint8Array): void {
    renderScene(this.sim, this.frame, { compact: width < LOGICAL_W * 0.75 || height < LOGICAL_H * 0.75 });
    present(this.frame, width, height, out, { background: 0x1a1410 });
  }

  /** The 160x90 logical frame from the last render (screenshots/tests). */
  logicalFrame(): Surface {
    return this.frame;
  }

  canvas(): HTMLCanvasElement {
    if (!this.presenter) throw new Error("Fieldbook.canvas(): no DOM in this environment (renderCells works headless)");
    return this.presenter.canvas;
  }

  hud(): HudState {
    const s = this.sim;
    const n = (k: string) => s.reg.num(k);
    const h = s.hour;
    const hh = Math.floor(h) % 24, mm = Math.floor((h % 1) * 6) * 10;
    const seed = s.farmer.seed;
    const tool = s.tool === "SEEDS" ? `SEEDS (${ITEM_NAME[seed]} x${n(`farmer.seeds.${seed}`)})` : s.tool;
    const open = s.orders.find((o) => o.status === "OPEN");
    return {
      stats: [
        ["DAY", String(s.day)],
        ["SEASON", s.season],
        ["TIME", `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`],
        ["WEATHER", s.raining ? (s.season === "Winter" ? "Snow" : "Rain") : "Sunny"],
        ["CASH", `$${Math.floor(n("farmer.cash")).toLocaleString("en-US")}`],
        ["STAMINA", `${Math.round(n("farmer.stamina"))}/${Math.round(n("farmer.maxStamina"))}`],
        ["TOOL", tool],
        ["CAN", `${n("farmer.canWater")}/${n("farmer.canCapacity")}`],
        ["BASKET", String(s.basketCount())],
      ],
      objective: open ? `Order #${open.id}: deliver ${open.qty - open.delivered} ${ITEM_NAME[open.item]} by day ${open.due} ($${open.reward})` : "Grow, harvest and sell at the market stall",
      banner: s.banner.t > 0 ? s.banner.text : undefined,
      hint: s.hint || undefined,
      meter: -1,
    };
  }

  runCommand(id: string): void {
    if (id === "new-game") this.sim.reset();
    else if (id === "skip-day") this.sim.sleep(false);
  }

  entityCount(): number {
    return 1 + this.sim.chickens.length + this.sim.eggs.length + this.sim.particles.count + this.sim.plots.filter((p) => p.crop).length;
  }

  dispose(): void {
    this.presenter?.canvas.remove();
    this.presenter = null;
  }
}

export function createFieldbook(): SpreadsheetGame {
  return new FieldbookGame();
}

export default createFieldbook;
