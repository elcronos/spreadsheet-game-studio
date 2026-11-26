/**
 * Fieldbook art: one warm palette, palette-string sprites, and procedural
 * drawing for buildings and props. Everything is original and authored for a
 * 160x90 logical screen with 8px tiles.
 */
import {
  type Color, type Sprite, type Surface, defineSprites, flipSpriteX, recolor, spriteFromStrings, stackSprites, hash2, shade, mix,
} from "../../engines/raster2d";
import type { CropId, Season } from "./defs";

// ---- palette --------------------------------------------------------------
export const P = {
  ink: 0x2b1d16,
  inkSoft: 0x4a3226,
  cream: 0xfff4dc,
  paper: 0xf3e3bf,
  gold: 0xf2c94c,
  goldDark: 0xc99a2e,
  goldLight: 0xffe9a0,
  red: 0xd9544a,
  redDark: 0xa83c36,
  green: 0x78c850,
  path: 0xc9a36a,
  pathDark: 0xa98250,
  pathDeep: 0x8f6b45,
  pathLight: 0xdcbb84,
  cobble: 0xb9a68c,
  cobbleDark: 0x8a7764,
  cobbleLight: 0xd6c7ab,
  soil: 0x8a5a3a,
  soilDark: 0x6b4229,
  soilLight: 0xa8744c,
  wet: 0x5e3b28,
  wetDark: 0x45291b,
  wetLight: 0x7a5038,
  water: 0x4f9fc9,
  waterDeep: 0x3b7fb0,
  waterDeeper: 0x316a9a,
  waterLight: 0x8fd3f0,
  foam: 0xd8f2ff,
  wood: 0x9b6136,
  woodDark: 0x6e4226,
  woodDeep: 0x4e2e1a,
  woodLight: 0xc4844c,
  roof: 0xc4553e,
  roofDark: 0x93392c,
  roofLight: 0xe2795a,
  wall: 0xf0d9a8,
  wallDark: 0xd2b37f,
  wallLight: 0xfbecc8,
  stone: 0x9aa0a6,
  stoneDark: 0x6f747c,
  stoneLight: 0xc5cacf,
  barn: 0xb8452f,
  barnDark: 0x8a3022,
  barnLight: 0xd4644a,
  glass: 0x6fb7d8,
  glassLight: 0xb8e4f4,
  lit: 0xffd27a,
  litLight: 0xfff0b8,
  ui: 0x3b2a20,
  uiMid: 0x5a4030,
  uiLight: 0x7a5a42,
  uiEdge: 0xe8cf9c,
  shadow: 0x1e140e,
  sky: 0x1a1410,
};

export interface GrassPal {
  shadow: Color;
  dark: Color;
  mid: Color;
  light: Color;
  hi: Color;
  flowers: Color[];
  snow: boolean;
}

export const GRASS: Record<Season, GrassPal> = {
  Spring: { shadow: 0x3f7a3a, dark: 0x55973f, mid: 0x6fb04a, light: 0x8cc85a, hi: 0xb4e07a, flowers: [0xfff4dc, 0xf6d55c, 0xf4a6c0, 0xb9a6f0], snow: false },
  Summer: { shadow: 0x46772f, dark: 0x5c9235, mid: 0x78ab3e, light: 0x95c44d, hi: 0xc0dd6a, flowers: [0xf6d55c, 0xfff4dc, 0xf08a5a], snow: false },
  Autumn: { shadow: 0x7a5a2a, dark: 0x9a7634, mid: 0xb38f40, light: 0xcaa850, hi: 0xe2c26c, flowers: [0xe0703a, 0xc4452e, 0xf2c94c], snow: false },
  Winter: { shadow: 0xa8b8d0, dark: 0xcdd9ea, mid: 0xdde7f2, light: 0xebf2f9, hi: 0xffffff, flowers: [0x6f8f6a, 0x86a37a], snow: true },
};

/** Canopy colours per season: [outline, dark, mid, light, highlight]. */
const CANOPY: Record<Season, [Color, Color, Color, Color, Color]> = {
  Spring: [0x1f4a2c, 0x2f6b3a, 0x3f8a43, 0x5aa84f, 0x8fd06a],
  Summer: [0x1d4228, 0x2a5f34, 0x37803d, 0x4f9e48, 0x7cc25c],
  Autumn: [0x5a2418, 0x8a3a24, 0xc0582e, 0xe08a3a, 0xf2c060],
  Winter: [0x1f3a36, 0x2f5048, 0x3e6658, 0xdfe9f3, 0xffffff],
};

// ---- trees ----------------------------------------------------------------
const TREE_ROWS = [
  "....kkkk....",
  "..kkllllkk..",
  ".kllhhllllk.",
  ".klhhlllmmk.",
  "kllhlllmmmdk",
  "kllllmmmmmdk",
  "kmlllmmmmddk",
  "kmmmmmmmdddk",
  ".kmmmmmddddk",
  "..kddmddddk.",
  "...kkddddkk.",
  ".....kttk...",
  ".....ktTk...",
  "....kttTTk..",
];
const TREE2_ROWS = [
  ".....kk.....",
  "....klhk....",
  "...klhlmk...",
  "...kllmmk...",
  "..klhlmmdk..",
  "..kllmmmdk..",
  ".klhlmmmddk.",
  ".kllmmmmddk.",
  "klllmmmmdddk",
  "kmmmmmmdddk.",
  ".kkmmdddkk..",
  "...kkkkk....",
  ".....ktk....",
  ".....kTk....",
];

