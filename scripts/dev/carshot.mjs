// Close-up of the parked cars for model checks: node scripts/dev/carshot.mjs
import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto("http://127.0.0.1:8091/index.html?mode=3d#quayside");
await page.waitForFunction(() => window.ready === true, null, { timeout: 240000 });
await page.evaluate(() => {
  host.stop();
  game.world.player.x += 40;
  game.runCommand("time-morning");
  game.renderDirect();
  game["updateCamera"] = () => {};
});
const views = process.argv[2] === "side" ? [[1, 0, 7, 1.0], [1, 7, 0, 1.0], [1, 0, -7, 1.0]] : [[0, 4.5, 4.2, 1.5], [1, -4, -3.2, 1.5], [2, 4.5, -4, 1.5]];
for (const [n, [i, dx, dz, hy]] of views.entries()) {
  await page.evaluate(([i, dx, dz, hy]) => {
    const c = game.world.parked[i], cam = game.scene.camera;
    cam.position.set(c.x + dx, hy, c.z + dz);
    cam.lookAt(c.x, 0.6, c.z);
    game.renderDirect(); game.renderDirect();
  }, [i, dx, dz, hy]);
  await page.screenshot({ path: `/tmp/qp-car${n}.png`, clip: { x: 0, y: 160, width: 960, height: 316 } });
}
await browser.close();
