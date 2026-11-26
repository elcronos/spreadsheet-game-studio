/**
 * The farm layout: a 32x20 tile map (8px tiles) plus static props.
 * Built procedurally from rectangles so it is easy to read and edit.
 */
import { TileMap } from "../../engines/raster2d";

export const TILE = 8;
export const MAP_COLS = 32;
export const MAP_ROWS = 22;

export const T = { GRASS: 0, PATH: 1, WATER: 2, TREE: 3, FENCE: 4, FIELD: 5, BLOCK: 6, PLAZA: 7 } as const;

export type PropKind = "house" | "shed" | "well" | "stall" | "crate" | "board" | "coop" | "scarecrow" | "mat" | "bush" | "rock" | "stump" | "flowers" | "mailbox" | "lamp" | "trough";

export interface Prop {
  kind: PropKind;
  tx: number;
  ty: number;
  w: number;
  h: number;
  solid: boolean;
}

/** Pond ellipse in pixels. */
export const POND = { cx: 20 * 8, cy: 12 * 8, rx: 3.3 * 8, ry: 2.4 * 8 };
export function pondE(px: number, py: number): number {
  const dx = (px - POND.cx) / POND.rx;
  const dy = (py - POND.cy) / POND.ry;
  return dx * dx + dy * dy;
}

export const FIELD_RECT = { x: 3, y: 8, w: 9, h: 5 }; // tillable interior
export const PEN_RECT = { x: 25, y: 9, w: 5, h: 5 }; // chicken pen interior
export const COOP_RECT = { x: 28, y: 9, w: 2, h: 2 };
export const SPAWN = { tx: 4, ty: 5 };
/** Tiles where R puts you to bed (the cottage doorstep). */
export const BED_TILES: [number, number][] = [[3, 5], [4, 5], [5, 5]];

export interface FarmMap {
  tiles: TileMap;
  props: Prop[];
  /** prop index per tile, -1 if none */
  propAt: Int16Array;
}

