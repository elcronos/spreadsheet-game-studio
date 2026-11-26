import { buildCity } from "../../examples/gridlock-city/src/city";
import sharp from "sharp";
const c = buildCity();
console.log("nodes", c.nodes.length, "edges", c.edges.length, "buildings", c.buildings.length, "palms", c.palms.length, "lights", c.streetLights.length, Object.keys(c.pois));
const S = 2, X0 = -210, Z0 = -240, W = 640 * S, H = 680 * S;
const img = Buffer.alloc(W * H * 3, 0);
const put = (x: number, z: number, r: number, g: number, b: number) => { const px = Math.round((x - X0) * S), pz = Math.round((z - Z0) * S); if (px < 0 || pz < 0 || px >= W || pz >= H) return; const o = (pz * W + px) * 3; img[o] = r; img[o + 1] = g; img[o + 2] = b; };
const rect = (r: any, col: number[]) => { for (let x = r.x0; x < r.x1; x += 0.5) for (let z = r.z0; z < r.z1; z += 0.5) put(x, z, col[0], col[1], col[2]); };
rect({ x0: -210, x1: 430, z0: -240, z1: 440 }, [210, 190, 140]);
for (const b of c.blocks) rect(b, [120, 120, 120]);
for (const e of c.edges) for (let i = 1; i < e.pts.length; i++) { const a = e.pts[i - 1], b = e.pts[i]; const L = Math.hypot(b.x - a.x, b.z - a.z); for (let s = 0; s < L; s += 0.5) { const x = a.x + (b.x - a.x) * s / L, z = a.z + (b.z - a.z) * s / L; for (let o = -e.halfWidth; o <= e.halfWidth; o += 0.5) put(x - (b.z - a.z) / L * o, z + (b.x - a.x) / L * o, 50, 50, 55); } }
for (const a of c.alleys) rect(a, [80, 70, 70]);
for (const p of c.parking) rect(p, [70, 70, 90]);
for (const b of c.buildings) rect({ x0: b.x - b.w / 2, x1: b.x + b.w / 2, z0: b.z - b.d / 2, z1: b.z + b.d / 2 }, [(b.colour >> 16) & 255, (b.colour >> 8) & 255, b.colour & 255]);
for (const b of c.barriers) rect(b, [255, 0, 0]);
for (const p of c.palms) rect({ x0: p.x - 1, x1: p.x + 1, z0: p.z - 1, z1: p.z + 1 }, [0, 200, 0]);
for (const p of Object.values(c.pois)) rect({ x0: p.x - 3, x1: p.x + 3, z0: p.z - 3, z1: p.z + 3 }, [255, 0, 255]);
rect({ x0: 272, x1: 430, z0: -240, z1: 440 }, [30, 90, 160]); rect({ x0: -210, x1: 430, z0: 292, z1: 440 }, [30, 90, 160]); rect(c.pier, [140, 100, 60]);
await sharp(img, { raw: { width: W, height: H, channels: 3 } }).png().toFile("/tmp/sgs/map.png");
