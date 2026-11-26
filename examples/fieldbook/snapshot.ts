/**
 * Renders Fieldbook screenshots (160x90 logical, upscaled x6) to
 * examples/fieldbook/screenshots/. Run:
 *   node --import tsx examples/fieldbook/snapshot.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InputState } from "../../engines/core/input";
import { VariableRegistry } from "../../engines/core/variables";
import { Surface, upscale, present } from "../../engines/raster2d";
import { FieldbookGame } from "./game";
import { encodePNG } from "./png";
import { FramePipeline } from "../../renderers/framebuffer/pipeline";
import { CHICKEN, CHICKEN_L, FARMER, cropSprite } from "./art";
import type { Dir } from "./sim";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "screenshots");
mkdirSync(OUT, { recursive: true });

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function makeGame(seed = 7) {
  const game = new FieldbookGame();
  const registry = new VariableRegistry().define(game.variables).defineRules(game.rules);
  const input = new InputState();
  let t = 0;
  await game.init({ registry, input, mount: {} as HTMLElement, random: mulberry32(seed), time: () => t });
  const step = (n: number) => {
    for (let i = 0; i < n; i++) {
      game.step(game.fixedStep);
      input.endFrame();
      t += game.fixedStep;
    }
  };
  return { game, registry, input, step, sim: game.sim };
}

function save(name: string, game: FieldbookGame, scale = 6): void {
  const buf = new Uint8Array(160 * 90 * 4);
  game.renderCells(160, 90, buf);
  const big = upscale(new Surface(160, 90, buf), scale);
  writeFileSync(join(OUT, `${name}.png`), encodePNG(big.width, big.height, big.data));
  console.log(`wrote ${name}.png (${new Surface(160, 90, buf).distinctColors()} colours)`);
}

function saveAt(name: string, game: FieldbookGame, w: number, h: number, show: number): void {
  const buf = new Uint8Array(w * h * 4);
  game.renderCells(w, h, buf);
  const s = new Surface(w, h, buf);
  const big = new Surface(w * show, h * show);
  present(s, big.width, big.height, big.data, { scaling: "integer" });
  writeFileSync(join(OUT, `${name}.png`), encodePNG(big.width, big.height, big.data));
  console.log(`wrote ${name}.png (${w}x${h}, ${s.distinctColors()} colours)`);
}

function walkPose(sim: FieldbookGame["sim"], tx: number, ty: number, dir: Dir, walkT = 0): void {
  sim.teleport(tx, ty, dir);
  sim.farmer.moving = walkT > 0;
  sim.farmer.walkT = walkT;
}

function stageField(g: Awaited<ReturnType<typeof makeGame>>, kind: "spring" | "summer" | "autumn"): void {
  const sim = g.sim;
  const rows: [number, Parameters<typeof sim.stagePlot>[2], number[]][] =
    kind === "spring"
      ? [[8, "carrot", [1, 1, 1, 1, 0.7, 0.4]], [9, "cabbage", [0.8, 0.8, 0.6, 0.3, 0.3]], [10, "carrot", [0.35, 0.35, 0, 0]], [11, null, [0, 0, 0]]]
      : kind === "summer"
        ? [[8, "tomato", [1, 1, 1, 0.7, 0.7]], [9, "tomato", [0.5, 0.5, 0.3, 0.3]], [10, "carrot", [1, 1, 0.6, 0.3, 0]], [11, null, [0, 0]]]
        : [[8, "pumpkin", [1, 1, 1, 0.8, 0.5]], [9, "pumpkin", [0.7, 0.5, 0.35]], [10, "carrot", [1, 1, 0.5, 0.3]], [11, null, [0, 0, 0]]];
  for (const [ty, crop, growth] of rows)
    growth.forEach((gr, i) => sim.stagePlot(3 + i, ty, crop, gr, i % 2 === 0 || kind === "summer"));
  sim.stagePlot(9, 12, "carrot", 0.5, false, true);
}

async function main() {
  // 1. Spring day in the field
  {
    const g = await makeGame(11);
    stageField(g, "spring");
    g.registry.setLive("farm.hour", 9.3);
    g.registry.setLive("farm.day", 3);
    g.sim.banner.t = 0;
    g.step(40);
    walkPose(g.sim, 7, 11, "right", 0.2);
    g.sim.farmer.tool = 1;
    g.sim.hint = g.sim.computeHint();
    save("day", g.game);
  }
  // 2. Evening at the cottage
  {
    const g = await makeGame(12);
    stageField(g, "spring");
    g.registry.setLive("farm.hour", 19.4);
    g.registry.setLive("farm.day", 4);
    g.step(30);
    g.sim.banner.t = 0;
    walkPose(g.sim, 6, 6, "left", 0.3);
    g.sim.hint = g.sim.computeHint();
    save("evening", g.game);
  }
  // 3. Summer night with fireflies
  {
    const g = await makeGame(13);
    g.registry.edit("farm.season", "Summer");
    stageField(g, "summer");
    g.registry.setLive("farm.hour", 22.6);
    g.registry.setLive("farm.day", 10);
    g.step(30);
    g.sim.banner.t = 0;
    walkPose(g.sim, 15, 10, "down");
    g.sim.hint = g.sim.computeHint();
    save("night", g.game);
  }
  // 4. Summer rain
  {
    const g = await makeGame(14);
    g.registry.edit("farm.season", "Summer");
    stageField(g, "summer");
    g.registry.edit("farm.weather", "Rain");
    g.registry.setLive("farm.hour", 11);
    g.step(45);
    g.sim.banner.t = 0;
    walkPose(g.sim, 5, 12, "up", 0);
    g.sim.farmer.tool = 0;
    g.sim.hint = g.sim.computeHint();
    save("rain", g.game);
  }
  // 5. Autumn market: selling a basket
  {
    const g = await makeGame(15);
    g.registry.edit("farm.season", "Autumn");
    stageField(g, "autumn");
    g.registry.setLive("farm.hour", 15.2);
    g.registry.setLive("farmer.cash", 312);
    g.registry.edit("farmer.basket.pumpkin", 3);
    g.registry.edit("farmer.basket.carrot", 6);
    g.registry.edit("farmer.basket.egg", 4);
    walkPose(g.sim, 10, 18, "up");
    g.step(2);
    g.sim.sellAll();
    g.step(9);
    g.sim.hint = g.sim.computeHint();
    save("market", g.game);
  }
  // 6. Winter snow
  {
    const g = await makeGame(16);
    g.registry.edit("farm.season", "Winter");
    g.sim.stagePlot(3, 8, "cabbage", 1, true);
    g.sim.stagePlot(4, 8, "cabbage", 1, true);
    g.sim.stagePlot(5, 8, "cabbage", 0.6, true);
    g.sim.stagePlot(3, 9, "cabbage", 0.3, true);
    g.registry.edit("farm.weather", "Rain");
    g.registry.setLive("farm.hour", 16.8);
    g.step(40);
    g.sim.banner.t = 0;
    walkPose(g.sim, 16, 9, "left", 0.1);
    g.sim.hint = g.sim.computeHint();
    save("winter", g.game);
  }
  // 7. Morning at the shed and chicken pen
  {
    const g = await makeGame(17);
    g.registry.setLive("farm.hour", 7.6);
    g.registry.edit("farm.chickens", 5);
    g.step(200);
    g.sim.eggs.push([26, 12], [27, 10]);
    g.sim.banner.t = 0;
    walkPose(g.sim, 25, 6, "up", 0.45);
    g.sim.hint = g.sim.computeHint();
    save("pen", g.game);
  }
  // Sprite sheet: farmer walk cycles (4 directions), chickens, crops by stage, icons
  {
    const sheet = new Surface(112, 64);
    sheet.clear(0x6fb04a);
    const dirs = ["down", "up", "left", "right"] as const;
    dirs.forEach((d, row) => FARMER[d].walk.concat([FARMER[d].stand]).forEach((sp, i) => sheet.blit(sp, 2 + i * 11, 2 + row * 15)));
    [CHICKEN.a, CHICKEN.b, CHICKEN.peck, CHICKEN_L.a].forEach((sp, i) => sheet.blit(sp, 60 + i * 12, 2));
    (["carrot", "tomato", "pumpkin", "cabbage"] as const).forEach((c, row) => {
      for (let st = 0; st < 4; st++) sheet.blit(cropSprite(c, st, false), 58 + st * 10, 16 + row * 12 + (12 - cropSprite(c, st, false).h));
    });
    sheet.blit(cropSprite("carrot", 0, true), 100, 16);
    const big = upscale(sheet, 6);
    writeFileSync(join(OUT, "sprites.png"), encodePNG(big.width, big.height, big.data));
    console.log("wrote sprites.png");
  }
  // Same scene at the three standard cell resolutions
  {
    const g = await makeGame(11);
    stageField(g, "spring");
    g.registry.setLive("farm.hour", 10);
    g.step(40);
    g.sim.banner.t = 0;
    walkPose(g.sim, 7, 11, "down");
    g.sim.hint = g.sim.computeHint();
    saveAt("cells-80x45", g.game, 80, 45, 12);
    saveAt("cells-160x90", g.game, 160, 90, 6);
    saveAt("cells-320x180", g.game, 320, 180, 3);
    // what native Excel sees: the same frame through the shared FramePipeline's fixed 64-colour palette
    const pipe = new FramePipeline(160, 90, { mode: "fixed64", dither: false, hysteresis: 0 });
    const rgba = new Uint8Array(160 * 90 * 4);
    g.game.renderCells(160, 90, rgba);
    const { frame } = pipe.process(rgba);
    const q = new Surface(160, 90);
    for (let i = 0; i < 160 * 90; i++) {
      const c = frame.palette[frame.indices[i]];
      q.data.set([(c >> 16) & 255, (c >> 8) & 255, c & 255, 255], i * 4);
    }
    const big = upscale(q, 6);
    writeFileSync(join(OUT, "cells-160x90-fixed64.png"), encodePNG(big.width, big.height, big.data));
    console.log(`wrote cells-160x90-fixed64.png (${q.distinctColors()} palette colours used)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