const treeCache = new Map<string, Sprite>();
export function treeSprite(season: Season, variant: number): Sprite {
  const key = season + variant;
  let s = treeCache.get(key);
  if (!s) {
    const [k, d, m, l, h] = CANOPY[season];
    const pal = { k, d, m, l, h, t: 0x8a5a36, T: 0x5e3a22 };
    s = spriteFromStrings(variant % 2 ? TREE2_ROWS : TREE_ROWS, pal, "tree");
    if (variant >= 2) s = flipSpriteX(s);
    treeCache.set(key, s);
  }
  return s;
}
export function canopy(season: Season): [Color, Color, Color, Color, Color] {
  return CANOPY[season];
}

// ---- farmer ---------------------------------------------------------------
const FARMER_PAL = {
  k: P.ink, h: 0xeac45e, H: 0xc49a3a, b: 0xc4553e, s: 0xf2c49b, S: 0xd99e74, e: P.ink,
  r: 0x7a4526, R: 0x5a3019, c: 0xd9544a, C: 0xa83c36, o: 0x4a7cc4, O: 0x34599a, w: 0x5a341f,
};
const TOP_DOWN = [
  "...kkkk...",
  "..khhhhk..",
  ".khhhhhhk.",
  "kHHbbbbHHk",
  ".krssssrk.",
  ".ksessesk.",
  ".kSssssSk.",
  "..kSSSSk..",
  ".kcoccock.",
  "kcCooooCck",
  "ksOooooOsk",
  ".kOOooOOk.",
];
const TOP_UP = [
  "...kkkk...",
  "..khhhhk..",
  ".khhhhhhk.",
  "kHHbbbbHHk",
  ".krrrrrrk.",
  ".krrrrrrk.",
  ".kRrrrrRk.",
  "..kRRRRk..",
  ".kcoccock.",
  "kcCooooCck",
  "ksOooooOsk",
  ".kOOOOOOk.",
];
const TOP_SIDE = [
  "...kkkk...",
  "..khhhhk..",
  ".khhhhhhk.",
  "kHbbbbHHHk",
  ".krrssssk.",
  ".krrssesk.",
  ".kRrsssssk",
  "..kRSSSk..",
  "..kccock..",
  "..kcCook..",
  "..kcsOok..",
  "..kOOOOk..",
];
const LEGS_FRONT = {
  stand: ["..kOkkOk..", "..kwkkwk.."],
  a: ["..kwkkOk..", "...k.kwk.."],
  b: ["..kOkkwk..", "..kwk.k..."],
};
const LEGS_SIDE = {
  stand: ["...kOOk...", "...kwwk..."],
  a: ["..kOk.kOk.", ".kwk...kwk"],
  b: ["...kOOk...", "....kwk..."],
};

export type FarmerDir = "down" | "up" | "left" | "right";
export interface FarmerFrames {
  stand: Sprite;
  walk: Sprite[];
}
function buildFarmer(): Record<FarmerDir, FarmerFrames> {
  const mk = (top: string[], legs: string[]) => spriteFromStrings([...top, ...legs], FARMER_PAL, "farmer");
  const dir = (top: string[], L: typeof LEGS_FRONT) => {
    const stand = mk(top, L.stand);
    return { stand, walk: [mk(top, L.a), stand, mk(top, L.b), stand] };
  };
  const right = dir(TOP_SIDE, LEGS_SIDE);
  return {
    down: dir(TOP_DOWN, LEGS_FRONT),
    up: dir(TOP_UP, LEGS_FRONT),
    right,
    left: { stand: flipSpriteX(right.stand), walk: right.walk.map(flipSpriteX) },
  };
}
export const FARMER = buildFarmer();
void stackSprites;

// ---- chicken ----------------------------------------------------------------
const CHICK_PAL = { k: 0x5a4a3a, w: 0xfaf5ea, W: 0xd8cdb8, r: 0xd83a3a, y: 0xf0a830, e: P.ink };
export const CHICKEN = defineSprites(
  {
    a: [
      "......rr.",
      ".....kwwk",
      "k....kwey",
      "kk..kwwwk",
      "kwkkwwwwk",
      "kwwwwwwWk",
      ".kWwwwWk.",
      "..kWWWk..",
      "...y.y...",
    ],
    b: [
      "......rr.",
      ".....kwwk",
      "k....kwey",
      "kk..kwwwk",
      "kwkkwwwwk",
      "kwwwwwwWk",
      ".kWwwwWk.",
      "..kWWWk..",
      "..y...y..",
    ],
    peck: [
      ".........",
      ".........",
      "k........",
      "kk..kkkk.",
      "kwkkwwwwk",
      "kwwwwwwwkr",
      ".kWwwwWkey",
      "..kWWWk.y.",
      "...y.y....",
    ].map((r) => r.padEnd(10, ".").slice(0, 10)),
  },
  CHICK_PAL,
);
export const CHICKEN_L = { a: flipSpriteX(CHICKEN.a), b: flipSpriteX(CHICKEN.b), peck: flipSpriteX(CHICKEN.peck) };

