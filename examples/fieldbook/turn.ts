/**
 * Fieldbook's session for the turn-based Google Sheets port
 * (renderers/gsheets/turn). It is smarter than the generic one: a tap walks
 * exactly one tile, the first tap on a new direction only turns the farmer,
 * the view only scrolls near its edge and daylight changes in half-hour steps,
 * so a typical tap repaints a few hundred of the 14,400 cells.
 */
import { InputState } from "../../engines/core/input";
import { VariableRegistry } from "../../engines/core/variables";
import type { TurnControl } from "../../engines/core/game";
import { Surface } from "../../engines/raster2d";
import { FieldbookGame } from "./game";
import type { FarmSim } from "./sim";
import { LOGICAL_H, LOGICAL_W, camera, renderScene } from "./render";
import { MAP_COLS, MAP_ROWS, TILE } from "./map";
import { SavedBase, TurnApp, TurnSessionLike, packFrame, registrySnapshot, restoreRegistry, rgbaToHex, savableRng, unpackFrame } from "../../renderers/gsheets/turn/kit";

/** One cell per game pixel: the art is drawn at 160x90, so nothing is averaged away. */
export const W = LOGICAL_W;
export const H = LOGICAL_H;
export const STEP = 1 / 30;
/** Game seconds that "Wait" skips: one in-game hour at the default day length. */
export const WAIT_SECONDS = 7.5;
export const LAYOUT = `fieldbook-${LOGICAL_W}x${LOGICAL_H}-v4`;
/** The view only scrolls when the farmer gets this close (px) to its edge. */
const EDGE_X = 40;
const EDGE_Y = 24;
const ARROW = { left: "←", right: "→", up: "↑", down: "↓" } as const;

export type Action = "left" | "right" | "up" | "down" | "use" | "tool" | "seed" | "wait" | "sleep" | "new";
export const CONTROLS: TurnControl[] = [
  { id: "left", label: "←" },
  { id: "up", label: "↑" },
  { id: "down", label: "↓" },
  { id: "right", label: "→" },
  { id: "use", label: "Use" },
  { id: "tool", label: "Tool" },
  { id: "seed", label: "Seed" },
  { id: "wait", label: "Wait" },
  { id: "sleep", label: "Sleep" },
  { id: "new", label: "New" },
];

/** Simulation fields that are rebuilt from scratch instead of being saved. */
const SKIP = new Set(["reg", "rng", "map", "particles"]);

export type Saved = SavedBase;

export class Session implements TurnSessionLike {
  readonly game = new FieldbookGame();
  readonly registry: VariableRegistry;
  readonly input = new InputState();
  private rng = savableRng();
  message = "";
  steps = 1;
  frame: string[] = [];
  written: Record<string, string> = {};
  turns = 0;
  cam: [number, number] | null = null;
  private surface = new Surface(W, H);

  constructor(saved?: Saved | null) {
    this.registry = new VariableRegistry().define(this.game.variables).defineRules(this.game.rules);
    // init() is async in signature but assigns the sim synchronously
    void this.game.init({ registry: this.registry, input: this.input, mount: {} as HTMLElement, random: this.rng.next, time: () => 0 });
    if (saved) this.restore(saved);
  }

  get sim(): FarmSim {
    return this.game.sim;
  }

  private restore(s: Saved): void {
    restoreRegistry(this.registry, s);
    const g = (s.game ?? {}) as { sim?: Record<string, unknown>; cam?: [number, number] };
    Object.assign(this.sim, JSON.parse(JSON.stringify(g.sim ?? {})));
    this.sim.groundVersion++;
    this.registry.recomputeRules();
    this.rng.state.a = s.rng >>> 0;
    this.steps = s.steps || 1;
    this.frame = unpackFrame(s.frame);
    this.written = s.written ?? {};
    this.turns = s.turns ?? 0;
    this.cam = g.cam ?? null;
  }

