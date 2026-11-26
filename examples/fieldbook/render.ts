/**
 * Fieldbook renderer: draws the farm at the 160x90 logical resolution into a
 * raster2d Surface. Pure function of simulation state (+ sim time), so frames
 * are deterministic and never consume the game RNG.
 */
import {
  type Color, Surface, applyLighting, bayer4, blue, dayNightAmbient, drawText, fbm, green, hash1, hash2, mix,
  multiplyColor, red, shade, textWidth, type Light, TRANSPARENT,
} from "../../engines/raster2d";
import {
  canopy, FARMER, CHICKEN, CHICKEN_L, CROP_SPR, EGG, GRASS, ICONS, P, type GrassPal, cropSprite, drawBoard, drawBush, drawCoop, drawCrate,
  drawFence, drawFlowers, drawHouse, drawLamp, drawMailbox, drawRock, drawScarecrow, drawShed, drawStall, drawStump, drawTrough, drawWell,
  itemIcon, seedBag, shadowEllipse, treeSprite,
} from "./art";
import { CROPS, type Season, TOOLS } from "./defs";
import { FIELD_RECT, MAP_COLS, MAP_ROWS, POND, T, TILE, isFieldTile, pondE } from "./map";
import { type FarmSim, ITEMS } from "./sim";

export const LOGICAL_W = 160;
export const LOGICAL_H = 90;

export interface RenderOptions {
  /** Hide small text (used when presenting below 1x, e.g. 80x45). */
  compact?: boolean;
  /** Fixed camera (top-left, world pixels) instead of following the farmer. */
  camera?: [number, number];
}

// ---- ground cache -----------------------------------------------------------
interface GroundCache {
  surface: Surface;
  version: number;
  season: Season;
}
const caches = new WeakMap<FarmSim, GroundCache>();

function pathLike(id: number): boolean {
  return id === T.PATH || id === T.PLAZA;
}

function grassAt(g: GrassPal, x: number, y: number): Color {
  const n = fbm(x / 13, y / 11, 3);
  const v = n + (bayer4(x, y) - 0.5) * 0.16;
  let c = v < (g.snow ? 0.28 : 0.36) ? g.dark : v > 0.66 ? g.light : g.mid;
  const h = hash2(x, y, 5);
  if (h < 0.045) c = g.light;
  else if (h > 0.965) c = g.dark;
  if (g.snow && hash2(x, y, 21) < 0.012) c = 0x6f8f6a;
  return c;
}

function pathAt(x: number, y: number, snow: boolean): Color {
  const v = fbm(x / 7, y / 5, 8) + (bayer4(x, y) - 0.5) * 0.08;
  let c = v < 0.36 ? P.pathDark : v > 0.7 ? P.pathLight : P.path;
  const h = hash2(x, y, 6);
  if (h < 0.03) c = P.pathDeep;
  else if (hash2(x, y - 1, 6) < 0.03) c = P.pathLight;
  return snow ? mix(c, 0xe4ecf4, hash2(x, y, 31) < 0.5 ? 0.55 : 0.35) : c;
}

function cobbleAt(x: number, y: number, snow: boolean): Color {
  const row = Math.floor(y / 3);
  const off = (row % 2) * 2;
  const col = Math.floor((x + off) / 4);
  const lx = (x + off) % 4;
  const ly = y % 3;
  let c: Color;
  if (lx === 3 || ly === 2) c = P.cobbleDark;
  else {
    const k = hash2(col, row, 12);
    c = k < 0.33 ? P.cobble : k < 0.66 ? P.cobbleLight : mix(P.cobble, P.cobbleDark, 0.35);
    if (lx === 0 && ly === 0) c = mix(c, 0xffffff, 0.25);
  }
  return snow ? mix(c, 0xe4ecf4, 0.4) : c;
}

