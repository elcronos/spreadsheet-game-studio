/**
 * Minimal SpreadsheetGame template: "Cell Catch" - move a paddle, catch falling
 * cells. Shows every contract hook with the smallest possible game:
 * variables on a sheet, a formula rule, a custom sheet, HUD, commands, and a
 * DOM-free renderer (raster2d) so tests run headless.
 *
 * Copy with: node scripts/new-game.mjs <id>   (rewrites cell-catch / Cell Catch)
 */
import type { CustomSheet, GameCommand, GameContext, HudState, SpreadsheetGame, TurnSupport } from "../../engines/core/game";
import type { InputState } from "../../engines/core/input";
import type { RuleDef, VariableDef, VariableRegistry } from "../../engines/core/variables";
import { CanvasPresenter, Surface, drawText, hasDom, present, rgb } from "../../engines/raster2d";

const W = 160, H = 90;

export const VARIABLES: VariableDef[] = [
  { key: "play.speed", sheet: "PLAYER", label: "Paddle speed", name: "PaddleSpeed", type: "number", default: 70, min: 10, max: 300, unit: "px/s", description: "How fast the paddle moves" },
  { key: "play.width", sheet: "PLAYER", label: "Paddle width", name: "PaddleWidth", type: "int", default: 24, min: 4, max: 120, unit: "px" },
  { key: "play.score", sheet: "PLAYER", label: "Score", name: "Score", type: "int", default: 0, min: 0, max: 1e6, live: true },
  { key: "world.gravity", sheet: "WORLD", label: "Fall speed", name: "FallSpeed", type: "number", default: 30, min: 1, max: 200, unit: "px/s" },
  { key: "world.level", sheet: "WORLD", label: "Level", name: "Level", type: "int", default: 1, min: 1, max: 50 },
];

export const RULES: RuleDef[] = [
  // Edit this on the RULES sheet and the game changes immediately.
  { name: "SpawnPerSecond", formula: "=0.6+Level*0.25", min: 0.05, max: 20, description: "Falling cells spawned per second" },
];

export class CellCatchGame implements SpreadsheetGame {
  readonly id = "cell-catch";
  readonly title = "Cell Catch";
  readonly tagline = "A minimal Spreadsheet Game Studio game";
  readonly fixedStep = 1 / 60;
  readonly variables = VARIABLES;
  readonly rules = RULES;
  readonly keyBindings = { ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right" };
  readonly touchButtons = [];
  readonly controls: [string, string][] = [["← → / A D", "Move the paddle"]];
  readonly commands: GameCommand[] = [{ id: "reset", label: "Reset score" }];
  readonly customSheets: CustomSheet[] = [{ name: "LOG", columns: ["Event", "Time"], rows: () => this.log.map((l) => ({ cells: l })) }];

  /**
   * Turn support: lets scripts/gsheets-port.mjs build a turn-based Google Sheets edition
   * (tap a box, the game advances a little). save/load cover the simulation state.
   */
  readonly turn: TurnSupport = {
    controls: [
      { id: "left", label: "←", action: "left", hold: 0.35, after: 0.15 },
      { id: "right", label: "→", action: "right", hold: 0.35, after: 0.15 },
      { id: "wait", label: "Wait", after: 0.5 },
      { id: "reset", label: "Reset", command: "reset" },
    ],
    save: () => ({ x: this.x, drops: this.drops, spawnAcc: this.spawnAcc, t: this.t, log: this.log }),
    load: (s: unknown) => {
      const v = s as { x: number; drops: { x: number; y: number }[]; spawnAcc: number; t: number; log: [string, string][] };
      this.x = v.x;
      this.drops = v.drops;
      this.spawnAcc = v.spawnAcc;
      this.t = v.t;
      this.log = v.log;
    },
  };

  private reg!: VariableRegistry;
  private input!: InputState;
  private rand!: () => number;
  private x = W / 2;
  private drops: { x: number; y: number }[] = [];
  private spawnAcc = 0;
  private t = 0;
  private log: [string, string][] = [];
  private frame = new Surface(W, H);
  private presenter: CanvasPresenter | null = null;

  async init(ctx: GameContext): Promise<void> {
    this.reg = ctx.registry;
    this.input = ctx.input;
    this.rand = ctx.random;
    if (hasDom()) {
      this.presenter = new CanvasPresenter();
      this.presenter.canvas.style.cssText = "width:100%;height:100%;object-fit:contain";
      ctx.mount.appendChild(this.presenter.canvas);
    }
  }

  step(dt: number): void {
    this.t += dt;
    const sp = this.reg.num("play.speed");
    this.x = Math.max(0, Math.min(W, this.x + this.input.combined("left", "right") * sp * dt));
    this.spawnAcc += dt * this.reg.rule("SpawnPerSecond");
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      this.drops.push({ x: 4 + this.rand() * (W - 8), y: 0 });
    }
    const half = this.reg.num("play.width") / 2;
    for (const d of this.drops) d.y += this.reg.num("world.gravity") * dt;
    for (const d of [...this.drops]) {
      if (d.y >= H - 6 && Math.abs(d.x - this.x) <= half) {
        this.drops.splice(this.drops.indexOf(d), 1);
        this.reg.setLive("play.score", this.reg.num("play.score") + 1);
        this.log.unshift(["catch", this.t.toFixed(1)]);
        this.log.length = Math.min(this.log.length, 20);
      } else if (d.y > H) this.drops.splice(this.drops.indexOf(d), 1);
    }
  }

  private draw(): void {
    const s = this.frame;
    s.clear(rgb(24, 28, 48));
    for (const d of this.drops) s.fillRect(Math.round(d.x) - 1, Math.round(d.y) - 1, 3, 3, rgb(255, 210, 63));
    const half = this.reg.num("play.width") / 2;
    s.fillRect(Math.round(this.x - half), H - 5, Math.round(half * 2), 3, rgb(47, 214, 200));
    drawText(s, `SCORE ${this.reg.num("play.score")}`, 3, 3, rgb(255, 255, 255));
  }

  renderDirect(): void {
    if (!this.presenter) return;
    this.draw();
    const p = this.presenter.canvas.parentElement;
    this.presenter.present(this.frame, "fit", (p?.clientWidth ?? W * 6) * devicePixelRatio, (p?.clientHeight ?? H * 6) * devicePixelRatio);
  }

  renderCells(width: number, height: number, out: Uint8Array): void {
    this.draw();
    present(this.frame, width, height, out, { background: 0x181c30 });
  }

  canvas(): HTMLCanvasElement {
    if (!this.presenter) throw new Error("no DOM");
    return this.presenter.canvas;
  }

  hud(): HudState {
    return { stats: [["SCORE", String(this.reg.num("play.score"))], ["LEVEL", String(this.reg.num("world.level"))]], objective: "Catch the falling cells", meter: -1 };
  }

  runCommand(id: string): void {
    if (id === "reset") this.reg.edit("play.score", 0);
  }

  entityCount(): number {
    return this.drops.length + 1;
  }

  dispose(): void {
    this.presenter?.canvas.remove();
  }
}

export function createGame(): SpreadsheetGame {
  return new CellCatchGame();
}
