// End-to-end: the built Sidebar.html in headless Chrome, google.script.run wired to Code.gs running
// against the in-memory Apps Script stand-in. Optional artificial latency: node ... e2e.mjs [latencyMs]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const { loadCodeGs } = await import("./fake-apps-script.ts");
const latency = +(process.argv[2] ?? 0);
const g = loadCodeGs();
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const page = await browser.newPage({ viewport: { width: 300, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
await page.exposeFunction("__gas", async (fn, arg) => {
  await new Promise((r) => setTimeout(r, latency));
  return JSON.parse(JSON.stringify(g.api[fn](JSON.parse(JSON.stringify(arg)))));
});
await page.addInitScript(() => {
  const mk = (ok, fail) => new Proxy({}, { get: (_t, name) => name === "withSuccessHandler" ? (f) => mk(f, fail) : name === "withFailureHandler" ? (f) => mk(ok, f) : (arg) => window.__gas(name, arg).then(ok, fail) });
  window.google = { script: { run: mk(() => {}, () => {}) } };
});
await page.goto("file://" + process.cwd() + "/dist/gsheets/Sidebar.html");
await page.click(".start");
await page.waitForFunction(() => window.sgs && window.sgs.backend.stats().presentedFps >= 0, null, { timeout: 30000 }).catch(async (e) => { console.log("status:", await page.textContent(".status"), "errors:", errors); throw e; });
const results = [];
const check = (id, pass, detail) => { results.push({ id, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${JSON.stringify(detail)}`); };
await page.waitForTimeout(3000);
// walk right for 2 s
const p0 = await page.evaluate(() => ({ x: sgs.game.sim.farmer.x, y: sgs.game.sim.farmer.y }));
await page.keyboard.down("KeyD"); await page.waitForTimeout(2500); await page.keyboard.up("KeyD");
await page.waitForTimeout(2500);
const p1 = await page.evaluate(() => ({ x: sgs.game.sim.farmer.x, y: sgs.game.sim.farmer.y }));
check("keyboard in the sidebar moves the farmer", p1.x > p0.x, { p0, p1 });
// the GAME sheet's cell colours equal what the backend last sent
const shown = await page.evaluate(() => Array.from(sgs.backend["shown"] ?? []));
const game = g.sheets.get("GAME");
let match = 0;
for (let y = 0; y < 45; y++) for (let x = 0; x < 80; x++) if (game.cell(4 + y, 1 + x).bg === "#" + (shown[y * 80 + x] >>> 0).toString(16).padStart(6, "0")) match++;
check("every GAME cell background equals the frame the game sent (80x45)", match === 3600, `${match}/3600`);
const distinct = new Set([...game.cells.values()].map((c) => c.bg)).size;
check("the sheet holds a real picture", distinct > 20, `${distinct} distinct fills`);
// player edits a FARMER value in the sheet
const farmer = g.sheets.get("FARMER");
const keys = JSON.parse(g.ss.getSheetByName ? "null" : "null");
const lay = await page.evaluate(() => sgs.game.variables.filter((v) => v.sheet === "FARMER").map((v) => v.key));
const iWalk = lay.findIndex((k) => /walk/i.test(k));
farmer.cell(2 + iWalk, 2).v = 2.5;
await page.waitForTimeout(3000);
const walk = await page.evaluate((k) => sgs.host.registry.get(k), lay[iWalk]);
check("editing FARMER walk speed in the sheet changes the game", walk === 2.5, { key: lay[iWalk], walk });
// invalid value is rejected and the sheet is put back
farmer.cell(2 + iWalk, 2).v = "fast";
await page.waitForTimeout(3500);
const after = { game: await page.evaluate((k) => sgs.host.registry.get(k), lay[iWalk]), sheet: farmer.cell(2 + iWalk, 2).v, status: await page.textContent(".status") };
check("invalid sheet value rejected; game keeps 2.5 and the sheet is restored", after.game === 2.5 && String(after.sheet) === "2.5" && /Rejected/.test(after.status), after);
// RULES formula edit
const rules = g.sheets.get("RULES");
const rnames = await page.evaluate(() => sgs.host.registry.ruleDefs().map((r) => r.name));
const ip = rnames.indexOf("Price_Carrot");
rules.cell(2 + ip, 2).f = "=BasePrice_Carrot*3";
await page.waitForTimeout(3000);
const price = await page.evaluate(() => ({ v: sgs.host.registry.rule("Price_Carrot"), base: sgs.host.registry.num(sgs.game.variables.find((v) => v.name === "BasePrice_Carrot").key) }));
check("editing a RULES formula in the sheet changes the game's price", Math.abs(price.v - price.base * 3) < 1e-6, price);
check("RULES column C shows the value the game uses", Number(rules.cell(2 + ip, 3).v) === price.v, { sheet: rules.cell(2 + ip, 3).v });
const st = await page.evaluate(() => ({ ...sgs.backend.stats(), cells: sgs.backend.lastCells, applyMs: sgs.backend.lastApplyMs }));
check("no page errors", errors.length === 0, errors.slice(0, 3));
console.log("stats", JSON.stringify({ latencyMs: latency, ...st }));
await page.screenshot({ path: "evals/screenshots/gsheets-sidebar.png" });
{ const fills = []; for (let y = 0; y < 45; y++) { const row = []; for (let x = 0; x < 80; x++) row.push(game.cell(4 + y, 1 + x).bg); fills.push(row); } (await import("node:fs")).writeFileSync("evals/results/gsheets-game-fills.json", JSON.stringify(fills)); }
await browser.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