  save(): Saved {
    const sim: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.sim)) if (!SKIP.has(k) && typeof v !== "function") sim[k] = v;
    return { v: 1, layout: LAYOUT, rng: this.rng.state.a, ...registrySnapshot(this.registry), steps: this.steps, frame: packFrame(this.frame), written: this.written, turns: this.turns, game: JSON.parse(JSON.stringify({ sim, cam: this.cam })) };
  }

  private tick(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.game.step(STEP);
      this.input.endFrame();
    }
  }
  private press(action: string): void {
    this.input.apply({ type: "action", action, down: true });
    this.tick();
    this.input.apply({ type: "action", action, down: false });
  }
  private settle(maxSeconds = 1): void {
    const f = this.sim.farmer;
    for (let i = 0; i < maxSeconds / STEP && f.actionT > 0; i++) this.tick();
  }

  /** Walk one tile; facing a wall still turns the farmer (needed to use the tile ahead). */
  private walk(dir: "left" | "right" | "up" | "down"): boolean {
    const f = this.sim.farmer;
    const [tx0, ty0] = this.sim.farmerTile();
    const x0 = f.x, y0 = f.y;
    this.input.apply({ type: "action", action: dir, down: true });
    let moved = false;
    for (let i = 0; i < 0.8 / STEP; i++) {
      this.tick();
      const [tx, ty] = this.sim.farmerTile();
      if (tx !== tx0 || ty !== ty0) {
        moved = true;
        // snap to the tile's standing spot (same anchor as the spawn) so every tap is exactly one tile
        const ax = tx * 8 + 4, ay = ty * 8 + 6;
        if (!this.sim.boxBlocked(ax, ay)) {
          f.x = ax;
          f.y = ay;
        }
        break;
      }
      if (i > 3 && f.x === x0 && f.y === y0) break; // blocked
    }
    this.input.apply({ type: "action", action: dir, down: false });
    this.tick(2); // stop the walk cycle so the frame shows a standing farmer
    return moved;
  }

  play(id: string): void {
    const action = id as Action;
    this.message = "";
    const sim = this.sim;
    switch (action) {
      case "left":
      case "right":
      case "up":
      case "down": {
        // like many grid games, the first tap on a new direction only turns the farmer,
        // so you can face a plot, the well or the stall without stepping onto it
        if (sim.farmer.dir !== action) {
          sim.farmer.dir = action;
          this.tick(1);
          this.message = `Facing ${action}. Tap ${ARROW[action]} again to walk`;
          break;
        }
        let n = 0;
        for (let i = 0; i < this.steps; i++) {
          if (!this.walk(action)) break;
          n++;
        }
        if (n === 0) this.message = "Can't walk that way";
        break;
      }
      case "use":
        this.press("use");
        this.settle();
        break;
      case "tool":
        this.press("tool");
        break;
      case "seed":
        this.press("seednext");
        break;
      case "sleep": {
        const day = sim.day;
        this.press("sleep");
        this.tick(Math.round(0.6 / STEP));
        if (sim.day === day) this.message = "Go to your doorstep to sleep";
        break;
      }
      case "wait":
        this.tick(Math.round(WAIT_SECONDS / STEP));
        break;
      case "new":
        this.game.runCommand("new-game");
        this.cam = null;
        this.tick(2);
        break;
    }
    this.turns++;
  }

  /** Keep the view still until the farmer nears its edge, then re-centre (like flip-screen games). */
  private updateCamera(): [number, number] {
    const ideal = camera(this.sim);
    const f = this.sim.farmer;
    const c = this.cam;
    const maxX = MAP_COLS * TILE - W, maxY = MAP_ROWS * TILE - H + 8;
    if (!c || f.x - c[0] < EDGE_X || c[0] + W - f.x < EDGE_X || f.y - c[1] < EDGE_Y || c[1] + H - f.y < EDGE_Y / 2) this.cam = ideal;
    this.cam = [Math.max(0, Math.min(maxX, this.cam![0])), Math.max(-6, Math.min(maxY, this.cam![1]))];
    return this.cam;
  }

  /** Render the current state as W*H hex colours. */
  render(): string[] {
    const cam = this.updateCamera();
    // daylight is drawn in half-hour steps: a smoothly changing tint would repaint every cell on every tap
    const hour = this.sim.hour;
    this.registry.setLive("farm.hour", Math.floor(hour * 2) / 2);
    try {
      renderScene(this.sim, this.surface, { camera: cam });
    } finally {
      this.registry.setLive("farm.hour", hour);
    }
    return rgbaToHex(this.surface.data, W * H);
  }

  hudLines(): [string, string] {
    const h = this.game.hud();
    const get = (k: string) => h.stats.find(([a]) => a === k)?.[1] ?? "";
    const top = `Day ${get("DAY")} ${get("SEASON")} ${get("TIME")} · ${get("WEATHER")} · ${get("CASH")} · Stamina ${get("STAMINA")} · ${get("TOOL")} · Can ${get("CAN")} · Basket ${get("BASKET")}`;
    const msg = this.message || h.banner || h.hint || h.objective || "";
    return [top, msg];
  }
}


/** Fieldbook as a TurnApp for renderers/gsheets/turn/app.ts. */
export const fieldbookTurnApp: TurnApp = {
  layout: LAYOUT,
  title: "Fieldbook",
  width: W,
  height: H,
  cellPx: 4,
  controls: CONTROLS,
  stepOptions: ["x1", "x2", "x4"],
  intro: "Tap a box under ← ↑ ↓ → to walk. Use = hoe / water / plant / harvest / sell.",
  create: (saved) => new Session(saved),
};
export default fieldbookTurnApp;