function buildGround(sim: FarmSim, season: Season): Surface {
  const g = GRASS[season];
  const map = sim.map.tiles;
  const s = new Surface(MAP_COLS * TILE, MAP_ROWS * TILE);
  const winter = season === "Winter";
  for (let ty = 0; ty < MAP_ROWS; ty++)
    for (let tx = 0; tx < MAP_COLS; tx++) {
      const id = map.get(tx, ty);
      const up = map.get(tx, ty - 1, id), dn = map.get(tx, ty + 1, id), lf = map.get(tx - 1, ty, id), rt = map.get(tx + 1, ty, id);
      for (let ly = 0; ly < TILE; ly++)
        for (let lx = 0; lx < TILE; lx++) {
          const x = tx * TILE + lx, y = ty * TILE + ly;
          let c: Color;
          if (id === T.PATH || id === T.PLAZA) {
            c = id === T.PATH ? pathAt(x, y, winter) : cobbleAt(x, y, winter);
            // organic grass edges
            const edges: [boolean, number, number][] = [
              [!pathLike(up), ly, hash1(x, 1)],
              [!pathLike(dn), TILE - 1 - ly, hash1(x, 2)],
              [!pathLike(lf), lx, hash1(y, 3)],
              [!pathLike(rt), TILE - 1 - lx, hash1(y, 4)],
            ];
            for (const [open, d, hh] of edges) {
              if (!open) continue;
              const j = hh < 0.45 ? 1 : 0;
              if (d < j) c = grassAt(g, x, y);
              else if (d < j + 1) c = winter ? 0xb8c4d4 : id === T.PATH ? P.pathDark : P.cobbleDark;
            }
          } else {
            c = grassAt(g, x, y);
            if (id === T.TREE) c = shade(c, 0.78);
          }
          s.pset(x, y, c);
        }
      // grass tufts and flowers
      if (id === T.GRASS || id === T.FIELD || id === T.BLOCK) {
        const h = hash2(tx, ty, 77);
        if (h < 0.4) {
          const ox = tx * TILE + 1 + Math.floor(hash2(tx, ty, 78) * 5);
          const oy = ty * TILE + 2 + Math.floor(hash2(tx, ty, 79) * 5);
          s.pset(ox, oy, g.hi);
          s.pset(ox + 2, oy - 1, g.hi);
          s.pset(ox + 1, oy, g.light);
          s.pset(ox, oy + 1, g.shadow);
          s.pset(ox + 1, oy + 1, g.dark);
          s.pset(ox + 2, oy, g.dark);
        }
        if (h > 0.9 && !isFieldTile(tx, ty)) {
          const fx = tx * TILE + 2 + Math.floor(hash2(tx, ty, 80) * 4);
          const fy = ty * TILE + 2 + Math.floor(hash2(tx, ty, 81) * 4);
          const fc = g.flowers[Math.floor(hash2(tx, ty, 82) * g.flowers.length)];
          s.pset(fx - 1, fy, fc);
          s.pset(fx + 1, fy, fc);
          s.pset(fx, fy - 1, fc);
          s.pset(fx, fy + 1, g.shadow);
          s.pset(fx, fy, g.snow ? fc : P.gold);
        }
      }
    }
  // pond: smooth ellipse drawn per pixel (collision stays tile-based)
  const r = Math.min(POND.rx, POND.ry);
  for (let y = Math.floor(POND.cy - POND.ry - 3); y <= POND.cy + POND.ry + 3; y++)
    for (let x = Math.floor(POND.cx - POND.rx - 3); x <= POND.cx + POND.rx + 3; x++) {
      const e = pondE(x + 0.5, y + 0.5) + (hash1(Math.floor(Math.atan2(y - POND.cy, x - POND.cx) * 9), 44) - 0.5) * 0.06;
      const d = (1 - Math.sqrt(e)) * r; // ~pixels from the shore (negative outside)
      const north = y < POND.cy;
      if (d < -1.2) continue;
      let c: Color;
      if (d < 0) c = winter ? 0xb0c0d4 : g.shadow;
      else if (winter) c = d < 1 ? 0x7aa8cc : hash2(x, y, 40) < 0.03 ? 0xffffff : (x * 2 + y * 3) % 17 === 0 ? 0xc8e2f2 : d < 3 ? 0xb4d4ea : 0x9cc4e0;
      else if (north && d < 1) c = 0x2a4f3a;
      else if (north && d < 2.5) c = P.waterDeeper;
      else if (d < 1) c = P.foam;
      else if (d < 2) c = P.waterLight;
      else if (d < 5) c = (x + y) % 5 === 0 && bayer4(x, y) > 0.5 ? P.waterLight : P.water;
      else c = bayer4(x, y) < 0.25 ? P.water : P.waterDeep;
      s.pset(x, y, c);
    }
  if (!winter)
    for (const [lx, ly, flower] of [[-12, 2, true], [8, -3, false], [3, 7, true], [-4, -6, false]] as const) {
      const px = POND.cx + lx, py = POND.cy + ly;
      s.fillEllipse(px + 1.5, py + 1, 2.2, 1.5, 0x3f8f3a);
      s.pset(px + 1, py, 0x6fb04a);
      s.pset(px + 2, py + 1, P.waterDeep);
      if (flower && season !== "Autumn") {
        s.pset(px, py, 0xf4a6c0);
        s.pset(px + 1, py - 1, 0xfff0f4);
      }
    }
  // tilled plots
  for (let py = 0; py < FIELD_RECT.h; py++)
    for (let px = 0; px < FIELD_RECT.w; px++) {
      const tx = FIELD_RECT.x + px, ty = FIELD_RECT.y + py;
      const p = sim.plot(tx, ty)!;
      if (!p.tilled) continue;
      const wet = p.watered;
      const base = wet ? P.wet : P.soil, dark = wet ? P.wetDark : P.soilDark, light = wet ? P.wetLight : P.soilLight;
      const til = (x: number, y: number) => !!sim.plot(x, y)?.tilled;
      const tU = til(tx, ty - 1), tD = til(tx, ty + 1), tL = til(tx - 1, ty), tR = til(tx + 1, ty);
      for (let ly = 0; ly < TILE; ly++)
        for (let lx = 0; lx < TILE; lx++) {
          const x = tx * TILE + lx, y = ty * TILE + ly;
          // round only the outside corners of a bed
          if (((lx === 0 && !tL) || (lx === 7 && !tR)) && ((ly === 0 && !tU) || (ly === 7 && !tD))) continue;
          let c = base;
          if (ly % 4 === 3 && hash2(x, y, 53) > 0.15) c = dark; // furrow
          else if (ly % 4 === 0 && hash2(x, y, 54) < 0.35) c = light; // ridge crumbs
          else if (hash2(x, y, 50) < 0.05) c = dark;
          if (ly === 7 && !tD) c = wet ? P.wetDark : P.soilDark;
          if (ly === 0 && !tU) c = light;
          if (wet && ly % 4 === 1 && hash2(x, y, 51) < 0.07) c = 0x8a6248; // glints
          if (winter && !wet && hash2(x, y, 52) < 0.3 && ly % 4 !== 3) c = 0xe4ecf4;
          s.pset(x, y, c);
        }
    }
  // doormat
  const mx = 4 * TILE + 1, my = 5 * TILE + 1;
  s.fillRect(mx, my, 6, 4, 0xa83c36);
  s.rect(mx, my, 6, 4, 0x7a2a26);
  s.hline(mx + 1, mx + 4, my + 2, P.cream);
  return s;
}