export const EGG = spriteFromStrings([".kk.", "kwwk", "kwWk", ".kk."], { k: 0x8a7a64, w: 0xfaf5ea, W: 0xe0d4bc }, "egg");

// ---- crops ------------------------------------------------------------------
const CROP_PAL = {
  k: 0x24452a, g: 0x5cb84a, G: 0x3f8f3a, L: 0x9be36a, o: 0xf08a2c, O: 0xc4661c, y: 0xffc070,
  r: 0xe04a3a, R: 0xa8302a, p: 0xff9a84, t: 0xb07a4e, T: 0x7a4a2a, c: 0xc8ec9a, C: 0x8fd06a, v: 0x5f9e4a, V: 0x3f7a3a,
  m: 0xa8744c, s: 0xf0dcae, w: 0xa88a52, W: 0x76603a, u: 0xe0a040,
};
const CROP_DEFS = {
  seed: ["........", "........", "........", "........", "...mm...", "..msmm..", "..mmsm..", "........"],
  sprout: ["........", "........", "........", ".Lg..gL.", "..gLLg..", "...Gg...", "...G....", "........"],
  carrot1: ["........", "...g....", ".g.gL.g.", "..gLgLg.", ".gLgGgL.", "..GgGg..", "...GG...", "........"],
  carrot2: ["...L.g..", ".g.Lg.gL", "gLgLgLg.", ".gLgGLg.", "..GgGg..", "..oyoo..", "..oooO..", "...OO..."],
  tomato1: [
    "........", "........", "....t...", "...gt...", "..gLtg..", ".gLgtLg.", "..ggtg..", ".gLgtgG.", "..Ggtg..", "...gtG..", "....t...", "...GTG..",
  ],
  tomato2: [
    "....t...", "...gtg..", "..gLtrr.", ".rrgtpr.", ".rprtRg.", "..RgtLg.", ".gLgtrr.", "..Ggrpr.", "..rrtRG.", ".rpRtG..", "..RRt...", "...GTG..",
  ],
  pumpkin1: ["........", "........", "........", "..g..L..", ".gLg.gLg", "gLGgggG.", ".GgGLg..", "..G.G..."],
  pumpkin2: ["....T...", "..gLTg..", ".gLGt...", ".OoyoOo.", "OoyooOoO", "OoooOooO", "OOoOOoOO", ".OOOOOO."],
  cabbage1: ["........", "........", "........", "..g..g..", ".gLgCg..", "..gCcg..", "..vCCv..", "...vv..."],
  cabbage2: ["........", "..v..v..", ".vCcCcv.", "vCcccCCv", "vCcLcCCv", "vCcccCvv", ".vCCCvv.", "..vvvv.."],
  withered: ["........", "........", "...w....", ".w.ww.w.", "..wWwW..", ".WwWwWW.", "...WW...", "........"],
};
export const CROP_SPR = defineSprites(CROP_DEFS, CROP_PAL);

/** Sprite for a crop at stage 0 (seeded) .. 3 (ripe). */
export function cropSprite(crop: CropId, stage: number, withered: boolean): Sprite {
  if (withered) return CROP_SPR.withered;
  if (stage <= 0) return CROP_SPR.seed;
  if (stage === 1) return CROP_SPR.sprout;
  const ripe = stage >= 3;
  switch (crop) {
    case "carrot":
      return ripe ? CROP_SPR.carrot2 : CROP_SPR.carrot1;
    case "tomato":
      return ripe ? CROP_SPR.tomato2 : CROP_SPR.tomato1;
    case "pumpkin":
      return ripe ? CROP_SPR.pumpkin2 : CROP_SPR.pumpkin1;
    case "cabbage":
      return ripe ? CROP_SPR.cabbage2 : CROP_SPR.cabbage1;
  }
}

