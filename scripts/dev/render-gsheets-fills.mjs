import sharp from "sharp"; import { readFileSync } from "node:fs";
const f = JSON.parse(readFileSync("evals/results/gsheets-game-fills.json")); const S = 9, W = 80 * S + 1, H = 45 * S + 1;
const buf = Buffer.alloc(W * H * 3, 0xe2);
for (let y = 0; y < 45; y++) for (let x = 0; x < 80; x++) { const c = parseInt(f[y][x].slice(1), 16); for (let j = 1; j < S; j++) for (let i = 1; i < S; i++) { const o = ((y * S + j) * W + x * S + i) * 3; buf[o] = c >> 16; buf[o + 1] = (c >> 8) & 255; buf[o + 2] = c & 255; } }
await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toFile("evals/screenshots/gsheets-game-cells.png");
