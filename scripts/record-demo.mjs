// Reproducible demo recording: drives the demonstration sequence with a fixed
// simulated clock (host.frame(t) per video frame), so the video is smooth no
// matter how slow the machine renders. Output: dist/demo.mp4 (needs ffmpeg).
//   npm run build && npm run serve &   then   node scripts/record-demo.mjs [url] [fps]
import { chromium } from "playwright";
import { mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const url = process.argv[2] ?? "http://127.0.0.1:8091/index.html";
const FPS = +(process.argv[3] ?? 24);
const dir = "dist/demo-frames";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
let n = 0;
let clock = 0;

async function open(q, hash = "") {
  await page.goto(`${url}${q}${hash}`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 120000 });
  await page.evaluate(() => {
    host.stop(); // we drive the loop ourselves
    window.__t = performance.now();
  });
  clock = 0;
}
/** Advance the game by `secs` of simulated time, capturing every video frame. */
async function play(secs, each) {
  const frames = Math.round(secs * FPS);
  for (let i = 0; i < frames; i++) {
    if (each) await page.evaluate(each, i / FPS);
    clock += 1000 / FPS;
    await page.evaluate((t) => host.frame(window.__t + t), clock);
    await page.screenshot({ path: `${dir}/f${String(n++).padStart(5, "0")}.png` });
  }
}
const js = (code) => page.evaluate(code);

// 1. An ordinary-looking spreadsheet, then the cells turn into the city
await open("?res=160x90&autostart=0");
await js(() => { host.registry.edit("world.time", 17.2); app.start(); host.stop(); });
await play(1.2, () => { app.grid.reveal = 0; });
await play(1.6, (t) => { app.grid.reveal = Math.min(1, t / 1.4); });
// 2. Explore on foot, take a sports car, drive
await js(() => { const w = game.world; w.camYaw = -Math.PI / 2; game.camYaw = -Math.PI / 2; host.sendInput({ type: "action", action: "up", down: true }); });
await play(2.5);
await js(() => { host.sendInput({ type: "action", action: "up", down: false }); const w = game.world; const v = w.spawnParked("sports", 175, -1.8, -Math.PI / 2, 0xe53935); w.player.x = 177; w.player.z = 2; w.enterVehicle(v); app.setMode("3d"); host.registry.edit("player.invincible", true); game.runCommand("autodrive"); });
await play(5);
// 3. A police pursuit begins; night falls with neon and headlights
await js(() => { host.registry.edit("player.alert", 3); game.world.police.lastSeen = game.world.t; host.registry.edit("world.timeScale", 0); host.registry.edit("world.time", 19.2); });
await play(4, (t) => { if (t > 1) host.registry.edit("world.time", 19.2 + (t - 1) * 1.1); });
await play(5);
// 4. The simulation worksheets: change vehicle speed, traffic density and police response
await js(() => { host.paused = true; app.setMode("sheet"); app.showSheet("VEHICLES"); app.grid.select(1, 1); });
await play(1.2);
await js(() => { app.commit(1, 1, "320"); app.showSheet("WORLD"); const row = 1 + game.variables.filter((v) => v.sheet === "WORLD").findIndex((v) => v.key === "world.population"); app.grid.select(row, 1); });
await play(1.2);
await js(() => { const defs = game.variables.filter((v) => v.sheet === "WORLD"); app.commit(1 + defs.findIndex((v) => v.key === "world.population"), 1, "2.5"); app.commit(1 + defs.findIndex((v) => v.key === "world.policeResponse"), 1, "3"); });
await play(1.5);
await js(() => { app.showSheet("RULES"); app.grid.select(2, 1); app.commit(2, 1, "=ROUND(BaseBudget*AlertLevel*PoliceResponse*2, 0)"); });
await play(1.5);
// 5. Back to the game: faster car, more traffic, more police
await js(() => { app.showSheet("GAME"); app.setMode("sheet"); host.paused = false; game.world.police.lastSeen = game.world.t; });
await play(5);
// 6. Zoom in: every pixel is a cell
await js(() => { app.setMode("grid"); });
await play(0.5);
await play(3, (t) => { app.grid.setZoom(app.grid.zoom * 1.035, 640, 360); app.grid.select(3 + 45, 80); });
// 7. Renderer telemetry
await js(() => { app.showSheet("TELEMETRY"); });
await play(2);
// 8. Seamlessly back to conventional 3D
await js(() => { app.showSheet("GAME"); app.setMode("3d"); game.cinematic = true; });
await play(5);
// 9. The same skill made another game
await open("?res=160x90", "#fieldbook");
await js(() => { app.setMode("sheet"); });
await play(4, (t) => { host.sendInput({ type: "action", action: t % 2 < 1 ? "right" : "down", down: true }); });
await browser.close();
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", `${dir}/f%05d.png`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "dist/demo.mp4"]);
console.log(`dist/demo.mp4: ${n} frames at ${FPS} fps (${(n / FPS).toFixed(1)} s)`);