function ground(sim: FarmSim, season: Season): Surface {
  let c = caches.get(sim);
  if (!c || c.version !== sim.groundVersion || c.season !== season) {
    c = { surface: buildGround(sim, season), version: sim.groundVersion, season };
    caches.set(sim, c);
  }
  return c.surface;
}

// ---- helpers --------------------------------------------------------------------
function panel(s: Surface, x: number, y: number, w: number, h: number, a = 0.88): void {
  s.fillRect(x + 1, y, w - 2, h, P.ui, a);
  s.fillRect(x, y + 1, 1, h - 2, P.ui, a);
  s.fillRect(x + w - 1, y + 1, 1, h - 2, P.ui, a);
  s.hline(x + 1, x + w - 2, y, P.uiLight, a);
  s.hline(x + 1, x + w - 2, y + h - 1, P.shadow, a);
}

function luminance(c: Color): number {
  return (red(c) * 0.3 + green(c) * 0.59 + blue(c) * 0.11) / 255;
}

export function camera(sim: FarmSim): [number, number] {
  const f = sim.farmer;
  const cx = Math.round(Math.max(0, Math.min(MAP_COLS * TILE - LOGICAL_W, f.x - LOGICAL_W / 2)));
  const cy = Math.round(Math.max(-6, Math.min(MAP_ROWS * TILE - LOGICAL_H + 8, f.y - 8 - LOGICAL_H / 2)));
  return [cx, cy];
}

