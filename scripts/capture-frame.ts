// Capture a real Gridlock City frame from the browser build as SGF1 (fixed 64-colour palette)
//   node --import tsx scripts/capture-frame.ts <url> <out.sgf1> [time] [res]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { encodeFrame } from "../renderers/framebuffer/protocol";
import { diffFrames } from "../renderers/framebuffer/diff";
const [url = "http://127.0.0.1:8091/index.html", out = "dist/gridlock-frame.sgf1", time = "18.7", res = "160x90"] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${url}?res=${res}`);
await page.waitForFunction(() => (window as any).ready === true, null, { timeout: 120000 });
const data = await page.evaluate(async (t) => {
  const w = window as any;
  w.host.registry.edit("world.time", +t);
  w.host.pipeline.quantizer.setOptions({ mode: "fixed64" });
  const g = w.game.world; const v = g.vehicles.find((x: any) => x.kind === "sports"); g.enterVehicle(v, true); v.place(193.8, 60, Math.PI); w.game.camYaw = Math.PI;
  await new Promise((r) => setTimeout(r, 4000));
  const st = w.app.backend.store;
  return { w: st.width, h: st.height, indices: Array.from(st.indices as Uint8Array), palette: Array.from(st.palette as Uint32Array) };
}, time);
await browser.close();
const frame = { id: 1, width: data.w, height: data.h, indices: Uint8Array.from(data.indices), palette: Uint32Array.from(data.palette), paletteVersion: 1 };
writeFileSync(out, encodeFrame(frame, diffFrames(null, frame.indices, data.w, data.h), true));
console.log("wrote", out, data.w, "x", data.h, "distinct", new Set(data.indices).size);