// ---- icons (UI) -------------------------------------------------------------
const ICON_PAL = {
  k: P.ink, M: 0xd6dbe0, m: 0x9aa0a6, t: 0xc4844c, T: 0x7a4a2a, b: 0x6fb7d8, B: 0x3f86b8, c: 0x4a8fc4, C: 0x2f6a9a, w: 0xd8f2ff,
  y: P.gold, Y: P.goldDark, l: P.goldLight, s: 0xe8d2a0, S: 0xc4a874, e: 0xfaf5ea, E: 0xd8cdb8, o: 0xf08a2c, O: 0xc4661c,
  g: 0x5cb84a, G: 0x3f8f3a, r: 0xe04a3a, R: 0xa8302a, p: 0xff9a84, v: 0x8fd06a, V: 0x5f9e4a, n: 0xc8ec9a, z: 0xffe066, Z: 0xf0a830,
  q: 0xa9b6c8, Q: 0x7a889c, h: 0xffffff, u: 0x8a5a3a, U: 0x6b4229,
};
export const ICONS = defineSprites(
  {
    hoe: [
      ".........",
      ".kkkk....",
      "kMMMMk...",
      "kmmmMtk..",
      ".kkkktTk.",
      ".....ktTk",
      "......ktk",
      ".......k.",
      ".........",
    ],
    can: [
      ".........",
      "...kkk...",
      "..k...k..",
      ".kkkkkkk.",
      "kcbbbbbck",
      "kcbwbbbck",
      "kcbbbbbckk",
      "kCccccccCk",
      ".kkkkkkk..",
    ].map((r) => r.padEnd(10, ".").slice(0, 9)),
    coin: [".kkk.", "kylyk", "kyYyk", "kyyYk", ".kkk."],
    sun: ["..z..", ".zZz.", "zZZZz", ".zZz.", "..z.."],
    moon: [".ll..", "ll...", "ll...", "ll..l", ".lll."],
    rain: [".qqq.", "qqqqq", "QQQQQ", ".b.b.", "b.b.."],
    snow: ["h.h.h", ".hhh.", "hhhhh", ".hhh.", "h.h.h"],
    bolt: ["..zz", ".zz.", "zzzz", ".zz.", "zz.."],
    basket: [".kkkkk.", "k.....k", "kkkkkkk", "kuUuUuk", "kUuUuUk", ".kkkkk."],
    carrot: ["...g.g", "....g.", "..ook.", ".oook.", "ooOk..", "oOk...", "k....."],
    tomato: ["..gg..", ".rgrr.", "rpgrrr", "rprrrR", "rrrrRR", ".RRRR."],
    pumpkin: ["..T...", ".OoOo.", "OoyoOo", "OoooOo", "OOoOOO", ".OOOO."],
    cabbage: [".vVvV.", "vnnvnv", "vnhnnV", "vnnnvV", "VvnvVV", ".VVVV."],
    egg: [".EE.", "EeeE", "EeeE", "EeEE", ".EE."],
  },
  ICON_PAL,
);
// seed bag swatch per crop
const SEED_SWATCH: Record<CropId, Color> = { carrot: 0xf08a2c, tomato: 0xe04a3a, pumpkin: 0xc4661c, cabbage: 0x8fd06a };
const seedBagCache = new Map<CropId, Sprite>();
export function seedBag(crop: CropId): Sprite {
  let s = seedBagCache.get(crop);
  if (!s) {
    s = spriteFromStrings(
      [
        "...kkk...",
        "..kSsSk..",
        "..kkkkk..",
        ".kssssSk.",
        "kssxxsSSk",
        "ksxXxxsSk",
        "ksxxxXsSk",
        "kSssssSSk",
        ".kkkkkkk.",
      ],
      { ...ICON_PAL, x: SEED_SWATCH[crop], X: shade(SEED_SWATCH[crop], 0.75) },
      "seedbag",
    );
    seedBagCache.set(crop, s);
  }
  return s;
}
export function itemIcon(item: CropId | "egg"): Sprite {
  return ICONS[item];
}
void recolor;

// ---- procedural props ---------------------------------------------------------
const H = (x: number, y: number, s = 0) => hash2(x, y, s);

export function shadowEllipse(s: Surface, cx: number, cy: number, rx: number, ry: number, a = 0.28): void {
  s.fillEllipse(cx, cy, rx, ry, P.shadow, a);
}

