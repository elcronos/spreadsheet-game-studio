/**
 * Exports Fieldbook's art for the Excel (VBA) edition: the same renderer the browser
 * uses draws every season's background, each static object on its own (so VBA can
 * redraw it in front of the farmer), the sprites, the soil textures and the light
 * table. Output: examples/fieldbook/excel/assets.json (palette-coded strings).
 *
 *   npx tsx scripts/excel/export-fieldbook-assets.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { VariableRegistry } from "../../engines/core/variables";
import { Surface, TRANSPARENT, dayNightAmbient, hash2, type Sprite } from "../../engines/raster2d";
import { CHICKEN, CHICKEN_L, EGG, FARMER, ICONS, P, cropSprite, seedBag } from "../../examples/fieldbook/art";
import { CROP_IDS, RULES, SEASONS, VARIABLES, type Season } from "../../examples/fieldbook/defs";
import { BED_TILES, COOP_RECT, FIELD_RECT, MAP_COLS, MAP_ROWS, PEN_RECT, SPAWN, TILE, buildFarm, isSolidTile } from "../../examples/fieldbook/map";
import { renderScene } from "../../examples/fieldbook/render";
import { FarmSim } from "../../examples/fieldbook/sim";

export const W = MAP_COLS * TILE; // 256
export const TOP = 8; // rows of canopy above the map (trees on row 0 overhang)
export const H = MAP_ROWS * TILE + TOP; // 184

// ---- palette ----------------------------------------------------------------
const ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/";
const palette: number[] = [];
const palIndex = new Map<number, number>();
function code(c: number): string {
  if (c === TRANSPARENT) return "..";
  let i = palIndex.get(c);
  if (i === undefined) {
    i = palette.length;
    palette.push(c);
    palIndex.set(c, i);
    if (i >= 64 * 64) throw new Error("palette overflow");
  }
  return ALPHA[i >> 6] + ALPHA[i & 63];
}
const rgbOf = (s: Surface, x: number, y: number) => {
  const o = (y * s.width + x) * 4;
  return (s.data[o] << 16) | (s.data[o + 1] << 8) | s.data[o + 2];
};

function newSim(season: Season): FarmSim {
  const reg = new VariableRegistry().define(VARIABLES).defineRules(RULES);
  let seed = 7;
  const sim = new FarmSim(reg, () => ((seed = (seed * 16807) % 2147483647) / 2147483647));
  reg.setLive("farm.season", season);
  reg.setLive("farm.hour", 12);
  reg.setLive("farm.weather", "Sunny");
  for (const p of sim.plots) p.tilled = false;
  sim.groundVersion++;
  sim.hint = "";
  return sim;
}

function render(sim: FarmSim, filter?: (k: string) => boolean, out?: { key: string; y: number }[]): Surface {
  const s = new Surface(W, H);
  renderScene(sim, s, { bare: true, dynamic: false, camera: [0, -TOP], objectFilter: filter, objectsOut: out });
  return s;
}

const rows = (s: Surface): string[] => {
  const r: string[] = [];
  for (let y = 0; y < s.height; y++) {
    let line = "";
    for (let x = 0; x < s.width; x++) line += code(rgbOf(s, x, y));
    r.push(line);
  }
  return r;
};

interface Obj { key: string; base: number; x: number; y: number; w: number; h: number; px: string }

const seasons: Record<string, { bg: string[]; objects: Obj[] }> = {};
for (const season of SEASONS) {
  const sim = newSim(season);
  const keys: { key: string; y: number }[] = [];
  const full = render(sim, undefined, keys);
  const ground = render(sim, () => false);
  const objects: Obj[] = [];
  for (const { key, y } of keys) {
    const one = render(sim, (k) => k === key);
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let yy = 0; yy < H; yy++)
      for (let xx = 0; xx < W; xx++)
        if (rgbOf(one, xx, yy) !== rgbOf(ground, xx, yy)) {
          x0 = Math.min(x0, xx); y0 = Math.min(y0, yy); x1 = Math.max(x1, xx); y1 = Math.max(y1, yy);
        }
    if (x1 < 0) continue;
    let px = "";
    for (let yy = y0; yy <= y1; yy++)
      for (let xx = x0; xx <= x1; xx++) {
        const c = rgbOf(one, xx, yy);
        px += c === rgbOf(ground, xx, yy) ? ".." : code(c);
      }
    // canvas coordinates (world y + TOP); base is the y-sort line in canvas rows
    objects.push({ key, base: y + TOP, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, px });
  }
  seasons[season] = { bg: rows(full), objects };
}

// ---- sprites ----------------------------------------------------------------
const sprites: Record<string, { w: number; h: number; px: string }> = {};
const addSprite = (name: string, sp: Sprite, flipX = false) => {
  let px = "";
  for (let y = 0; y < sp.h; y++) for (let x = 0; x < sp.w; x++) px += code(sp.at(flipX ? sp.w - 1 - x : x, y));
  sprites[name] = { w: sp.w, h: sp.h, px };
};
for (const d of ["down", "up", "left", "right"] as const) {
  addSprite(`farmer_${d}_stand`, FARMER[d].stand);
  FARMER[d].walk.forEach((sp, i) => addSprite(`farmer_${d}_walk${i}`, sp));
}
for (const k of ["a", "b", "peck"] as const) {
  addSprite(`hen_r_${k}`, CHICKEN[k]);
  addSprite(`hen_l_${k}`, CHICKEN_L[k]);
}
addSprite("egg", EGG);
for (const c of CROP_IDS)
  for (let st = 0; st < 4; st++) {
    addSprite(`crop_${c}_${st}`, cropSprite(c, st, false));
    addSprite(`crop_${c}_${st}_w`, cropSprite(c, st, true));
  }
addSprite("hoe", ICONS.hoe);
addSprite("hoe_l", ICONS.hoe, true);
addSprite("can", ICONS.can);
addSprite("can_l", ICONS.can, true);
for (const c of CROP_IDS) addSprite(`bag_${c}`, seedBag(c));

// ---- soil textures (field interior), mirroring render.ts buildGround ----------
// For every pixel: the colour with no bed-edge rule, and the colour when the edge rule applies
// (bottom row with no tilled plot below: dark; top row with none above: light).
const FX = FIELD_RECT.x * TILE, FY = FIELD_RECT.y * TILE, FW = FIELD_RECT.w * TILE, FH = FIELD_RECT.h * TILE;
const soil: Record<string, { normal: string[]; edge: string[] }> = {};
for (const [name, wet, winter] of [["dry", false, false], ["wet", true, false], ["frost", false, true]] as const) {
  const base = wet ? P.wet : P.soil, dark = wet ? P.wetDark : P.soilDark, light = wet ? P.wetLight : P.soilLight;
  const normal: string[] = [], edge: string[] = [];
  for (let y = FY; y < FY + FH; y++) {
    let ln = "", le = "";
    for (let x = FX; x < FX + FW; x++) {
      const ly = (y - FY) % TILE;
      let c = base;
      if (ly % 4 === 3 && hash2(x, y, 53) > 0.15) c = dark;
      else if (ly % 4 === 0 && hash2(x, y, 54) < 0.35) c = light;
      else if (hash2(x, y, 50) < 0.05) c = dark;
      let e = ly === 7 ? (wet ? P.wetDark : P.soilDark) : ly === 0 ? light : c;
      const post = (v: number) => {
        if (wet && ly % 4 === 1 && hash2(x, y, 51) < 0.07) v = 0x8a6248;
        if (winter && !wet && hash2(x, y, 52) < 0.3 && ly % 4 !== 3) v = 0xe4ecf4;
        return v;
      };
      c = post(c);
      e = post(e);
      ln += code(c);
      le += code(e);
    }
    normal.push(ln);
    edge.push(le);
  }
  soil[name] = { normal, edge };
}

// ---- light: ambient overlay per quarter hour, glow positions --------------------
const ambient: { hour: number; color: number; alpha: number }[] = [];
for (let h = 6; h <= 26.001; h += 0.25) {
  const a = dayNightAmbient(h);
  const r = (a >> 16) & 255, g = (a >> 8) & 255, b = a & 255;
  const lum = (r * 0.3 + g * 0.59 + b * 0.11) / 255;
  // a translucent sheet over the canvas: darker and more opaque as the light falls,
  // tinted towards the ambient hue (warm at dusk, blue at night)
  const alpha = Math.max(0, Math.min(0.78, (1 - lum) * 1.05));
  const k = 0.35;
  const tint = (v: number) => Math.round(v * k);
  ambient.push({ hour: Math.round(h * 100) / 100, color: (tint(r) << 16) | (tint(g) << 8) | tint(b), alpha: Math.round(alpha * 1000) / 1000 });
}
// world pixel positions (canvas y = world y + TOP), from render.ts
const lights = [
  { x: 16 + 9, y: 8 + 22, r: 16, color: 0xffc070 }, { x: 16 + 30, y: 8 + 22, r: 16, color: 0xffc070 }, { x: 16 + 26, y: 8 + 21, r: 12, color: 0xffd890 },
  { x: 9 * 8 + 12, y: 16 * 8 + 4, r: 22, color: 0xffc070 },
  { x: 28 * 8 + 8, y: 9 * 8 + 12, r: 10, color: 0xffb060 },
  { x: 16 * 8 + 4, y: 17 * 8 - 6, r: 26, color: 0xffd080 }, { x: 8 * 8 + 4, y: 5 * 8 - 6, r: 26, color: 0xffd080 },
].map((l) => ({ ...l, y: l.y + TOP }));

// ---- map: solidity and interaction per tile ------------------------------------
// codes: 0 walkable, 1 solid, 2 water (solid, refills the can); props: kind per tile ("" none)
const farm = buildFarm();
const tiles: string[] = [];
const propKinds: string[] = [];
for (let ty = 0; ty < MAP_ROWS; ty++) {
  let line = "";
  const kinds: string[] = [];
  for (let tx = 0; tx < MAP_COLS; tx++) {
    const id = farm.tiles.get(tx, ty);
    line += id === 2 ? "2" : isSolidTile(farm, tx, ty) ? "1" : "0";
    const pi = farm.propAt[ty * MAP_COLS + tx];
    kinds.push(pi >= 0 ? farm.props[pi].kind : "");
  }
  tiles.push(line);
  propKinds.push(kinds.join(","));
}
const map = { cols: MAP_COLS, rows: MAP_ROWS, tiles, propKinds, field: FIELD_RECT, pen: PEN_RECT, coop: COOP_RECT, spawn: SPAWN, bed: BED_TILES };

const out = {
  map,
  variables: VARIABLES,
  rules: RULES,
  note: "Generated by scripts/excel/export-fieldbook-assets.ts from the Fieldbook renderer. Colours are 0xRRGGBB; pixels are 2-char palette codes, '..' = transparent.",
  alphabet: ALPHA,
  width: W,
  height: H,
  top: TOP,
  tile: TILE,
  field: { x: FX, y: FY + TOP, w: FW, h: FH },
  palette,
  seasons,
  sprites,
  soil,
  ambient,
  lights,
  colors: { cream: P.cream, shadow: P.shadow, waterLight: P.waterLight, goldLight: P.goldLight, water: P.water },
};
mkdirSync("examples/fieldbook/excel", { recursive: true });
writeFileSync("examples/fieldbook/excel/assets.json", JSON.stringify(out));
console.log(`palette ${palette.length}, objects ${SEASONS.map((s) => seasons[s].objects.length).join("/")}, sprites ${Object.keys(sprites).length}`);
