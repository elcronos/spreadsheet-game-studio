/**
 * Headless driver for Fieldbook tests: a registry + input + stub mount, a
 * fixed-step loop, and a scripted "player" that walks by holding direction
 * actions (BFS over the tile map), exactly as a keyboard would.
 */
import { InputState } from "../../engines/core/input";
import { VariableRegistry } from "../../engines/core/variables";
import { FieldbookGame } from "../../examples/fieldbook/game";
import { isSolidTile } from "../../examples/fieldbook/map";
import type { Dir } from "../../examples/fieldbook/sim";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Harness {
  game: FieldbookGame;
  registry: VariableRegistry;
  input: InputState;
  steps: number;
  step(n?: number): void;
  press(action: string): void;
  hold(action: string, n: number): void;
  face(dir: Dir): void;
  walkTo(tx: number, ty: number): void;
  cash(): number;
}

export async function makeHarness(seed = 1, tune: Record<string, number | string> = {}): Promise<Harness> {
  const game = new FieldbookGame();
  const registry = new VariableRegistry().define(game.variables).defineRules(game.rules);
  const input = new InputState();
  let simTime = 0;
  await game.init({ registry, input, mount: {} as HTMLElement, random: mulberry32(seed), time: () => simTime });
  for (const [k, v] of Object.entries(tune)) {
    const r = registry.edit(k, v);
    if (!r.ok) throw new Error(`tune ${k}: ${r.error}`);
  }
  const h: Harness = {
    game,
    registry,
    input,
    steps: 0,
    step(n = 1) {
      for (let i = 0; i < n; i++) {
        game.step(game.fixedStep);
        input.endFrame();
        simTime += game.fixedStep;
        h.steps++;
      }
    },
    press(action) {
      input.apply({ type: "action", action, down: true });
      h.step();
      input.apply({ type: "action", action, down: false });
      h.step();
    },
    hold(action, n) {
      input.apply({ type: "action", action, down: true });
      h.step(n);
      input.apply({ type: "action", action, down: false });
    },
    face(dir) {
      // one frame of the direction turns the farmer; the nudge (< 1.5px) never leaves the tile
      h.hold(dir, 1);
      h.step();
    },
    walkTo(tx, ty) {
      const sim = game.sim;
      const [sx, sy] = sim.farmerTile();
      const path = bfs(game, sx, sy, tx, ty);
      if (!path) throw new Error(`no path ${sx},${sy} -> ${tx},${ty}`);
      const tol = (registry.num("farmer.walkSpeed") * 8 * game.fixedStep) / 2 + 0.05;
      const goAxis = (axis: "x" | "y", target: number) => {
        for (let guard = 0; guard < 600; guard++) {
          const d = target - sim.farmer[axis];
          if (Math.abs(d) <= tol) return;
          const a = axis === "x" ? (d < 0 ? "left" : "right") : d < 0 ? "up" : "down";
          input.apply({ type: "action", action: a, down: true });
          h.step();
          input.apply({ type: "action", action: a, down: false });
        }
        throw new Error(`stuck walking ${axis} to ${target} at ${sim.farmer.x},${sim.farmer.y}`);
      };
      for (const [px, py] of path) {
        const [cx, cy] = sim.farmerTile();
        if (px !== cx) {
          goAxis("y", cy * 8 + 6);
          goAxis("x", px * 8 + 4);
        } else {
          goAxis("x", cx * 8 + 4);
          goAxis("y", py * 8 + 6);
        }
      }
      h.step();
      const [fx, fy] = sim.farmerTile();
      if (fx !== tx || fy !== ty) throw new Error(`walkTo ended at ${fx},${fy} not ${tx},${ty}`);
    },
    cash() {
      return registry.num("farmer.cash");
    },
  };
  return h;
}

function bfs(game: FieldbookGame, sx: number, sy: number, tx: number, ty: number): [number, number][] | null {
  const map = game.sim.map;
  const key = (x: number, y: number) => y * 64 + x;
  const prev = new Map<number, number>();
  const q: [number, number][] = [[sx, sy]];
  prev.set(key(sx, sy), -1);
  while (q.length) {
    const [x, y] = q.shift()!;
    if (x === tx && y === ty) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (prev.has(key(nx, ny)) || isSolidTile(map, nx, ny)) continue;
      prev.set(key(nx, ny), key(x, y));
      q.push([nx, ny]);
    }
  }
  if (!prev.has(key(tx, ty))) return null;
  const out: [number, number][] = [];
  for (let k = key(tx, ty); k !== key(sx, sy); k = prev.get(k)!) out.unshift([k % 64, Math.floor(k / 64)]);
  return out;
}

/** Stand on (tx, ty+1) facing up, i.e. target the plot at (tx, ty). */
export function approachFromBelow(h: Harness, tx: number, ty: number): void {
  h.walkTo(tx, ty + 1);
  h.face("up");
  const [ax, ay] = h.game.sim.targetTile();
  if (ax !== tx || ay !== ty) throw new Error(`targeting ${ax},${ay} not ${tx},${ty}`);
}

export function selectTool(h: Harness, tool: "HOE" | "CAN" | "SEEDS"): void {
  for (let i = 0; i < 3 && h.game.sim.tool !== tool; i++) h.press("tool");
  if (h.game.sim.tool !== tool) throw new Error(`could not select ${tool}`);
}

/** Walk to the stall front and press E. Returns cash gained. */
export function sellAtStall(h: Harness): number {
  h.walkTo(10, 18);
  h.face("up");
  const before = h.cash();
  h.press("use");
  return h.cash() - before;
}