function fmtHour(h: number): string {
  const hh = Math.floor(h) % 24;
  const mm = Math.floor((h - Math.floor(h)) * 6) * 10;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// ---- main ----------------------------------------------------------------------
export function renderScene(sim: FarmSim, s: Surface, o: RenderOptions = {}): void {
  const season = sim.season;
  const t = sim.time;
  const hour = sim.hour;
  const raining = sim.raining;
  const winter = season === "Winter";
  const [camX, camY] = o.camera ?? camera(sim);
  s.resetClip();
  s.resetOrigin();
  s.clear(canopy(season)[1]);
  s.setOrigin(camX, camY);
  s.drawSurface(ground(sim, season), 0, 0);

  // water shimmer
  sim.map.tiles.forEachVisible(camX, camY, LOGICAL_W, LOGICAL_H, (tx, ty, id) => {
    if (id !== T.WATER || winter) return;
    const slot = Math.floor(t * 1.5 + hash2(tx, ty, 60) * 10);
    for (let i = 0; i < 2; i++) {
      const hx = hash2(tx * 7 + i, slot, 61), hy = hash2(ty * 5 + i, slot, 62);
      if (hash2(tx, ty + i, slot) < 0.55) continue;
      const x = tx * TILE + 2 + Math.floor(hx * 4), y = ty * TILE + 2 + Math.floor(hy * 4);
      s.hline(x, x + 1, y, P.waterLight);
    }
    if (raining) {
      const rs = Math.floor(t * 4 + hash2(tx, ty, 63) * 7);
      if (hash2(tx, ty, rs) < 0.35) s.circle(tx * TILE + 4, ty * TILE + 4, 1 + (rs % 2), P.waterLight, 0.7);
    }
  });

  // ---- y-sorted world objects ----
  const draws: { y: number; f: () => void }[] = [];
  const view = { x0: camX - 16, y0: camY - 8, x1: camX + LOGICAL_W + 16, y1: camY + LOGICAL_H + 24 };
  const visible = (x: number, y: number) => x >= view.x0 && x <= view.x1 && y >= view.y0 && y <= view.y1;
  const lit = hour >= 18.5 || hour < 6.5 ? 1 : 0;
  const lights: Light[] = [];

  sim.map.tiles.forEachVisible(camX, camY - 16, LOGICAL_W, LOGICAL_H + 32, (tx, ty, id) => {
    const bx = tx * TILE, by = ty * TILE;
    if (id === T.TREE) {
      const v = Math.floor(hash2(tx, ty, 70) * 4);
      const jx = Math.floor(hash2(tx, ty, 71) * 3) - 1;
      const sp = treeSprite(season, v);
      draws.push({
        y: by + 8,
        f: () => {
          shadowEllipse(s, bx + 4, by + 7, 5, 1.6, 0.3);
          s.blit(sp, bx - 2 + jx, by + 8 - sp.h + 1);
          if (season === "Spring") {
            for (let i = 0; i < 4; i++) {
              const px = Math.floor(hash2(tx, ty, 72 + i) * sp.w), py = Math.floor(hash2(tx, ty, 80 + i) * 9);
              if (sp.at(px, py) !== TRANSPARENT) s.pset(bx - 2 + jx + px, by + 8 - sp.h + 1 + py, i % 2 ? 0xf4b8c8 : 0xfff0f4);
            }
          }
        },
      });
    } else if (id === T.FENCE) {
      const mask = sim.map.tiles.neighbourMask(tx, ty, (n) => n === T.FENCE);
      draws.push({ y: by + 7, f: () => drawFence(s, bx, by, mask, season) });
    }
  });

  sim.map.props.forEach((p, i) => {
    const bx = p.tx * TILE, by = p.ty * TILE;
    const bottom = (p.ty + p.h) * TILE;
    if (!visible(bx + p.w * 4, bottom) && !visible(bx, by)) return;
    let f: (() => void) | null = null;
    switch (p.kind) {
      case "house":
        f = () => drawHouse(s, bx, by, lit, season);
        if (lit) {
          lights.push({ x: bx + 9, y: by + 22, radius: 16, color: 0xffc070, intensity: 1 }, { x: bx + 30, y: by + 22, radius: 16, color: 0xffc070, intensity: 1 }, { x: bx + 26, y: by + 21, radius: 12, color: 0xffd890, intensity: 0.9 });
        }
        break;
      case "shed":
        f = () => drawShed(s, bx, by, season);
        break;
      case "well":
        f = () => drawWell(s, bx, by);
        break;
      case "stall":
        f = () => drawStall(s, bx, by, t);
        lights.push({ x: bx + 12, y: by + 4, radius: 22, color: 0xffc070, intensity: 0.9 });
        break;
      case "crate":
        f = () => drawCrate(s, bx, by);
        break;
      case "board":
        f = () => drawBoard(s, bx, by, sim.orders.filter((o) => o.status === "OPEN").length);
        break;
      case "coop":
        f = () => drawCoop(s, bx, by, season);
        if (lit) lights.push({ x: bx + 8, y: by + 12, radius: 10, color: 0xffb060, intensity: 0.6 });
        break;
      case "trough":
        f = () => drawTrough(s, bx, by);
        break;
      case "scarecrow":
        f = () => drawScarecrow(s, bx, by, t);
        break;
      case "mailbox":
        f = () => drawMailbox(s, bx, by);
        break;
      case "lamp":
        f = () => drawLamp(s, bx, by, !!lit);
        if (lit) lights.push({ x: bx + 4, y: by - 6, radius: 26, color: 0xffd080, intensity: 1.1 });
        break;
      case "bush":
        f = () => drawBush(s, bx, by, season, hash2(i, 3));
        break;
      case "rock":
        f = () => drawRock(s, bx, by);
        break;
      case "stump":
        f = () => drawStump(s, bx, by);
        break;
      case "flowers":
        draws.push({ y: by + 2, f: () => drawFlowers(s, bx, by, season, i) });
        return;
      case "mat":
        return;
    }
    if (f !== null) draws.push({ y: bottom, f });
  });

  // crops
  for (let py = 0; py < FIELD_RECT.h; py++)
    for (let px = 0; px < FIELD_RECT.w; px++) {
      const tx = FIELD_RECT.x + px, ty = FIELD_RECT.y + py;
      const p = sim.plot(tx, ty)!;
      if (!p.crop) continue;
      const stage = sim.stage(p);
      const sp = cropSprite(p.crop, stage, p.withered);
      const bx = tx * TILE, by = ty * TILE;
      const ripe = stage >= 3 && !p.withered;
      draws.push({
        y: by + 7,
        f: () => {
          const sway = ripe && Math.sin(t * 2 + tx) > 0.85 ? 1 : 0;
          if (stage >= 2) s.hline(bx + 1, bx + 6, by + 7, P.shadow, 0.3);
          s.blit(sp, bx + sway * 0, by + 8 - sp.h);
          if (ripe) {
            const tw = Math.floor(t * 3 + tx * 1.7 + ty * 2.3) % 7;
            if (tw === 0) {
              const sx = bx + 1 + ((tx * 3 + ty) % 6), sy = by + 8 - sp.h - 1;
              s.pset(sx, sy, 0xffffff);
              s.pset(sx - 1, sy + 1, P.goldLight, 0.7);
              s.pset(sx + 1, sy + 1, P.goldLight, 0.7);
              s.pset(sx, sy + 2, P.goldLight, 0.7);
            }
          }
          if (!p.watered && !raining && hour > 14 && stage < 3 && !p.withered) {
            // thirsty: a tiny drop marker
            if (Math.floor(t * 2) % 2 === 0) s.pset(bx + 7, by, P.waterLight);
          }
        },
      });
    }

  for (const [tx, ty] of sim.eggs) draws.push({ y: ty * TILE + 6, f: () => s.blit(EGG, tx * TILE + 2, ty * TILE + 3) });

  for (const c of sim.chickens) {
    const set = c.flip ? CHICKEN_L : CHICKEN;
    const moving = !c.pecking && Math.hypot(c.tx - c.x, c.ty - c.y) > 0.5;
    const sp = c.pecking ? (Math.floor(c.anim * 4) % 2 ? set.peck : set.a) : moving && Math.floor(c.anim * 6) % 2 ? set.b : set.a;
    draws.push({
      y: c.y,
      f: () => {
        shadowEllipse(s, c.x, c.y - 0.5, 3.5, 1.2, 0.3);
        s.blit(sp, Math.round(c.x) - Math.floor(sp.w / 2), Math.round(c.y) - sp.h);
      },
    });
  }

  // farmer
  const f = sim.farmer;
  const frames = FARMER[f.dir];
  const wi = Math.floor(f.walkT * 8) % 4;
  const fsp = f.moving ? frames.walk[wi] : frames.stand;
  const bob = f.moving && (wi === 1 || wi === 3) ? -1 : 0;
  draws.push({
    y: f.y,
    f: () => {
      shadowEllipse(s, f.x, f.y - 0.5, 4, 1.4, 0.32);
      s.blit(fsp, Math.round(f.x) - 5, Math.round(f.y) - fsp.h + bob);
      if (f.actionT > 0) {
        const [dx, dy] = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] }[f.dir];
        const hx = Math.round(f.x) + dx * 6 - 4, hy = Math.round(f.y) - 9 + dy * 3;
        const phase = f.actionT > 0.15;
        if (f.action === "hoe") s.blit(ICONS.hoe, hx, hy + (phase ? -3 : 0), { flipX: f.dir === "left" });
        else if (f.action === "water") s.blit(ICONS.can, hx, hy, { flipX: f.dir === "left" });
        else if (f.action === "plant") s.blit(seedBag(f.seed), hx, hy + (phase ? -1 : 0));
      }
    },
  });

  draws.sort((a, b) => a.y - b.y);
  for (const d of draws) d.f();

  // target cursor
  if (sim.hint.startsWith("E ") && sim.fade <= 0) {
    const [tx, ty] = sim.targetTile();
    if (isFieldTile(tx, ty)) {
      const x = tx * TILE, y = ty * TILE;
      const c = P.cream;
      for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + 7, y, -1, 1], [x, y + 7, 1, -1], [x + 7, y + 7, -1, -1]] as const) {
        s.pset(cx, cy, c, 0.9);
        s.pset(cx + sx, cy, c, 0.9);
        s.pset(cx, cy + sy, c, 0.9);
      }
    }
  }

  sim.particles.draw(s);

  // chimney smoke
  for (let i = 0; i < 5; i++) {
    const k = (t * 0.35 + i / 5) % 1;
    const sx = 46 + 3 + Math.sin(k * 5 + i) * 2 + k * 6;
    const sy = 8 - 9 - k * 22;
    s.fillCircle(sx, sy, 1 + k * 2.2, mix(0xe8e4e0, 0xb8b4b0, k), 0.55 * (1 - k));
  }

  // seasonal ambience in the air
  if (!raining) {
    if (season === "Autumn" || season === "Spring") {
      const cols = season === "Autumn" ? [0xe08a3a, 0xc0582e, 0xf2c060] : [0xf4b8c8, 0xfff0f4];
      for (let i = 0; i < 10; i++) {
        const sp = 6 + hash1(i, 3) * 6;
        const x = camX + ((hash1(i, 1) * 200 + t * sp) % 190) - 15;
        const y = camY + ((hash1(i, 2) * 110 + t * (sp * 0.8)) % 100) - 5;
        const wob = Math.sin(t * 2 + i) * 2;
        s.pset(x + wob, y, cols[i % cols.length]);
        if (i % 3 === 0) s.pset(x + wob + 1, y, cols[i % cols.length]);
      }
    }
  }

  // ---- weather & light ----
  let ambient = dayNightAmbient(hour);
  if (raining) ambient = multiplyColor(ambient, winter ? 0xd8dce8 : 0xa8b0c4);
  const dark = 1 - luminance(ambient);
  const lightK = Math.max(0, Math.min(1.3, (dark - 0.12) * 2.2));
  if (dark > 0.25) lights.push({ x: f.x, y: f.y - 6, radius: 20, color: 0xffd8a0, intensity: 0.7 });
  const scaled = lights.map((l) => ({ ...l, intensity: l.intensity * lightK }));
  s.resetOrigin();
  s.setOrigin(camX, camY);
  applyLighting(s, ambient, lightK > 0.02 ? scaled : []);

  // fireflies glow after lighting
  if ((season === "Summer" || season === "Spring") && dark > 0.35 && !raining) {
    for (let i = 0; i < 14; i++) {
      const x = 120 + hash1(i, 11) * 120 + Math.sin(t * 0.7 + i) * 6;
      const y = 60 + hash1(i, 12) * 90 + Math.cos(t * 0.9 + i * 2) * 4;
      const on = Math.sin(t * 2.5 + i * 1.7) > 0.2;
      if (on) {
        s.pset(x, y, 0xf0ff90);
        s.pset(x + 1, y, 0xb8e060, 0.5);
        s.pset(x - 1, y, 0xb8e060, 0.5);
      }
    }
  }

  if (raining) {
    const n = winter ? 60 : 90;
    for (let i = 0; i < n; i++) {
      if (winter) {
        const sp = 8 + hash1(i, 21) * 10;
        const x = camX + ((hash1(i, 22) * 170 + Math.sin(t + i) * 4 + t * 4) % 170) - 5;
        const y = camY + ((hash1(i, 23) * 100 + t * sp) % 100) - 5;
        s.pset(x, y, 0xffffff, 0.9);
        if (i % 4 === 0) s.pset(x + 1, y, 0xffffff, 0.6);
      } else {
        const sp = 110 + hash1(i, 21) * 50;
        const x = camX + ((hash1(i, 22) * 200 - t * sp * 0.25) % 200 + 200) % 200 - 20;
        const y = camY + ((hash1(i, 23) * 100 + t * sp) % 100) - 5;
        s.line(x, y, x - 1, y + 3, 0xb8d4f0, 0.55);
      }
    }
    if (!winter)
      for (let i = 0; i < 12; i++) {
        const slot = Math.floor(t * 6) + i * 13;
        const x = camX + hash1(slot, 31) * LOGICAL_W, y = camY + 10 + hash1(slot, 32) * (LOGICAL_H - 10);
        s.pset(x - 1, y, 0xc8e0f4, 0.6);
        s.pset(x + 1, y, 0xc8e0f4, 0.6);
      }
  }

  // floaters (world space)
  for (const fl of sim.floaters) drawText(s, fl.text, fl.x, fl.y, fl.color, { align: "center", shadow: P.ink, outline: true, alpha: Math.min(1, fl.t * 2) });

  s.resetOrigin();
  drawUI(sim, s, !!o.compact);

  if (sim.fade > 0) {
    const a = sim.fade > 0.8 ? 1 : sim.fade / 0.8;
    s.fillRect(0, 0, LOGICAL_W, LOGICAL_H, 0x120c10, a);
    if (sim.fade > 0.5 && !o.compact) drawText(s, "Z z z", LOGICAL_W / 2, 40, P.cream, { align: "center", alpha: Math.min(1, a) });
  }
}

