// Gameplay screenshots of the real app (scripted input): node scripts/quayside/play-shot.mjs
import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => m.type() === "error" && !/404/.test(m.text()) && errs.push(m.text()));
await page.goto("http://127.0.0.1:8091/index.html?mode=3d#quayside");
await page.waitForFunction(() => window.ready === true, null, { timeout: 240000 });
await page.evaluate(() => { host.stop(); window.__in = game["input"]; window.__key = (a, d) => __in.apply({ type: "action", action: a, down: d }); });
/** Simulate `secs` of game time, rendering every `every` seconds; `each(t)` can steer. */
const play = async (secs, hold = [], each = null) => page.evaluate(([secs, hold, each]) => {
  for (const a of hold) __key(a, true);
  const fn = each ? new Function("t", "w", each) : null;
  for (let i = 0; i < Math.round(secs * 60); i++) { if (fn) fn(i / 60, game.world); game.step(1 / 60); __in.endFrame(); }
  for (const a of hold) __key(a, false);
  game.renderDirect(); game.renderDirect();
}, [secs, hold, each]);
const press = async (a) => page.evaluate((a) => { __key(a, true); game.step(1 / 60); __key(a, false); __in.endFrame(); }, a);
const shot = async (name) => { await page.evaluate(() => { game.snapCamera(); game.renderDirect(); game.renderDirect(); }); await page.screenshot({ path: `/tmp/qp-${name}.png` }); };
const steerTo = (x, z) => `const b = w.boat || w.car; if (!b) return; const want = Math.atan2(${x} - b.x, ${z} - b.z); const d = Math.atan2(Math.sin(want - b.heading), Math.cos(want - b.heading)); __key("left", d > 0.08); __key("right", d < -0.08);`;

await play(1);
await shot("1-start");
// take the red sports car parked on The Esplanade and drive along Riverside Drive
await page.evaluate(() => { const v = game.world.parked[0]; Object.assign(game.world.player, { x: v.x + 2.5, z: v.z }); });
await play(0.3);
await press("enter");
console.log("mode after F:", await page.evaluate(() => game.world.mode));
// along The Esplanade (east), then turn down Barrack Street towards the river
await play(4, ["up"], steerTo(260, -600));
await shot("2-driving");
await play(2.5, ["handbrake"]);
console.log("speed before exit:", await page.evaluate(() => Math.hypot(game.world.car.vx, game.world.car.vz).toFixed(2)));
await press("enter");
// steal the ferry: wait (in game time) for one to be docked at Elizabeth Quay
await page.evaluate(() => { for (let i = 0; i < 60 * 400 && !game.world.ferries.some((f) => f.state === "docked" && f.atEQ); i++) { game.step(1 / 60); __in.endFrame(); } });
await page.evaluate(() => game.runCommand("goto-ferry"));
await play(0.5);
await press("hijack");
console.log("mode after G:", await page.evaluate(() => [game.world.mode, game.world.heat]));
await play(14, ["up"], steerTo(0, -250));
await shot("3-heist");
await play(16, ["up"], steerTo(-150, 400));
console.log("police boats:", await page.evaluate(() => game.world.police.length), "where:", await page.evaluate(() => game.world.where(...game.world.focus())));
// night on the river
await page.evaluate(() => { game.runCommand("time-night"); });
await play(4, ["up"], steerTo(-150, 700));
await shot("4-night");
console.log("errors:", errs.slice(0, 5));
await browser.close();
