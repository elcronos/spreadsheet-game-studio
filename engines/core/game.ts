/**
 * The game contract. A game is a simulation plus a way to draw itself into an
 * RGBA buffer at cell resolution. It never knows which backends are active.
 */
import type { InputState, KeyBinding } from "./input";
import type { RuleDef, VariableDef, VariableRegistry } from "./variables";

export interface HudState {
  /** Short status cells shown beside the GAME range and in overlays, e.g. ["CASH", "$1,200"]. */
  stats: [string, string][];
  /** Current objective / prompt line. */
  objective: string;
  /** Transient centred message ("BUSTED", "CHECKPOINT 3/8"). */
  banner?: string;
  /** Context hint, e.g. "F  Enter vehicle". */
  hint?: string;
  /** 0..5 alert stars or similar meter; -1 hides it. */
  meter?: number;
}

export interface SheetRow {
  cells: (string | number)[];
  /** Optional style hint for the row. */
  style?: "header" | "active" | "done" | "failed" | "muted";
}

export interface CustomSheet {
  name: string;
  /** Column headings. */
  columns: string[];
  rows(): SheetRow[];
}

export interface TouchButton {
  action: string;
  label: string;
}

export interface GameContext {
  registry: VariableRegistry;
  input: InputState;
  /** Element the game may mount its conventional canvas into. */
  mount: HTMLElement;
  /** Seeded RNG for deterministic tests. */
  random: () => number;
  /** Elapsed simulation seconds. */
  time: () => number;
}

export interface GameCommand {
  id: string;
  label: string;
}

export interface SpreadsheetGame {
  readonly id: string;
  readonly title: string;
  readonly tagline: string;
  /** Fixed simulation step in seconds. */
  readonly fixedStep: number;
  readonly variables: VariableDef[];
  readonly rules: RuleDef[];
  readonly keyBindings: KeyBinding;
  readonly touchButtons: TouchButton[];
  /** Controls help: [keys, description]. */
  readonly controls: [string, string][];
  /** Extra worksheets (e.g. MISSIONS) beyond variable sheets. */
  readonly customSheets: CustomSheet[];
  /** Commands surfaced in the toolbar / ribbon (e.g. start mission). */
  readonly commands: GameCommand[];

  init(ctx: GameContext): Promise<void>;
  /** Advance simulation by fixedStep. */
  step(dt: number): void;
  /** Render the conventional view (called once per display frame). */
  renderDirect(alpha: number, width: number, height: number): void;
  /** Render at cell resolution and write top-down RGBA into `out` (w*h*4 bytes). */
  renderCells(width: number, height: number, out: Uint8Array): void;
  /** The conventional canvas element (for the 3D/2D backend). */
  canvas(): HTMLCanvasElement;
  hud(): HudState;
  runCommand(id: string): void;
  /** Counts for telemetry. */
  entityCount(): number;
  dispose(): void;
  /**
   * Optional: lets the turn-based Google Sheets port (renderers/gsheets/turn)
   * run the game one tap at a time, saving it between taps. Needs a DOM-free
   * renderCells (raster2d or similar), because Apps Script has no canvas or WebGL.
   */
  readonly turn?: TurnSupport;
}

/** A button on the GAME tab of the turn-based Google Sheets port. */
export interface TurnControl {
  id: string;
  /** Short label shown above the checkbox. Prefer plain text or arrows like ← ↑ ↓ →; some phones draw ◀ ▶ as emoji. */
  label: string;
  /** Input action to press (held for `hold` seconds; the first tick also counts as a press). */
  action?: string;
  hold?: number;
  /** Seconds of game time to run after the press (or alone, for a "Wait" button). */
  after?: number;
  /** Run a game command instead (e.g. "new-game"). */
  command?: string;
}

export interface TurnSupport {
  controls: TurnControl[];
  /** JSON-safe simulation state (the variable registry is saved separately). */
  save(): unknown;
  /** Restore what save() returned, after init(). */
  load(state: unknown): void;
}