/** Cottage occupying tiles (2..6, 1..4): px x 16..56, y 8..40. */
export function drawHouse(s: Surface, x0: number, y0: number, lit: number, season: Season): void {
  const W = 40;
  // ground shadow
  s.fillRect(x0 + 1, y0 + 32, W, 2, P.shadow, 0.25);
  // walls
  const wy = y0 + 15;
  s.fillRect(x0 + 1, wy, W - 2, 17, P.wall);
  for (let y = wy + 2; y < y0 + 30; y += 3) s.hline(x0 + 1, x0 + W - 2, y, P.wallDark);
  s.fillRect(x0 + 1, wy, 2, 17, P.woodDark);
  s.fillRect(x0 + W - 3, wy, 2, 17, P.woodDark);
  s.vline(x0 + 2, wy, wy + 16, P.wood);
  s.vline(x0 + W - 2, wy, wy + 16, P.wood);
  // stone footing
  for (let x = x0 + 1; x < x0 + W - 1; x++) {
    const c = H(x, 7) < 0.3 ? P.stoneDark : H(x, 9) < 0.4 ? P.stoneLight : P.stone;
    s.pset(x, y0 + 30, c);
    s.pset(x, y0 + 31, H(x, 11) < 0.5 ? P.stoneDark : P.stone);
  }
  // windows
  for (const wx of [x0 + 6, x0 + 27]) {
    s.fillRect(wx - 1, wy + 3, 9, 8, P.woodDark);
    s.fillRect(wx, wy + 4, 7, 6, lit > 0.5 ? P.lit : P.glass);
    if (lit > 0.5) {
      s.fillRect(wx, wy + 4, 7, 2, P.litLight);
    } else {
      s.pset(wx + 1, wy + 5, P.glassLight);
      s.pset(wx + 2, wy + 5, P.glassLight);
      s.pset(wx + 1, wy + 6, P.glassLight);
    }
    s.vline(wx + 3, wy + 4, wy + 9, P.woodDark);
    s.hline(wx, wx + 6, wy + 6, P.woodDark);
    // flower box
    s.fillRect(wx - 1, wy + 11, 9, 2, P.wood);
    s.hline(wx - 1, wx + 7, wy + 12, P.woodDark);
    const fc = season === "Winter" ? [0xdfe9f3, 0xffffff] : season === "Autumn" ? [0xe0703a, 0xf2c94c] : [0xf4a6c0, 0xfff4dc, 0xd9544a];
    for (let i = 0; i < 7; i++) {
      s.pset(wx + i, wy + 10, i % 2 ? 0x5cb84a : fc[i % fc.length]);
      if (i % 2 === 0) s.pset(wx + i, wy + 9, 0x3f8f3a, 0);
    }
  }
  // door
  const dx = x0 + 17;
  s.fillRect(dx - 1, wy + 4, 8, 13, P.woodDeep);
  s.fillRect(dx, wy + 5, 6, 12, P.wood);
  for (let y = wy + 5; y < wy + 17; y++) s.pset(dx + 2, y, P.woodDark);
  s.hline(dx, dx + 5, wy + 8, P.woodDark);
  s.hline(dx, dx + 5, wy + 13, P.woodDark);
  s.pset(dx + 4, wy + 11, P.gold);
  s.fillRect(dx, wy + 5, 6, 1, P.woodLight);
  // little lamp beside the door
  s.fillRect(dx + 8, wy + 4, 2, 3, lit > 0.5 ? P.lit : P.goldDark);
  s.pset(dx + 8, wy + 3, P.ink);
  s.pset(dx + 9, wy + 3, P.ink);
  // roof (front-facing, overhanging)
  const ry = y0 - 2;
  const rh = 18;
  for (let y = 0; y < rh; y++) {
    const inset = Math.max(0, 6 - y); // tapered top
    const xa = x0 - 2 + inset;
    const xb = x0 + W + 1 - inset;
    for (let x = xa; x <= xb; x++) {
      const row = Math.floor(y / 3);
      const lx = x + (row % 2) * 2;
      let c = P.roof;
      if (y % 3 === 2) c = P.roofDark;
      else if (lx % 4 === 0) c = P.roofDark;
      else if (y % 3 === 0) c = P.roofLight;
      if (x === xa || x === xb) c = P.roofDark;
      s.pset(x, ry + y, c);
    }
  }
  s.hline(x0 + 4, x0 + W - 5, ry, P.ink);
  s.hline(x0 + 5, x0 + W - 6, ry + 1, P.roofLight);
  s.hline(x0 - 2, x0 + W + 1, ry + rh, P.roofDark);
  s.hline(x0 - 1, x0 + W, ry + rh + 1, P.shadow);
  if (season === "Winter") {
    for (let x = x0 + 3; x < x0 + W - 3; x++) {
      s.pset(x, ry + 1, 0xffffff);
      s.pset(x, ry + 2, H(x, 3) < 0.6 ? 0xebf2f9 : P.roofLight);
      if (H(x, 5) < 0.3) s.pset(x, ry + 3, 0xdfe9f3);
    }
  }
  // chimney
  const cx = x0 + 30;
  s.fillRect(cx, ry - 6, 6, 8, P.stone);
  s.fillRect(cx, ry - 6, 6, 1, P.stoneLight);
  s.fillRect(cx - 1, ry - 7, 8, 2, P.stoneDark);
  s.pset(cx + 2, ry - 3, P.stoneDark);
  s.pset(cx + 4, ry - 1, P.stoneDark);
  // gable window in the roof
  s.fillRect(x0 + 17, ry + 7, 6, 5, P.woodDark);
  s.fillRect(x0 + 18, ry + 8, 4, 3, lit > 0.5 ? P.lit : P.glass);
}

