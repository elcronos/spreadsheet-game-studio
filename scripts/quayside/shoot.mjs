// node scripts/quayside/shoot.mjs name "cam" hour [extra query]
import { chromium } from "playwright";
const [name, cam, hour = "17.6", extra = ""] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:8091/quayside-view.html?cam=${cam}&hour=${hour}${extra}`);
await page.waitForFunction(() => window.viewReady === true, null, { timeout: 180000 }).catch(() => {});
await page.evaluate(() => { s.update(0.016, s.camera.position.clone()); s.render(); s.render(); });
await page.screenshot({ path: `/tmp/q-${name}.png` });
console.log(name, Date.now() - t0, "ms", errs.slice(0, 3));
await browser.close();
