// node scripts/dev/scene.mjs <url> <out.png> <js-to-eval-before> <waitms> [w h]
import { chromium } from "playwright";
const [url, out, js = "", wait = "3000", w = "1280", h = "720"] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on("pageerror", (e) => logs.push("PAGEERROR " + e.message));
page.on("console", (m) => { if (m.type() === "error") logs.push("console.error " + m.text()); });
await page.goto(url);
await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });
if (js) await page.evaluate(js);
await page.waitForTimeout(+wait);
await page.screenshot({ path: out });
console.log(logs.filter(l => !l.includes("404")).slice(0, 10).join("\n"));
console.log(await page.evaluate(() => { const t = window.host.telemetry(); return `fps ${t.gameFps} sim ${t.simHz} render ${t.renderMs.toFixed(0)}ms entities ${t.entities}`; }));
await browser.close();