/** Barn-style tool shed: tiles (24..27, 1..3): px x 192..224, y 8..32. */
export function drawShed(s: Surface, x0: number, y0: number, season: Season): void {
  const W = 32;
  s.fillRect(x0 + 1, y0 + 24, W, 2, P.shadow, 0.25);
  const wy = y0 + 9;
  s.fillRect(x0, wy, W, 15, P.barn);
  for (let x = x0 + 2; x < x0 + W; x += 3) s.vline(x, wy, wy + 14, P.barnDark);
  s.hline(x0, x0 + W - 1, wy, P.barnLight);
  s.rect(x0, wy, W, 15, P.cream);
  // doors with X braces
  const dx = x0 + 9;
  s.fillRect(dx, wy + 3, 14, 12, P.barnDark);
  s.rect(dx, wy + 3, 14, 12, P.cream);
  s.vline(dx + 7, wy + 3, wy + 14, P.cream);
  s.line(dx, wy + 3, dx + 6, wy + 14, P.cream);
  s.line(dx + 6, wy + 3, dx, wy + 14, P.cream);
  s.line(dx + 7, wy + 3, dx + 13, wy + 14, P.cream);
  s.line(dx + 13, wy + 3, dx + 7, wy + 14, P.cream);
  // sign with a watering can
  s.fillRect(x0 + 2, wy + 3, 6, 5, P.woodLight);
  s.rect(x0 + 2, wy + 3, 6, 5, P.woodDark);
  s.fillRect(x0 + 4, wy + 5, 3, 2, 0x4a8fc4);
  s.pset(x0 + 3, wy + 5, 0x4a8fc4);
  // roof
  const ry = y0 - 2;
  for (let y = 0; y < 11; y++) {
    const inset = y < 4 ? 4 - y : 0;
    for (let x = x0 - 2 + inset; x <= x0 + W + 1 - inset; x++) {
      let c = 0x6a5a5a;
      if (y % 3 === 2) c = 0x4a3e40;
      else if ((x + (Math.floor(y / 3) % 2) * 2) % 4 === 0) c = 0x54484a;
      else if (y % 3 === 0) c = 0x84726e;
      s.pset(x, ry + y, c);
    }
  }
  s.hline(x0 - 2, x0 + W + 1, ry + 11, 0x3a2e30);
  if (season === "Winter") for (let x = x0 + 2; x < x0 + W - 2; x++) s.pset(x, ry + 1 + (H(x, 2) < 0.3 ? 1 : 0), 0xffffff);
  // hayloft window
  s.fillRect(x0 + 13, ry + 3, 6, 5, P.cream);
  s.fillRect(x0 + 14, ry + 4, 4, 3, 0xe8c25a);
  s.pset(x0 + 15, ry + 4, 0xc49a3a);
}

export function drawWell(s: Surface, x: number, y: number): void {
  // x,y = tile top-left
  shadowEllipse(s, x + 4, y + 8, 6, 2);
  // posts + roof
  s.vline(x, y - 6, y + 4, P.woodDark);
  s.vline(x + 7, y - 6, y + 4, P.woodDark);
  for (let i = 0; i < 4; i++) s.hline(x - 2 + i, x + 9 - i, y - 7 - i, i === 0 ? P.roofDark : i === 3 ? P.roofLight : P.roof);
  s.hline(x + 1, x + 6, y - 4, P.woodDeep);
  // rope + bucket
  s.vline(x + 4, y - 4, y - 1, P.paper);
  s.fillRect(x + 3, y - 1, 3, 2, P.wood);
  // stone ring
  s.fillEllipse(x + 4, y + 4, 4.5, 3.5, P.stone);
  s.fillEllipse(x + 4, y + 2.5, 3.2, 1.8, 0x22384a);
  s.hline(x + 1, x + 7, y + 6, P.stoneDark);
  s.pset(x + 1, y + 4, P.stoneLight);
  s.pset(x + 6, y + 5, P.stoneLight);
  s.pset(x + 3, y + 6, P.stoneLight);
}

/** Market stall: tiles (9..11, 14..15). */
export function drawStall(s: Surface, x0: number, y0: number, t: number): void {
  const W = 24;
  shadowEllipse(s, x0 + 12, y0 + 15, 13, 2, 0.25);
  // posts
  s.fillRect(x0 + 1, y0 - 2, 2, 17, P.woodDark);
  s.fillRect(x0 + W - 3, y0 - 2, 2, 17, P.woodDark);
  // counter
  s.fillRect(x0, y0 + 7, W, 9, P.wood);
  for (let x = x0 + 3; x < x0 + W; x += 4) s.vline(x, y0 + 9, y0 + 15, P.woodDark);
  s.fillRect(x0 - 1, y0 + 6, W + 2, 2, P.woodLight);
  s.hline(x0 - 1, x0 + W, y0 + 8, P.woodDark);
  s.hline(x0, x0 + W - 1, y0 + 15, P.woodDeep);
  // produce on the counter
  const items = [ICONS.carrot, ICONS.tomato, ICONS.pumpkin, ICONS.cabbage];
  items.forEach((ic, i) => s.blit(ic, x0 + 1 + i * 6, y0 + 1));
  // awning, striped, scalloped edge with a gentle sway
  const ay = y0 - 6;
  for (let y = 0; y < 6; y++)
    for (let x = -2; x < W + 2; x++) {
      const stripe = Math.floor((x + 2) / 4) % 2 === 0;
      let c = stripe ? 0xd9544a : P.cream;
      if (y === 0) c = stripe ? 0xa83c36 : 0xe0cfa8;
      s.pset(x0 + x, ay + y, c);
    }
  const sway = Math.sin(t * 2) > 0.6 ? 1 : 0;
  for (let x = -2; x < W + 2; x++) {
    const stripe = Math.floor((x + 2) / 4) % 2 === 0;
    if ((x + 2) % 4 === 1 || (x + 2) % 4 === 2) s.pset(x0 + x, ay + 6 + sway, stripe ? 0xd9544a : P.cream);
  }
  // sign
  s.fillRect(x0 + 5, ay - 6, 14, 7, P.woodDark);
  s.fillRect(x0 + 6, ay - 5, 12, 5, P.woodLight);
  s.vline(x0 + 8, ay - 1, ay, P.woodDeep);
  s.vline(x0 + 15, ay - 1, ay, P.woodDeep);
  // tiny coin glyph on sign
  s.blit(ICONS.coin, x0 + 10, ay - 5);
}

