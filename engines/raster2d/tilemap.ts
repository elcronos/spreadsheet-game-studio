/**
 * TileMap: a grid of small integer tile ids with helpers for visible-range
 * iteration and drawing through a game-supplied tile -> sprite function
 * (so autotiling and per-tile variation stay in the game).
 */
import type { Sprite } from "./sprite";
import type { Surface } from "./surface";

export class TileMap {
  readonly data: Uint16Array;
  constructor(readonly cols: number, readonly rows: number, readonly tileSize: number, fill = 0) {
    this.data = new Uint16Array(cols * rows).fill(fill);
  }
  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.cols && ty < this.rows;
  }
  get(tx: number, ty: number, outside = -1): number {
    return this.inBounds(tx, ty) ? this.data[ty * this.cols + tx] : outside;
  }
  set(tx: number, ty: number, id: number): void {
    if (this.inBounds(tx, ty)) this.data[ty * this.cols + tx] = id;
  }
  fillRect(tx: number, ty: number, w: number, h: number, id: number): void {
    for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) this.set(x, y, id);
  }
  /** Outline of a rectangle (fences, walls). */
  strokeRect(tx: number, ty: number, w: number, h: number, id: number): void {
    for (let x = tx; x < tx + w; x++) {
      this.set(x, ty, id);
      this.set(x, ty + h - 1, id);
    }
    for (let y = ty; y < ty + h; y++) {
      this.set(tx, y, id);
      this.set(tx + w - 1, y, id);
    }
  }
  get pixelWidth(): number {
    return this.cols * this.tileSize;
  }
  get pixelHeight(): number {
    return this.rows * this.tileSize;
  }
  tileAt(px: number, py: number): { tx: number; ty: number } {
    return { tx: Math.floor(px / this.tileSize), ty: Math.floor(py / this.tileSize) };
  }
  /** Iterate tiles overlapping a world-space view rectangle. */
  forEachVisible(viewX: number, viewY: number, viewW: number, viewH: number, fn: (tx: number, ty: number, id: number) => void, margin = 0): void {
    const t = this.tileSize;
    const x0 = Math.max(0, Math.floor(viewX / t) - margin);
    const y0 = Math.max(0, Math.floor(viewY / t) - margin);
    const x1 = Math.min(this.cols - 1, Math.floor((viewX + viewW) / t) + margin);
    const y1 = Math.min(this.rows - 1, Math.floor((viewY + viewH) / t) + margin);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) fn(tx, ty, this.data[ty * this.cols + tx]);
  }
  /** Draw visible tiles in world space (surface origin is the camera). */
  draw(s: Surface, tileSprite: (id: number, tx: number, ty: number) => Sprite | null | undefined): void {
    this.forEachVisible(s.ox, s.oy, s.width, s.height, (tx, ty, id) => {
      const sp = tileSprite(id, tx, ty);
      if (sp) s.blit(sp, tx * this.tileSize, ty * this.tileSize);
    });
  }
  /** 4-neighbour mask (1 = up, 2 = right, 4 = down, 8 = left) of tiles matching pred. */
  neighbourMask(tx: number, ty: number, pred: (id: number) => boolean): number {
    let m = 0;
    if (pred(this.get(tx, ty - 1))) m |= 1;
    if (pred(this.get(tx + 1, ty))) m |= 2;
    if (pred(this.get(tx, ty + 1))) m |= 4;
    if (pred(this.get(tx - 1, ty))) m |= 8;
    return m;
  }
}
