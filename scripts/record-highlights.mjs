// Highlights video: the best scenes of Gridlock City and Fieldbook, title cards, and stills
// from a real Google Sheet. Each game scene is driven on a fixed simulated clock
// (host.frame(t) per video frame), so playback is smooth however slow the machine is.
//   npm run build && node scripts/serve.mjs dist 8091 &   then   node scripts/record-highlights.mjs
// Output: dist/highlights.mp4 and docs/media/highlights.gif (needs ffmpeg).
// RESUME=1 keeps finished scene clips in dist/hl and only records the missing ones.
import { chromium } from "playwright";
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const URL0 = process.env.URL ?? "http://127.0.0.1:8091/index.html";
const FPS = 24;
const OUT = "dist/hl";
if (!process.env.RESUME) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync("docs/media", { recursive: true });
const ff = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS)];

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const clips = [];
let seg = null, n = 0, clock = 0;

/** True (and the clip is queued) when RESUME is set and this scene was already recorded. */
function done(name) {
  const file = `${OUT}/${name}.mp4`;
  if (process.env.RESUME && existsSync(file)) {
    clips.push(file);
    return true;
  }
  rmSync(`${OUT}/${name}`, { recursive: true, force: true });
  return false;
}
function begin(name) {
  seg = `${OUT}/${name}`;
  mkdirSync(seg, { recursive: true });
  n = 0;
}
async function end() {
  const file = `${seg}.mp4`;
  ff("-framerate", String(FPS), "-i", `${seg}/f%05d.png`, ...enc, file);
  clips.push(file);
  console.log(`${file}: ${(n / FPS).toFixed(1)} s`);
}
async function open(q, hash = "") {
  await page.goto(`${URL0}${q}${hash}`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 120000 });
  await page.evaluate(() => {
    host.stop();
    window.__t = performance.now();
  });
  clock = 0;
}
async function play(secs, each) {
  const frames = Math.round(secs * FPS);
  for (let i = 0; i < frames; i++) {
    if (each) await page.evaluate(each, i / FPS);
    clock += 1000 / FPS;
    await page.evaluate((t) => host.frame(window.__t + t), clock);
    await page.screenshot({ path: `${seg}/f${String(n++).padStart(5, "0")}.png` });
  }
}
const js = (fn, arg) => page.evaluate(fn, arg);

/** A title card as a still clip. */
async function card(name, title, sub, secs = 2.6) {
  const html = `<!doctype html><html><body style="margin:0;width:1280px;height:720px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 40%,#22301b,#0e130c 70%);font-family:Inter,Roboto,Arial,sans-serif;color:#f3f7ee">
  <div style="font-size:64px;font-weight:800;letter-spacing:-1px;text-align:center;max-width:1100px;line-height:1.05">${title}</div>
  <div style="margin-top:22px;font-size:28px;color:#b9d8a0;text-align:center;max-width:1000px;line-height:1.3">${sub}</div>
  <div style="position:absolute;bottom:28px;font-size:18px;color:#6f8a5d">Spreadsheet Game Studio</div></body></html>`;
  await page.setContent(html);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const file = `${OUT}/${name}.mp4`;
  ff("-loop", "1", "-t", String(secs), "-i", `${OUT}/${name}.png`, "-vf", "fade=in:0:8,fade=out:st=" + (secs - 0.35) + ":d=0.35", ...enc, file);
  clips.push(file);
}

/** Slow pan and zoom over a still image (for the real Google Sheets captures). */
function still(name, img, secs = 3, zoomTo = 1.12) {
  const file = `${OUT}/${name}.mp4`;
  const frames = Math.round(secs * FPS);
  ff("-loop", "1", "-i", img, "-vf", `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x0e130c,scale=2560:1440,zoompan=z='1+(${zoomTo}-1)*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1280x720:fps=${FPS},fade=in:0:6,fade=out:st=${secs - 0.3}:d=0.3`, "-t", String(secs), ...enc, file);
  clips.push(file);
}

// ---------------------------------------------------------------------------------------
await card("c0", "Every pixel is a spreadsheet cell", "Two original games, playable in a browser grid, in Excel and in Google Sheets", 3.2);

