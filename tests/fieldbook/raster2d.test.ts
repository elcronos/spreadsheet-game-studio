import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ParticleSystem, Surface, TileMap, applyLighting, computeFit, dayNightAmbient, drawText, flipSpriteX, hexColor, mix, present,
  spriteFromStrings, textWidth, upscale, hasDom, TRANSPARENT,
} from "../../engines/raster2d";

const px = (s: Surface, x: number, y: number) => s.get(x, y);

test("surface primitives: clear, fillRect with alpha, clipping, origin", () => {
  const s = new Surface(8, 6);
  s.clear(0x000000);
  s.fillRect(2, 2, 3, 2, 0xffffff);
  assert.equal(px(s, 2, 2), 0xffffff);
  assert.equal(px(s, 5, 2), 0x000000);
  s.fillRect(0, 0, 1, 1, 0xff0000, 0.5);
  assert.equal(px(s, 0, 0), 0x7f0000);
  s.fillRect(-10, -10, 100, 1, 0x00ff00); // fully clipped row (-10) must not throw
  s.setOrigin(10, 10);
  s.pset(11, 11, 0x0000ff);
  s.resetOrigin();
  assert.equal(px(s, 1, 1), 0x0000ff);
  s.line(0, 5, 7, 5, 0x123456);
  assert.equal(px(s, 7, 5), 0x123456);
  s.fillCircle(4, 3, 2, 0xabcdef);
  assert.equal(px(s, 4, 3), 0xabcdef);
});

test("sprites from palette strings, transparency and horizontal flip", () => {
  const sp = spriteFromStrings(["ab.", "..b"], { a: 0xff0000, b: 0x00ff00 });
  assert.equal(sp.w, 3);
  assert.equal(sp.at(2, 0), TRANSPARENT);
  const f = flipSpriteX(sp);
  assert.equal(f.at(2, 0), 0xff0000);
  assert.equal(f.at(0, 1), 0x00ff00);
  assert.throws(() => spriteFromStrings(["ab", "a"], { a: 1, b: 2 }), /row 1/);
  assert.throws(() => spriteFromStrings(["az"], { a: 1 }), /unknown palette char/);
  const s = new Surface(4, 2);
  s.clear(0x111111);
  s.blit(sp, 0, 0, { flipX: true });
  assert.equal(px(s, 0, 0), 0x111111, "transparent pixels keep the background");
  assert.equal(px(s, 2, 0), 0xff0000);
});

test("3x5 font draws text and measures width", () => {
  const s = new Surface(40, 8);
  s.clear(0);
  const w = drawText(s, "DAY 12", 1, 1, 0xffffff);
  assert.equal(w, textWidth("DAY 12"));
  assert.equal(w, 6 * 4 - 1);
  let lit = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 40; x++) if (px(s, x, y) === 0xffffff) lit++;
  assert.ok(lit > 20);
});

test("present: integer upscale, area downscale, fractional and letterbox fits", () => {
  const src = new Surface(160, 90);
  src.clear(0x000000);
  src.pset(1, 1, 0xffffff);
  const out2 = new Uint8Array(320 * 180 * 4);
  const f2 = present(src, 320, 180, out2);
  assert.deepEqual([f2.scale, f2.integer, f2.dx, f2.dy], [2, true, 0, 0]);
  const at = (buf: Uint8Array, w: number, x: number, y: number) => (buf[(y * w + x) * 4] << 16) | (buf[(y * w + x) * 4 + 1] << 8) | buf[(y * w + x) * 4 + 2];
  for (const [x, y] of [[2, 2], [3, 2], [2, 3], [3, 3]]) assert.equal(at(out2, 320, x, y), 0xffffff);
  assert.equal(at(out2, 320, 4, 2), 0);
  // 80x45: every target pixel averages a 2x2 block
  const out05 = new Uint8Array(80 * 45 * 4);
  present(src, 80, 45, out05);
  assert.equal(out05[0], 64, "(1,1) white in a 2x2 black block averages to 1/4");
  // 240x135 (1.5x) is fractional nearest-neighbour, still fills the target
  assert.deepEqual(computeFit(160, 90, 240, 135), { scale: 1.5, dx: 0, dy: 0, dw: 240, dh: 135, integer: false });
  // square target letterboxes and keeps aspect
  const f = computeFit(160, 90, 100, 100);
  assert.equal(f.dw, 100);
  assert.equal(f.dh, 56);
  assert.equal(f.dy, 22);
  // 330x190: integer 2x fits >= 80% so it is used, centred
  assert.deepEqual(computeFit(160, 90, 330, 190), { scale: 2, dx: 5, dy: 5, dw: 320, dh: 180, integer: true });
  // cover crops instead of letterboxing
  const c = computeFit(160, 90, 100, 100, { fit: "cover" });
  assert.equal(c.dh, 100);
  assert.ok(c.dx < 0);
  const big = upscale(src, 3);
  assert.equal(big.width, 480);
  assert.equal(big.get(4, 4), 0xffffff);
});

test("lighting darkens with ambient and point lights brighten locally", () => {
  const s = new Surface(40, 10);
  s.clear(0xc0c0c0);
  applyLighting(s, 0x404040, [{ x: 5, y: 5, radius: 6, color: 0xffffff, intensity: 1 }], { bands: 0 });
  assert.ok((s.get(5, 5) & 0xff) > (s.get(35, 5) & 0xff));
  assert.equal(s.get(35, 5) & 0xff, 0x30);
  assert.ok((dayNightAmbient(23) & 0xff) < 0xff && dayNightAmbient(12) === 0xffffff);
  assert.equal(mix(0x000000, 0xffffff, 0.5), 0x808080);
  assert.equal(hexColor("#f80"), 0xff8800);
});

test("tile map helpers and deterministic particles", () => {
  const m = new TileMap(4, 3, 8, 0);
  m.strokeRect(0, 0, 4, 3, 1);
  assert.equal(m.get(1, 1), 0);
  assert.equal(m.get(0, 1), 1);
  assert.equal(m.get(-1, 0), -1);
  assert.equal(m.neighbourMask(0, 1, (id) => id === 1), 1 | 4);
  const run = () => {
    let a = 7;
    const rng = () => ((a = (a * 16807) % 2147483647) / 2147483647);
    const p = new ParticleSystem();
    p.burst({ x: 10, y: 10, count: 20, speed: [5, 10], angle: [0, Math.PI], life: [0.5, 1], colors: [0xff0000, 0x00ff00], gravity: 30 }, rng);
    for (let i = 0; i < 10; i++) p.update(1 / 30);
    const s = new Surface(32, 32);
    s.clear(0);
    p.draw(s);
    return Buffer.from(s.data).toString("base64");
  };
  assert.equal(run(), run());
  assert.equal(hasDom(), false, "Node has no DOM; CanvasPresenter stays unused");
});