export function buildFarm(): FarmMap {
  const m = new TileMap(MAP_COLS, MAP_ROWS, TILE, T.GRASS);
  // forest border, thicker in the corners
  m.strokeRect(0, 0, MAP_COLS, MAP_ROWS, T.TREE);
  for (const [x, y] of [[1, 1], [30, 1], [1, 20], [2, 20], [30, 20], [29, 20], [1, 19], [30, 19], [30, 2], [1, 16], [1, 17], [1, 18], [2, 19], [3, 20], [22, 20], [23, 20], [24, 20], [25, 20], [26, 20], [27, 20], [28, 20], [30, 17], [30, 18], [29, 19], [14, 1], [15, 1], [21, 1], [20, 1], [28, 16], [29, 16], [29, 17]] as const)
    m.set(x, y, T.TREE);
  // paths
  m.fillRect(2, 6, 28, 1, T.PATH); // main lane
  m.fillRect(4, 5, 1, 1, T.PATH); // doorstep
  m.fillRect(25, 4, 2, 2, T.PATH); // shed apron
  m.fillRect(15, 7, 1, 11, T.PATH); // road down to the market
  m.fillRect(27, 7, 1, 1, T.PATH); // to the pen gate
  m.fillRect(9, 5, 1, 1, T.PATH); // to the well
  // market plaza (cobbles)
  m.fillRect(6, 18, 16, 2, T.PLAZA);
  m.fillRect(14, 17, 3, 1, T.PLAZA);
  // field: fence ring with a gate, tillable interior
  m.strokeRect(FIELD_RECT.x - 1, FIELD_RECT.y - 1, FIELD_RECT.w + 2, FIELD_RECT.h + 2, T.FENCE);
  m.fillRect(FIELD_RECT.x, FIELD_RECT.y, FIELD_RECT.w, FIELD_RECT.h, T.FIELD);
  m.set(7, 7, T.PATH); // gate
  m.set(12, 12, T.GRASS); // side gate towards the market
  // pond: tiles whose centre lies inside the ellipse are water (collision); the renderer draws the smooth ellipse
  for (let y = 0; y < MAP_ROWS; y++)
    for (let x = 0; x < MAP_COLS; x++) if (pondE((x + 0.5) * TILE, (y + 0.5) * TILE) <= 1 && m.get(x, y) === T.GRASS) m.set(x, y, T.WATER);
  // chicken pen
  m.strokeRect(PEN_RECT.x - 1, PEN_RECT.y - 1, PEN_RECT.w + 2, PEN_RECT.h + 2, T.FENCE);
  m.set(27, 8, T.PATH); // pen gate

  const props: Prop[] = [
    { kind: "house", tx: 2, ty: 1, w: 5, h: 4, solid: true },
    { kind: "mat", tx: 4, ty: 5, w: 1, h: 1, solid: false },
    { kind: "well", tx: 9, ty: 4, w: 1, h: 1, solid: true },
    { kind: "shed", tx: 24, ty: 1, w: 4, h: 3, solid: true },
    { kind: "stall", tx: 9, ty: 16, w: 3, h: 2, solid: true },
    { kind: "crate", tx: 12, ty: 17, w: 1, h: 1, solid: true },
    { kind: "board", tx: 7, ty: 17, w: 1, h: 1, solid: true },
    { kind: "coop", tx: COOP_RECT.x, ty: COOP_RECT.y, w: COOP_RECT.w, h: COOP_RECT.h, solid: true },
    { kind: "trough", tx: 25, ty: 13, w: 1, h: 1, solid: true },
    { kind: "scarecrow", tx: 13, ty: 9, w: 1, h: 1, solid: true },
    { kind: "mailbox", tx: 6, ty: 5, w: 1, h: 1, solid: true },
    { kind: "lamp", tx: 16, ty: 17, w: 1, h: 1, solid: true },
    { kind: "lamp", tx: 8, ty: 5, w: 1, h: 1, solid: true },
    { kind: "flowers", tx: 2, ty: 5, w: 1, h: 1, solid: false },
    { kind: "flowers", tx: 7, ty: 4, w: 1, h: 1, solid: false },
    { kind: "bush", tx: 11, ty: 2, w: 1, h: 1, solid: true },
    { kind: "bush", tx: 22, ty: 4, w: 1, h: 1, solid: true },
    { kind: "bush", tx: 4, ty: 17, w: 1, h: 1, solid: true },
    { kind: "bush", tx: 23, ty: 17, w: 1, h: 1, solid: true },
    { kind: "rock", tx: 18, ty: 3, w: 1, h: 1, solid: true },
    { kind: "rock", tx: 3, ty: 18, w: 1, h: 1, solid: true },
    { kind: "rock", tx: 22, ty: 8, w: 1, h: 1, solid: false },
    { kind: "stump", tx: 13, ty: 4, w: 1, h: 1, solid: true },
    { kind: "flowers", tx: 17, ty: 8, w: 1, h: 1, solid: false },
    { kind: "flowers", tx: 22, ty: 9, w: 1, h: 1, solid: false },
    { kind: "flowers", tx: 4, ty: 14, w: 1, h: 1, solid: false },
    { kind: "flowers", tx: 13, ty: 15, w: 1, h: 1, solid: false },
    { kind: "flowers", tx: 25, ty: 16, w: 1, h: 1, solid: false },
    { kind: "stump", tx: 20, ty: 16, w: 1, h: 1, solid: true },
    { kind: "bush", tx: 26, ty: 17, w: 1, h: 1, solid: true },
    { kind: "rock", tx: 9, ty: 14, w: 1, h: 1, solid: false },
  ];
  const propAt = new Int16Array(MAP_COLS * MAP_ROWS).fill(-1);
  props.forEach((p, i) => {
    for (let y = p.ty; y < p.ty + p.h; y++) for (let x = p.tx; x < p.tx + p.w; x++) {
      propAt[y * MAP_COLS + x] = i;
      if (p.solid && m.get(x, y) === T.GRASS) m.set(x, y, T.BLOCK);
    }
  });
  return { tiles: m, props, propAt };
}

export function isFieldTile(tx: number, ty: number): boolean {
  return tx >= FIELD_RECT.x && ty >= FIELD_RECT.y && tx < FIELD_RECT.x + FIELD_RECT.w && ty < FIELD_RECT.y + FIELD_RECT.h;
}

export function propAtTile(map: FarmMap, tx: number, ty: number): Prop | undefined {
  if (tx < 0 || ty < 0 || tx >= MAP_COLS || ty >= MAP_ROWS) return undefined;
  const i = map.propAt[ty * MAP_COLS + tx];
  return i >= 0 ? map.props[i] : undefined;
}

export function isSolidTile(map: FarmMap, tx: number, ty: number): boolean {
  const id = map.tiles.get(tx, ty, T.TREE);
  if (id === T.TREE || id === T.WATER || id === T.FENCE || id === T.BLOCK) return true;
  const p = propAtTile(map, tx, ty);
  return !!p && p.solid;
}