// ---- UI ---------------------------------------------------------------------------
function drawUI(sim: FarmSim, s: Surface, compact: boolean): void {
  const n = (k: string) => sim.n(k);
  const hour = sim.hour;
  const stamina = n("farmer.stamina"), maxSt = Math.max(1, n("farmer.maxStamina"));
  if (compact) {
    // minimal HUD that survives a 2x downscale: stamina + water bars and the time-of-day disc
    s.fillRect(2, LOGICAL_H - 6, 40, 4, P.ui);
    s.fillRect(3, LOGICAL_H - 5, Math.round((38 * Math.min(stamina, maxSt)) / maxSt), 2, stamina / maxSt > 0.3 ? P.green : P.red);
    const cap = Math.max(1, n("farmer.canCapacity"));
    s.fillRect(LOGICAL_W - 42, LOGICAL_H - 6, 40, 4, P.ui);
    s.fillRect(LOGICAL_W - 41, LOGICAL_H - 5, Math.round((38 * n("farmer.canWater")) / cap), 2, 0x6fb7d8);
    s.fillCircle(6, 6, 4, hour >= 19 || hour < 6.5 ? 0xdfe9f3 : P.gold);
    return;
  }
  // top-left: weather/day/season/time
  const seasonAbbr = sim.season.slice(0, 3).toUpperCase();
  const left = `${seasonAbbr} ${sim.day}`;
  const time = fmtHour(hour);
  const w1 = 9 + textWidth(left) + 4 + textWidth(time) + 3;
  panel(s, 1, 1, w1, 9);
  const night = hour >= 19 || hour < 6.5;
  const icon = sim.raining ? (sim.season === "Winter" ? ICONS.snow : ICONS.rain) : night ? ICONS.moon : ICONS.sun;
  s.blit(icon, 3, 3);
  drawText(s, left, 10, 3, P.cream);
  drawText(s, time, 10 + textWidth(left) + 4, 3, P.goldLight);
  // day progress strip
  const prog = Math.max(0, Math.min(1, (hour - 6) / 20));
  s.hline(2, w1 - 1, 10, P.ui, 0.6);
  s.hline(2, 2 + Math.round((w1 - 3) * prog), 10, night ? 0x8a9ad8 : P.gold, 0.9);

  // top-right: cash
  const cash = `$${Math.floor(n("farmer.cash"))}`;
  const w2 = textWidth(cash) + 11;
  panel(s, LOGICAL_W - w2 - 1, 1, w2, 9);
  s.blit(ICONS.coin, LOGICAL_W - w2 + 1, 3);
  drawText(s, cash, LOGICAL_W - w2 + 8, 3, P.goldLight);

  // bottom-left: stamina
  panel(s, 1, LOGICAL_H - 10, 36, 9);
  s.blit(ICONS.bolt, 3, LOGICAL_H - 8);
  s.fillRect(9, LOGICAL_H - 7, 26, 3, P.shadow);
  const k = Math.max(0, Math.min(1, stamina / maxSt));
  const sc = k > 0.5 ? P.green : k > 0.25 ? P.gold : P.red;
  s.fillRect(9, LOGICAL_H - 7, Math.round(26 * k), 3, sc);
  s.hline(9, 9 + Math.max(0, Math.round(26 * k) - 1), LOGICAL_H - 7, mix(sc, 0xffffff, 0.4));

  // bottom-right: basket
  const basket = sim.basketCount();
  const bt = String(basket);
  const w3 = textWidth(bt) + 13;
  panel(s, LOGICAL_W - w3 - 1, LOGICAL_H - 10, w3, 9);
  s.blit(ICONS.basket, LOGICAL_W - w3 + 1, LOGICAL_H - 8);
  drawText(s, bt, LOGICAL_W - w3 + 9, LOGICAL_H - 8, P.cream);

  // toolbar
  const slots = TOOLS.length;
  const sw = 13, gap = 1;
  const tw = slots * sw + (slots - 1) * gap;
  const x0 = Math.floor((LOGICAL_W - tw) / 2), y0 = LOGICAL_H - 14;
  for (let i = 0; i < slots; i++) {
    const x = x0 + i * (sw + gap);
    const sel = sim.farmer.tool === i;
    const y = y0 - (sel ? 1 : 0);
    s.fillRect(x + 1, y, sw - 2, sw, sel ? P.uiMid : P.ui, 0.92);
    s.fillRect(x, y + 1, sw, sw - 2, sel ? P.uiMid : P.ui, 0.92);
    if (sel) {
      s.hline(x + 1, x + sw - 2, y, P.gold);
      s.hline(x + 1, x + sw - 2, y + sw - 1, P.goldDark);
      s.vline(x, y + 1, y + sw - 2, P.gold);
      s.vline(x + sw - 1, y + 1, y + sw - 2, P.goldDark);
    } else s.hline(x + 1, x + sw - 2, y, P.uiLight);
    const tool = TOOLS[i];
    if (tool === "HOE") s.blit(ICONS.hoe, x + 2, y + 2);
    else if (tool === "CAN") {
      s.blit(ICONS.can, x + 2, y + 2);
      const cap = Math.max(1, n("farmer.canCapacity"));
      const lv = Math.round((9 * n("farmer.canWater")) / cap);
      s.vline(x + sw - 2, y + 2, y + 10, P.shadow);
      if (lv > 0) s.vline(x + sw - 2, y + 11 - lv, y + 10, 0x6fb7d8);
    } else {
      s.blit(seedBag(sim.farmer.seed), x + 2, y + 2);
      const cnt = String(n(`farmer.seeds.${sim.farmer.seed}`));
      drawText(s, cnt, x + sw - 1, y + sw - 5, P.cream, { align: "right", shadow: P.ink, outline: true });
    }
  }

  // hint
  if (sim.hint && sim.fade <= 0) {
    const w = textWidth(sim.hint) + 6;
    const hx = Math.floor((LOGICAL_W - w) / 2), hy = y0 - 10;
    panel(s, hx, hy, w, 8, 0.8);
    const keyed = /^[A-Z] /.test(sim.hint);
    if (keyed) {
      drawText(s, sim.hint.slice(0, 1), hx + 3, hy + 2, P.gold);
      drawText(s, sim.hint.slice(1), hx + 3 + 4, hy + 2, P.cream);
    } else drawText(s, sim.hint, hx + 3, hy + 2, P.paper);
  }

  // banner
  if (sim.banner.t > 0 && sim.banner.text) {
    const text = sim.banner.text.length > 38 ? sim.banner.text.slice(0, 38) : sim.banner.text;
    const a = Math.min(1, sim.banner.t / 0.3);
    const w = textWidth(text) + 10;
    const bx = Math.floor((LOGICAL_W - w) / 2), by = 14;
    panel(s, bx, by, w, 11, 0.9 * a);
    s.hline(bx + 2, bx + w - 3, by + 1, P.goldDark, a);
    drawText(s, text, LOGICAL_W / 2, by + 3, P.cream, { align: "center", alpha: a });
  }

  // tiny order tracker under the clock: next open order
  const next = sim.orders.find((o) => o.status === "OPEN");
  if (next) {
    const label = `${next.delivered}/${next.qty} D${next.due}`;
    const w = textWidth(label) + 11;
    panel(s, 1, 11, w, 8, 0.75);
    s.blit(itemIcon(next.item), 2, 12);
    drawText(s, label, 9, 12, next.due - sim.day <= 1 ? 0xffb0a0 : P.paper);
  }
  void ITEMS;
  void CROPS;
  void CROP_SPR;
}