// Gridlock City -------------------------------------------------------------------------
await card("c1", "Gridlock City", "An open world driving game in the spirit of early 2000s classics, with original art", 2.4);
if (!done("g1")) {
begin("g1");
await open("?res=160x90&autostart=0");
await js(() => { host.registry.edit("world.time", 17.2); app.start(); host.stop(); });
await play(0.8, () => { app.grid.reveal = 0; });
await play(1.6, (t) => { app.grid.reveal = Math.min(1, t / 1.4); });
await js(() => { const w = game.world; const v = w.spawnParked("sports", 175, -1.8, -Math.PI / 2, 0xe53935); w.player.x = 177; w.player.z = 2; w.enterVehicle(v); app.setMode("3d"); host.registry.edit("player.invincible", true); game.runCommand("autodrive"); });
await play(4.5);
// sunset into night, police on our tail
await js(() => { host.registry.edit("player.alert", 3); game.world.police.lastSeen = game.world.t; host.registry.edit("world.timeScale", 0); host.registry.edit("world.time", 19.4); });
await play(4, (t) => host.registry.edit("world.time", 19.4 + t * 0.6));
// storm
await js(() => { host.registry.edit("world.weather", "Storm"); });
await play(3);
await js(() => { host.registry.edit("world.weather", "Clear"); host.registry.edit("world.time", 21.5); });
// the same chase, as cells
await js(() => app.setMode("sheet"));
await play(3);
// zoom into the cells
await js(() => app.setMode("grid"));
await play(2.6, () => { app.grid.setZoom(app.grid.zoom * 1.04, 640, 360); });
await end();
}

if (!done("g2")) {
begin("g2");
// tune the world from its worksheets
await js(() => { host.paused = true; app.setMode("sheet"); app.grid.setZoom(1, 640, 360); app.showSheet("VEHICLES"); app.grid.select(1, 1); });
await play(1.2);
await js(() => { app.commit(1, 1, "320"); app.showSheet("RULES"); app.grid.select(2, 1); });
await play(1.0);
await js(() => app.commit(2, 1, "=ROUND(BaseBudget*AlertLevel*PoliceResponse*2, 0)"));
await play(1.4);
await js(() => { app.showSheet("GAME"); app.setMode("3d"); host.paused = false; host.registry.edit("world.time", 13); game.cinematic = true; });
await play(4);
await end();
}

// Fieldbook -------------------------------------------------------------------------------
await card("c2", "Fieldbook", "A farming sim from the same studio. Prices are spreadsheet formulas", 2.4);
if (!done("f1")) {
begin("f1");
await open("?res=160x90", "#fieldbook");
await js(() => {
  const s = game.sim;
  const rows = [[8, "carrot", [1, 1, 1, 1, 0.7, 0.4, 0.4]], [9, "cabbage", [0.8, 0.8, 0.6, 0.3, 0.3]], [10, "tomato", [0.35, 0.35, 0.2, 0]]];
  for (const [ty, crop, gr] of rows) gr.forEach((g, i) => s.stagePlot(3 + i, ty, crop, g, i % 2 === 0));
  s.teleport(7, 7, "down");
  app.setMode("3d");
});
const key = (action, down) => js(([action, down]) => host.sendInput({ type: "action", action, down }), [action, down]);
await play(1.2);
await key("down", true); await play(0.5); await key("down", false);
await key("use", true); await play(0.2); await key("use", false);
await play(0.8);
await key("right", true); await play(1.2); await key("right", false);
await key("use", true); await play(0.2); await key("use", false);
await play(1.2);
// evening, then the farm as a sheet
await js(() => host.registry.edit("farm.hour", 19.3));
await play(2);
await js(() => app.setMode("sheet"));
await play(2.4);
await js(() => app.setMode("grid"));
await play(2.2, () => { app.grid.setZoom(app.grid.zoom * 1.03, 640, 360); });
await js(() => { app.grid.setZoom(1, 640, 360); app.setMode("3d"); host.registry.edit("farm.season", "Winter"); host.registry.edit("farm.hour", 12); });
await play(2.4);
await end();
}

// Real Google Sheets stills -------------------------------------------------------------------
const shots = (process.env.GSHEETS_SHOTS ?? "docs/media/gsheets-1.png,docs/media/gsheets-2.png,docs/media/gsheets-3.png").split(",").filter((p) => existsSync(p));
if (shots.length) {
  await card("c3", "Now in Google Sheets", "The whole game runs in the sheet's own script. Tap a box, play a move. Works on phones", 2.6);
  shots.forEach((p, i) => still(`s${i}`, p, 3, 1.1));
}

await card("c9", "github.com/elcronos/spreadsheet-game-studio", "A skill for building spreadsheet games, plus a skill to port them to Google Sheets", 3.4);
await browser.close();

// join (all clips share size, fps and pixel format)
writeFileSync(`${OUT}/list.txt`, clips.map((c) => `file '${c.replace(`${OUT}/`, "")}'`).join("\n"));
ff("-f", "concat", "-safe", "0", "-i", `${OUT}/list.txt`, ...enc, "-movflags", "+faststart", "dist/highlights.mp4");
// README preview: 12 s of game footage as a small GIF
execFileSync("cp", ["dist/highlights.mp4", "docs/media/highlights.mp4"]);
ff("-ss", "6", "-t", "12", "-i", "dist/highlights.mp4", "-vf", "fps=12,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", "docs/media/highlights.gif");
const total = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "dist/highlights.mp4"]).toString().trim();
console.log(`dist/highlights.mp4 ${(+total).toFixed(1)} s, docs/media/highlights.gif`);
void readdirSync;
