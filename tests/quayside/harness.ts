import sharp from "sharp";
import { InputState } from "../../engines/core/input";
import { VariableRegistry } from "../../engines/core/variables";
import { Raster } from "../../examples/quayside/src/map";
import { RULES, VARIABLES } from "../../examples/quayside/src/config";
import { World } from "../../examples/quayside/src/sim/world";

let cached: Raster | null = null;
export async function loadRaster(): Promise<Raster> {
  if (cached) return cached;
  const { data, info } = await sharp("examples/quayside/data/ground.png").raw().toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(info.width * info.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * info.channels];
  return (cached = new Raster(info.width, info.height, out));
}

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function makeWorld(seed = 1) {
  const reg = new VariableRegistry().define(VARIABLES).defineRules(RULES);
  const input = new InputState();
  const w = new World(await loadRaster(), reg, mulberry(seed));
  const step = (secs: number, hold: string[] = [], press: string[] = []) => {
    for (const a of hold) input.apply({ type: "action", action: a, down: true });
    for (const a of press) input.apply({ type: "action", action: a, down: true });
    const n = Math.round(secs * 60);
    for (let i = 0; i < n; i++) {
      w.step(1 / 60, input);
      input.endFrame();
      if (i === 0) for (const a of press) input.apply({ type: "action", action: a, down: false });
    }
    for (const a of hold) input.apply({ type: "action", action: a, down: false });
  };
  return { w, reg, input, step };
}
