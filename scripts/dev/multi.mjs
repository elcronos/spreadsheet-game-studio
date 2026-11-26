// node scripts/dev/multi.mjs <url> <outprefix> <steps.json>  steps: [{js, wait, shot}]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const [url, prefix, stepsFile, w = "1280", h = "720"] = process.argv.slice(2);
const steps = JSON.parse(readFileSync(stepsFile, "utf8"));
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on("pageerror", (e) => logs.push("PAGEERROR " + e.message));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) logs.push("console.error " + m.text()); });
await page.goto(url);
await page.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
for (const s of steps) {
  if (s.js) { const r = await page.evaluate(s.js); if (r !== undefined) console.log(s.shot ?? "", JSON.stringify(r)); }
  if (s.keys) for (const k of s.keys) { if (k.down) await page.keyboard.down(k.down); if (k.up) await page.keyboard.up(k.up); if (k.wait) await page.waitForTimeout(k.wait); }
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.shot) await page.screenshot({ path: `${prefix}${s.shot}.png` });
}
console.log(logs.slice(0, 10).join("\n"));
await browser.close();