export function drawCrate(s: Surface, x: number, y: number): void {
  shadowEllipse(s, x + 4, y + 8, 5, 1.5);
  s.fillRect(x, y + 2, 8, 6, P.wood);
  s.rect(x, y + 2, 8, 6, P.woodDark);
  s.line(x, y + 2, x + 7, y + 7, P.woodDark);
  s.hline(x + 1, x + 6, y + 3, P.woodLight);
  // seed packets poking out
  const cols = [0xf08a2c, 0xe04a3a, 0xc4661c, 0x8fd06a];
  cols.forEach((c, i) => {
    s.fillRect(x + i * 2, y - 1 + (i % 2), 2, 3, c);
    s.pset(x + i * 2, y - 1 + (i % 2), P.cream);
  });
}

export function drawBoard(s: Surface, x: number, y: number, papers: number): void {
  shadowEllipse(s, x + 4, y + 8, 5, 1.5);
  s.vline(x + 1, y - 3, y + 7, P.woodDark);
  s.vline(x + 6, y - 3, y + 7, P.woodDark);
  s.fillRect(x - 1, y - 5, 10, 8, P.wood);
  s.rect(x - 1, y - 5, 10, 8, P.woodDark);
  for (let i = 0; i < Math.min(3, papers); i++) {
    const px = x + i * 3;
    s.fillRect(px, y - 4 + (i % 2), 2, 4, P.paper);
    s.pset(px, y - 4 + (i % 2), 0xd9544a);
  }
}

export function drawCoop(s: Surface, x0: number, y0: number, season: Season): void {
  shadowEllipse(s, x0 + 8, y0 + 16, 9, 2);
  s.fillRect(x0 + 1, y0 + 5, 14, 11, P.woodLight);
  for (let x = x0 + 2; x < x0 + 15; x += 3) s.vline(x, y0 + 5, y0 + 15, P.wood);
  s.rect(x0 + 1, y0 + 5, 14, 11, P.woodDark);
  s.fillEllipse(x0 + 8, y0 + 12, 2.5, 3, P.woodDeep);
  s.fillRect(x0 + 6, y0 + 13, 5, 3, P.woodDeep);
  // ramp
  s.line(x0 + 7, y0 + 16, x0 + 9, y0 + 16, P.wood);
  // roof
  for (let i = 0; i < 6; i++) s.hline(x0 - 1 + i, x0 + 16 - i, y0 + 5 - i, i % 2 ? P.roof : P.roofDark);
  s.hline(x0 + 5, x0 + 10, y0 - 1, P.roofLight);
  if (season === "Winter") s.hline(x0 + 3, x0 + 12, y0 + 1, 0xffffff);
}

export function drawTrough(s: Surface, x: number, y: number): void {
  shadowEllipse(s, x + 4, y + 7, 5, 1.5);
  s.fillRect(x, y + 3, 8, 4, P.wood);
  s.rect(x, y + 3, 8, 4, P.woodDark);
  s.hline(x + 1, x + 6, y + 4, 0xe8c25a);
  s.pset(x + 2, y + 4, 0xc49a3a);
  s.pset(x + 5, y + 4, 0xc49a3a);
}

export function drawScarecrow(s: Surface, x: number, y: number, t: number): void {
  shadowEllipse(s, x + 4, y + 8, 4, 1.5);
  s.vline(x + 4, y - 4, y + 7, P.woodDark);
  const sway = Math.sin(t * 1.3) > 0.7 ? 1 : 0;
  s.hline(x, x + 8, y + 1 + sway, P.wood);
  // shirt
  s.fillRect(x + 2, y, 5, 5, 0x5a7cc4);
  s.pset(x + 3, y + 2, 0xd9544a);
  s.pset(x + 5, y + 3, 0xf2c94c);
  // straw hands
  s.pset(x - 1, y + 1 + sway, 0xeac45e);
  s.pset(x + 9, y + 1 + sway, 0xeac45e);
  // head + hat
  s.fillRect(x + 3, y - 4, 3, 3, 0xe8d2a0);
  s.pset(x + 3, y - 3, P.ink);
  s.pset(x + 5, y - 3, P.ink);
  s.hline(x + 1, x + 7, y - 5, 0xc49a3a);
  s.fillRect(x + 3, y - 7, 3, 2, 0xeac45e);
}

export function drawMailbox(s: Surface, x: number, y: number): void {
  shadowEllipse(s, x + 4, y + 8, 3, 1);
  s.vline(x + 4, y + 2, y + 7, P.woodDark);
  s.fillRect(x + 1, y - 1, 6, 4, 0xd9544a);
  s.hline(x + 1, x + 6, y - 1, 0xe2795a);
  s.hline(x + 1, x + 6, y + 2, 0xa83c36);
  s.vline(x + 7, y - 2, y, P.gold);
}

