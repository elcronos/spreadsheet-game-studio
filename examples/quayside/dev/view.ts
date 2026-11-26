// Dev viewer for screenshots: /quayside-view.html?cam=x,y,h,yaw,pitch&hour=17.5&ao=1
import * as THREE from "three";
import { QuaysideScene, loadRasterBrowser } from "../src/render/scene";

const q = new URLSearchParams(location.search);
const raster = await loadRasterBrowser("quayside/ground.png");
const canvas = document.getElementById("c") as HTMLCanvasElement;
const s = new QuaysideScene(raster, canvas, { shadows: q.get("shadows") !== "0", bloom: q.get("bloom") !== "0", ao: q.get("ao") === "1", pixelRatio: 1 });
s.setSize(innerWidth, innerHeight);
s.hour = +(q.get("hour") ?? 17.6);
const [x, y, h, yaw, pitch] = (q.get("cam") ?? "-40,180,14,20,-4").split(",").map(Number);
s.camera.position.set(x, h, -y);
const yr = THREE.MathUtils.degToRad(yaw), pr = THREE.MathUtils.degToRad(pitch);
// yaw: 0 = looking north, 90 = east
s.camera.lookAt(x + Math.sin(yr) * Math.cos(pr) * 100, h + Math.sin(pr) * 100, -(y + Math.cos(yr) * Math.cos(pr) * 100));
const focus = new THREE.Vector3(x + Math.sin(yr) * 80, 0, -(y + Math.cos(yr) * 80));
s.update(0.016, focus);
s.render();
(window as unknown as Record<string, unknown>).viewReady = true;
(window as unknown as Record<string, unknown>).s = s;
