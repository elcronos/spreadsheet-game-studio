// Browser evaluations for Gridlock City in the Cellframe shell (Playwright + Chrome).
//   node evals/browser-evals.mjs [baseUrl] [--quick]
// Writes evals/results/browser-evals.json and screenshots to evals/screenshots/.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";

const base = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8091/index.html";
const quick = process.argv.includes("--quick");
mkdirSync("evals/results", { recursive: true });
mkdirSync("evals/screenshots", { recursive: true });
const results = { env: {}, checks: [], perf: [], screenshots: [] };
const check = (id, pass, detail) => {
  results.checks.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
results.env = { browser: browser.version(), renderer: "", cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, platform: `${os.platform()} ${os.release()}`, date: new Date().toISOString(), note: "Headless Chrome on a CPU rasteriser (see renderer string; no GPU). Numbers are a floor, not representative of a GPU." };

async function open(query = "", hash = "", vp = { width: 1280, height: 720 }) {
  const page = await browser.newPage({ viewport: vp });
  // S3 instrumentation: record every image source drawn onto the grid canvas
  await page.addInitScript(() => {
    const orig = CanvasRenderingContext2D.prototype.drawImage;
    window.__gridDrawSources = new Set();
    CanvasRenderingContext2D.prototype.drawImage = function (src, ...rest) {
      if (this.canvas && this.canvas.classList && this.canvas.classList.contains("cf-grid")) window.__gridDrawSources.add(src === window.app?.backend?.store?.bitmap ? "cell-bitmap" : (src && (src.className || src.tagName)) || "unknown");
      return orig.call(this, src, ...rest);
    };
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}${query}${hash}`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  return { page, errors };
}

const shot = async (page, name) => {
  const p = `evals/screenshots/${name}.png`;
  await page.screenshot({ path: p });
  results.screenshots.push(p);
};

// ------------------------------------------------------------------ authenticity
{
  const { page, errors } = await open("?res=160x90");
  results.env.renderer = await page.evaluate(() => {
    const c = document.createElement("canvas").getContext("webgl2");
    const d = c?.getExtension("WEBGL_debug_renderer_info");
    return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  // S1: every cell in the store equals the pipeline's latest frame, and the drawn grid pixel at each sampled cell equals the cell's fill
  await page.evaluate(() => { app.grid.setZoom(Math.max(app.grid.zoom, 1)); app.grid.draw(); });
  const s1 = await page.evaluate(async () => {
    // steady state: no forced keyframe; let adaptive palette rebuilds and diffs run for a while
    const store = app.backend.store;
    const f0 = store.frameId;
    while (store.frameId - f0 < 40) await new Promise((r) => setTimeout(r, 100));
    host.paused = true;
    await new Promise((r) => setTimeout(r, 300));
    app.grid.draw();
    const pipe = host.pipeline["bufA"];
    let storeMatch = 0;
    for (let i = 0; i < store.indices.length; i++) if (store.indices[i] === pipe[i]) storeMatch++;
    // sample drawn pixels
    const g = app.grid.canvas.getContext("2d");
    const dpr = app.grid.canvas.width / app.grid.canvas.clientWidth;
    let drawn = 0, sampled = 0;
    const mism = [];
    for (let k = 0; k < 1000; k++) {
      const x = Math.floor(Math.random() * store.width), y = Math.floor(Math.random() * store.height);
      const rect = app.grid.cellRect(3 + y, x);
      const hud = app.grid.cellRect(2, 0); const top = hud.y + hud.h; // bottom of the frozen HUD rows
      if (rect.x < 50 || rect.y < top || rect.x + rect.w > app.grid.canvas.clientWidth || rect.y + rect.h > app.grid.canvas.clientHeight) continue;
      // skip the selected cell and its neighbours: the selection outline and fill handle are drawn over them
      if (Math.abs(3 + y - app.grid.sel.r) <= 1 && Math.abs(x - app.grid.sel.c) <= 1) continue;
      const c = store.fill(x, y);
      sampled++;
      // five points inside the cell (centre + inset corners) must all show the cell's fill
      let ok = true;
      for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const px = g.getImageData(Math.floor((rect.x + rect.w * fx) * dpr), Math.floor((rect.y + rect.h * fy) * dpr), 1, 1).data;
        if (!(Math.abs(px[0] - ((c >> 16) & 255)) <= 1 && Math.abs(px[1] - ((c >> 8) & 255)) <= 1 && Math.abs(px[2] - (c & 255)) <= 1)) {
          ok = false;
          if (mism.length < 3) mism.push({ x, y, px: [px[0], px[1], px[2]], cell: c.toString(16) });
        }
      }
      if (ok) drawn++;
    }
    host.paused = false;
    return { cells: store.indices.length, storeMatch, sampled, drawn, mism };
  });
  check("S1 cell store == pipeline frame (every cell)", s1.storeMatch === s1.cells, `${s1.storeMatch}/${s1.cells}`);
  check("S1 drawn pixels == cell fill (5 points per sampled cell, steady state, no forced keyframe)", s1.drawn === s1.sampled && s1.sampled > 200, `${s1.drawn}/${s1.sampled} ${JSON.stringify(s1.mism)}`);
  // quantisation fidelity: cell colour vs the RGBA the game rendered
  const q = await page.evaluate(() => {
    const rgba = host["rgba"];
    const st = app.backend.store;
    let err = 0;
    for (let i = 0; i < st.indices.length; i++) {
      const c = st.palette[st.indices[i]];
      const dr = rgba[i * 4] - ((c >> 16) & 255), dg = rgba[i * 4 + 1] - ((c >> 8) & 255), db = rgba[i * 4 + 2] - (c & 255);
      err += Math.sqrt(dr * dr + dg * dg + db * db);
    }
    return err / st.indices.length;
  });
  check("S1 mean colour error, cell vs rendered pixel (RGB distance)", q < 25, q.toFixed(2));
  // S2: click a game cell, name box/formula bar/status show address and colour
  const box = await page.evaluate(() => { const r = app.grid.cellRect(3 + 40, 70); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; });
  const gridBox = await page.locator(".cf-grid").boundingBox();
  await page.mouse.click(gridBox.x + box.x, gridBox.y + box.y);
  await page.waitForTimeout(300);
  const s2 = await page.evaluate(() => ({ name: document.querySelector(".cf-name").value, formula: document.querySelector(".cf-formula").value, status: document.querySelector(".cf-status .sel").textContent, expected: app.backend.store.value(70, 40) }));
  check("S2 selecting a GAME cell shows address and colour", s2.name === "BS44" && /palette index \d+ · #[0-9A-F]{6}/.test(s2.status) && s2.formula !== "", s2);
  // S3: DOM audit in sheet mode
  const s3 = await page.evaluate(() => {
    const vis = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0 && el.offsetParent !== null; };
    const imgs = [...document.querySelectorAll("img,video,iframe")].filter(vis).length;
    const canvases = [...document.querySelectorAll("canvas")].filter(vis).map((c) => c.className || "(none)");
    return { imgs, canvases, directVisible: host.directVisible, view3d: getComputedStyle(document.querySelector(".cf-view3d")).display, gridDrawSources: [...window.__gridDrawSources] };
  });
  check("S3 sheet mode shows no image/video and no WebGL canvas; only the grid", s3.imgs === 0 && s3.canvases.every((c) => c === "cf-grid") && !s3.directVisible && s3.view3d === "none", s3);
  check("S3 the only image ever drawn onto the grid is the cell bitmap (built from the cell store)", s3.gridDrawSources.length > 0 && s3.gridDrawSources.every((x) => x === "cell-bitmap"), s3.gridDrawSources);
  // S4 through the UI: type into WORLD!B (traffic density) and VEHICLES max speed
  const s4 = await page.evaluate(async () => {
    app.showSheet("WORLD");
    const sheet = app.sheets.find((s) => s.name === "WORLD");
    const row = 1 + game.variables.filter((v) => v.sheet === "WORLD").findIndex((v) => v.key === "world.weather");
    const before = host.registry.get("world.weather");
    const err = app.commit(row, 1, "Rain");
    const after = host.registry.get("world.weather");
    const bad = app.commit(row, 1, "Sandstorm");
    const r2 = 1 + game.variables.filter((v) => v.sheet === "WORLD").findIndex((v) => v.key === "world.gravity");
    const badNum = app.commit(r2, 1, "lots");
    return { before, after, err, bad, badNum, sheet: sheet.name };
  });
  check("S4 editing WORLD!Weather changes the simulation", s4.after === "Rain" && s4.err === null, s4);
  check("S6 invalid cell values are rejected with a message", !!s4.bad && !!s4.badNum, { bad: s4.bad, badNum: s4.badNum });
  await page.evaluate(() => app.showSheet("WORLD"));
  await page.waitForTimeout(400);
  await shot(page, "sheet-world-rain");
  // S5 through the UI: formula edits change rule values; unsafe/invalid formulas rejected; game keeps running
  const s5 = await page.evaluate(async () => {
    app.showSheet("RULES");
    const rules = host.registry.snapshot().rules;
    const row = 1 + rules.findIndex((r) => r.name === "TrafficDensity");
    const before = host.registry.rule("TrafficDensity");
    const ok = app.commit(row, 1, "=Population*RushHourMultiplier*2");
    const after = host.registry.rule("TrafficDensity");
    const unsafe = app.commit(row, 1, '=window.alert(1)');
    const cyc = app.commit(1 + rules.findIndex((r) => r.name === "PoliceBudget"), 1, "=PoliceBudget+1");
    const f0 = app.backend.store.frameId;
    await new Promise((r) => setTimeout(r, 1500));
    return { before, after, ok, unsafe, cyc, framesAdvanced: app.backend.store.frameId - f0 };
  });
  check("S5 RULES formula edit changes the value the game uses", s5.ok === null && Math.abs(s5.after - 2 * s5.before) < 1e-6, s5);
  check("S6 unsafe / circular formulas rejected, simulation keeps running", !!s5.unsafe && !!s5.cyc && s5.framesAdvanced > 0, s5);
  // traffic actually responds
  const traffic = await page.evaluate(async () => {
    const count = () => game.world.vehicles.filter((v) => v.driver === "ai" && !v.tag.cop).length;
    const a = count();
    await new Promise((r) => setTimeout(r, 12000));
    return { before: a, after: count(), target: Math.round(26 * host.registry.rule("TrafficDensity")) };
  });
  check("S5 doubled TrafficDensity formula -> more traffic", traffic.after > traffic.before, traffic);
  await page.evaluate(() => app.showSheet("RULES"));
  await page.waitForTimeout(300);
  await shot(page, "sheet-rules-edited");
  check("no page errors (authenticity session)", errors.length === 0, errors.slice(0, 3));
  await page.close();
}

// ------------------------------------------------------------------ performance per resolution
const resList = quick ? ["160x90"] : ["80x45", "160x90", "240x135", "320x180", "480x270"];
for (const preset of ["high", "low"]) {
  for (const res of resList) {
    const q = preset === "low" ? `?res=${res}&bloom=0&shadows=0` : `?res=${res}`;
    const { page } = await open(q);
    const m = await page.evaluate(async () => {
      const sample = async (ms, forceKey) => {
        const times = [];
        let last = performance.now();
        let run = true;
        const tick = (t) => { times.push(t - last); last = t; if (forceKey) host.pipeline.requestKeyframe(); if (run) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        const f0 = app.backend.store.frameId;
        const tel = [];
        const id = setInterval(() => tel.push(host.telemetry()), 500);
        await new Promise((r) => setTimeout(r, ms));
        run = false;
        clearInterval(id);
        const frames = app.backend.store.frameId - f0;
        times.sort((a, b) => a - b);
        const avg = (k) => tel.reduce((s, t) => s + t[k], 0) / Math.max(1, tel.length);
        return {
          fps: +(frames / (ms / 1000)).toFixed(1),
          medianFrameMs: +times[Math.floor(times.length / 2)].toFixed(1),
          p95FrameMs: +times[Math.floor(times.length * 0.95)].toFixed(1),
          readbackMs: +avg("readbackMs").toFixed(2),
          quantizeMs: +avg("quantizeMs").toFixed(3),
          diffMs: +avg("diffMs").toFixed(3),
          presentMs: +avg("presentMs").toFixed(3),
          simMs: +avg("simMs").toFixed(3),
          changedCells: Math.round(avg("changedCells")),
          writtenCells: Math.round(avg("writtenCells")),
          simHz: Math.round(avg("simHz")),
          heapMB: +avg("memoryMB").toFixed(1),
        };
      };
      // drive along the boulevard so the frame changes realistically
      const w = game.world;
      const v = w.vehicles.find((x) => x.kind === "sports");
      w.enterVehicle(v, true);
      v.place(186, 150, Math.PI);
      game.camYaw = Math.PI;
      const keys = window.dispatchEvent.bind(window);
      host.sendInput({ type: "action", action: "up", down: true });
      await new Promise((r) => setTimeout(r, 1500));
      const diff = await sample(5000, false);
      const full = await sample(4000, true);
      host.sendInput({ type: "action", action: "up", down: false });
      return { diff, full };
    });
    const row = { preset, res, cells: res.split("x").reduce((a, b) => a * b, 1), ...m };
    results.perf.push(row);
    console.log("perf", JSON.stringify(row));
    if (preset === "high" && (res === "80x45" || res === "320x180" || res === "480x270")) await shot(page, `sheet-${res}`);
    await page.close();
  }
}

// ------------------------------------------------------------------ scenes
if (!quick) {
  const { page, errors } = await open("?res=240x135");
  const scene = async (name, js, wait = 3500, mode = "3d") => {
    await page.evaluate(js);
    await page.evaluate((m) => app.setMode(m), mode);
    await page.waitForTimeout(wait);
    await shot(page, name);
  };
  await scene("day-exploration", "host.registry.edit('world.time', 10.5); host.registry.edit('world.weather','Clear'); const w=game.world; if (w.playerVehicle) w.exitVehicle(); w.teleport(150, -4); game.camYaw = -Math.PI/2;");
  await scene("character-on-foot", "host.sendInput({type:'action',action:'up',down:true}); setTimeout(()=>host.sendInput({type:'action',action:'up',down:false}), 2500)", 2000);
  await scene("beachfront-driving", "host.registry.edit('world.time', 18.4); const w=game.world; const v=w.spawnParked('sports', 193.8, 120, Math.PI, 0xe53935); w.enterVehicle(v,true); game.camYaw=Math.PI; host.sendInput({type:'action',action:'up',down:true}); setTimeout(()=>host.sendInput({type:'action',action:'up',down:false}), 2500);", 3000);
  await scene("night-neon", "host.registry.edit('world.time', 22.3); const w=game.world; w.playerVehicle.place(150,-86.2,Math.PI/2); game.camYaw=-Math.PI/2+Math.PI; host.sendInput({type:'action',action:'up',down:true}); setTimeout(()=>host.sendInput({type:'action',action:'up',down:false}), 1500);", 3000);
  await scene("police-pursuit", "host.registry.edit('world.time', 21.5); host.registry.edit('player.alert', 3); game.world.police.lastSeen = game.world.t; game.world.playerVehicle.place(108.2,-20,0); game.camYaw=0; host.sendInput({type:'action',action:'up',down:true}); setTimeout(()=>host.sendInput({type:'action',action:'up',down:false}), 4000);", 7000);
  await scene("vehicle-collision", "host.registry.edit('player.alert', 0); host.registry.edit('world.time', 13); const w=game.world; const v=w.playerVehicle; v.place(70,-1.8,-Math.PI/2); const t=w.spawnParked('van', 40,-1.8,-Math.PI/2); game.camYaw=-Math.PI/2; v.vx=-22; host.sendInput({type:'action',action:'up',down:true}); setTimeout(()=>host.sendInput({type:'action',action:'up',down:false}), 1200);", 1600);
  await scene("rain-storm", "host.registry.edit('world.weather','Storm'); host.registry.edit('world.time', 16);", 3000);
  await scene("sheet-night-pursuit", "host.registry.edit('world.weather','Clear'); host.registry.edit('world.time', 21.8); host.registry.edit('player.alert', 2); game.world.police.lastSeen = game.world.t;", 4000, "sheet");
  await scene("sheet-gridlines-zoom", "", 800, "grid");
  await page.evaluate(() => { app.grid.setZoom(app.grid.zoom * 6, 640, 360); app.grid.draw(); });
  await page.waitForTimeout(800);
  await shot(page, "sheet-zoomed-cells");
  await scene("sim-editor", "", 2000, "editor");
  check("no page errors (scene session)", errors.length === 0, errors.slice(0, 3));
  await page.close();
  // Fieldbook in the same shell
  const fb = await open("?res=160x90", "#fieldbook");
  await fb.page.waitForTimeout(2500);
  await shot(fb.page, "fieldbook-sheet");
  await fb.page.evaluate(() => app.setMode("grid"));
  await fb.page.waitForTimeout(1500);
  await shot(fb.page, "fieldbook-gridlines");
  check("Fieldbook runs in the same shell", fb.errors.length === 0 && (await fb.page.evaluate(() => app.backend.store.frameId)) > 10, fb.errors.slice(0, 3));
  await fb.page.close();
  // mobile layout
  const mob = await open("?res=160x90", "", { width: 390, height: 844 });
  await mob.page.waitForTimeout(2000);
  await shot(mob.page, "mobile-sheet");
  check("mobile viewport renders without errors", mob.errors.length === 0, mob.errors.slice(0, 3));
  await mob.page.close();
}

await browser.close();
writeFileSync(quick ? "evals/results/browser-evals-quick.json" : "evals/results/browser-evals.json", JSON.stringify(results, null, 2));
const failed = results.checks.filter((c) => !c.pass).length;
console.log(`\n${results.checks.length - failed}/${results.checks.length} checks passed`);
process.exit(failed ? 1 : 0);