export function drawLamp(s: Surface, x: number, y: number, lit: boolean): void {
  shadowEllipse(s, x + 4, y + 8, 3, 1);
  s.vline(x + 4, y - 6, y + 7, 0x3a3236);
  s.hline(x + 3, x + 5, y + 7, 0x3a3236);
  s.fillRect(x + 2, y - 10, 5, 5, 0x3a3236);
  s.fillRect(x + 3, y - 9, 3, 3, lit ? P.litLight : 0xc9b98a);
  s.hline(x + 1, x + 7, y - 11, 0x3a3236);
}

export function drawBush(s: Surface, x: number, y: number, season: Season, v: number): void {
  const [k, d, m, l] = CANOPY[season];
  shadowEllipse(s, x + 4, y + 7, 5, 1.5);
  s.fillEllipse(x + 4, y + 4, 4.6, 3.8, k);
  s.fillEllipse(x + 4, y + 4, 3.8, 3.0, d);
  s.fillEllipse(x + 3.5, y + 3.2, 3, 2.2, m);
  s.fillEllipse(x + 2.8, y + 2.6, 1.6, 1.2, l);
  if (season === "Summer" || season === "Autumn") {
    const berry = season === "Summer" ? 0xe04a3a : 0x7a3ab0;
    s.pset(x + 5, y + 3, berry);
    s.pset(x + 3, y + 5, berry);
    s.pset(x + 6, y + 5, berry);
  }
  if (v > 0.5) s.pset(x + 1, y + 4, l);
}

export function drawRock(s: Surface, x: number, y: number): void {
  shadowEllipse(s, x + 4, y + 7, 4, 1.2);
  s.fillEllipse(x + 4, y + 5, 3.6, 2.6, P.stoneDark);
  s.fillEllipse(x + 3.6, y + 4.4, 3, 2, P.stone);
  s.pset(x + 2, y + 3, P.stoneLight);
  s.pset(x + 3, y + 3, P.stoneLight);
}

export function drawStump(s: Surface, x: number, y: number): void {
  shadowEllipse(s, x + 4, y + 7, 4, 1.2);
  s.fillRect(x + 1, y + 3, 6, 4, P.woodDark);
  s.fillEllipse(x + 4, y + 3, 3.2, 1.6, P.woodLight);
  s.pset(x + 4, y + 3, P.wood);
  s.pset(x + 3, y + 3, P.wood);
  s.pset(x + 1, y + 6, P.woodDeep);
  s.pset(x + 6, y + 6, P.woodDeep);
}

export function drawFlowers(s: Surface, x: number, y: number, season: Season, seed: number): void {
  const pal = season === "Winter" ? [0xffffff, 0xdfe9f3] : season === "Autumn" ? [0xe0703a, 0xc4452e, 0xf2c94c] : [0xf4a6c0, 0xfff4dc, 0xf6d55c, 0xb9a6f0];
  for (let i = 0; i < 6; i++) {
    const fx = x + 1 + Math.floor(H(i, seed, 3) * 6);
    const fy = y + 2 + Math.floor(H(i, seed, 4) * 5);
    s.pset(fx, fy + 1, season === "Winter" ? 0x86a37a : 0x3f8f3a);
    s.pset(fx, fy, pal[i % pal.length]);
    if (i % 2 === 0) {
      s.pset(fx - 1, fy, pal[i % pal.length]);
      s.pset(fx + 1, fy, pal[i % pal.length]);
      s.pset(fx, fy - 1, pal[i % pal.length]);
      s.pset(fx, fy, P.gold);
    }
  }
}

/** Fence tile with rails towards fence neighbours (mask: 1 up, 2 right, 4 down, 8 left). */
export function drawFence(s: Surface, x: number, y: number, mask: number, season: Season): void {
  const post = P.wood, dark = P.woodDark, light = P.woodLight;
  if (mask & 2) {
    s.hline(x + 4, x + 8, y + 3, light);
    s.hline(x + 4, x + 8, y + 4, dark);
    s.hline(x + 4, x + 8, y + 6, light);
  }
  if (mask & 8) {
    s.hline(x, x + 3, y + 3, light);
    s.hline(x, x + 3, y + 4, dark);
    s.hline(x, x + 3, y + 6, light);
  }
  if (mask & 4) {
    s.vline(x + 3, y + 6, y + 10, light);
    s.vline(x + 4, y + 6, y + 10, dark);
  }
  if (mask & 1) {
    s.vline(x + 3, y - 2, y + 1, light);
    s.vline(x + 4, y - 2, y + 1, dark);
  }
  s.fillRect(x + 3, y + 1, 2, 7, post);
  s.vline(x + 3, y + 1, y + 7, light);
  s.pset(x + 3, y, dark);
  s.pset(x + 4, y, dark);
  s.hline(x + 2, x + 5, y + 8, P.shadow, 0.25);
  if (season === "Winter") {
    s.pset(x + 3, y, 0xffffff);
    s.pset(x + 4, y, 0xffffff);
  }
}

export { mix };
