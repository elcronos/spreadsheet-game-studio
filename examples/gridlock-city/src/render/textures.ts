/**
 * Procedurally painted textures (original, generated at load time; no
 * external image assets). Retro resolution, crisp but filtered.
 */
import * as THREE from "three";

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

let seed = 99;
export function rnd(): number {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function tex(c: HTMLCanvasElement, repeat = true, nearest = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (nearest) t.magFilter = THREE.NearestFilter;
  return t;
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, amt: number, size = 1): void {
  const d = ctx.getImageData(0, 0, w, h);
  for (let y = 0; y < h; y += size)
    for (let x = 0; x < w; x += size) {
      const n = (rnd() - 0.5) * amt;
      for (let yy = 0; yy < size; yy++)
        for (let xx = 0; xx < size; xx++) {
          const o = ((y + yy) * w + x + xx) * 4;
          d.data[o] += n;
          d.data[o + 1] += n;
          d.data[o + 2] += n;
        }
    }
  ctx.putImageData(d, 0, 0);
}

export function asphalt(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = "#3b3e44";
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 18; i++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? "30,32,36" : "70,72,78"},${0.15 + rnd() * 0.2})`;
    const x = rnd() * 256, y = rnd() * 256;
    g.beginPath();
    g.ellipse(x, y, 10 + rnd() * 40, 6 + rnd() * 20, rnd() * 3, 0, 7);
    g.fill();
  }
  g.strokeStyle = "rgba(20,20,22,0.55)";
  g.lineWidth = 1;
  for (let i = 0; i < 7; i++) {
    let x = rnd() * 256, y = rnd() * 256;
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += (rnd() - 0.5) * 30;
      y += (rnd() - 0.5) * 30;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  noise(g, 256, 256, 26);
  return tex(c);
}

export function pavement(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = "#b9b3a8";
  g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      const v = 175 + rnd() * 25;
      g.fillStyle = `rgb(${v},${v - 4},${v - 12})`;
      g.fillRect(x * 32 + 1, y * 32 + 1, 30, 30);
    }
  noise(g, 128, 128, 18);
  return tex(c);
}

export function promenade(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  // pastel terrazzo waves
  g.fillStyle = "#efd9c3";
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "#e6a7a0";
  g.lineWidth = 6;
  for (let k = -1; k < 4; k++) {
    g.beginPath();
    for (let x = 0; x <= 128; x += 4) g.lineTo(x, k * 40 + 20 + Math.sin((x / 128) * Math.PI * 2) * 10);
    g.stroke();
  }
  noise(g, 128, 128, 14);
  return tex(c);
}

export function sand(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = "#d6bd88";
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = "rgba(160,130,80,0.18)";
  for (let i = 0; i < 40; i++) {
    const y = rnd() * 256;
    g.beginPath();
    for (let x = 0; x <= 256; x += 8) g.lineTo(x, y + Math.sin(x * 0.05 + i) * 3);
    g.stroke();
  }
  noise(g, 256, 256, 22);
  return tex(c);
}

export function grass(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = "#5f9b45";
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = rnd() < 0.5 ? "rgba(70,120,50,0.6)" : "rgba(140,190,90,0.5)";
    g.fillRect(rnd() * 128, rnd() * 128, 1, 2 + rnd() * 3);
  }
  noise(g, 128, 128, 14);
  return tex(c);
}

export function wood(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  for (let i = 0; i < 8; i++) {
    const v = 120 + rnd() * 40;
    g.fillStyle = `rgb(${v},${v * 0.72},${v * 0.48})`;
    g.fillRect(0, i * 16, 128, 15);
    g.fillStyle = "rgba(40,25,10,0.6)";
    g.fillRect(0, i * 16 + 15, 128, 1);
    g.fillRect(((i * 37) % 128) | 0, i * 16, 1, 15);
  }
  noise(g, 128, 128, 16);
  return tex(c);
}

export function roof(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = "#8b8780";
  g.fillRect(0, 0, 128, 128);
  noise(g, 128, 128, 40, 2);
  g.strokeStyle = "rgba(60,58,55,0.5)";
  for (let i = 0; i < 128; i += 32) {
    g.beginPath();
    g.moveTo(0, i);
    g.lineTo(128, i);
    g.stroke();
  }
  return tex(c);
}

export function concrete(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = "#a8a49c";
  g.fillRect(0, 0, 128, 128);
  noise(g, 128, 128, 26, 2);
  return tex(c);
}

/**
 * Facade atlas: 4×4 cells of 128 px. Cells 0-3 upper windows (dark), 4-7 the
 * same windows lit, 8-11 ground floor fronts, 12-15 plain/variant walls.
 * Returns diffuse and emissive atlases.
 */
export type FacadeStyle = "deco" | "glass" | "apartment" | "shop" | "warehouse" | "house" | "club" | "office" | "hotelTower" | "garage" | "gas";

const CELL = 128;

function windowCell(g: CanvasRenderingContext2D, e: CanvasRenderingContext2D, cx: number, cy: number, style: FacadeStyle, lit: boolean, variant: number): void {
  const x0 = cx * CELL, y0 = cy * CELL;
  // wall (white, tinted by vertex colour)
  g.fillStyle = style === "glass" ? "#9fb4c6" : style === "warehouse" || style === "garage" ? "#d8d2c8" : "#f4f1ec";
  g.fillRect(x0, y0, CELL, CELL);
  e.fillStyle = "#000";
  e.fillRect(x0, y0, CELL, CELL);
  const warm = ["#ffd9a0", "#ffe7b8", "#fff1d0", "#ffc98a", "#bfe3ff"][variant % 5];
  const drawWin = (x: number, y: number, w: number, h: number, frame: string, glass: string) => {
    g.fillStyle = frame;
    g.fillRect(x0 + x - 3, y0 + y - 3, w + 6, h + 6);
    const gr = g.createLinearGradient(0, y0 + y, 0, y0 + y + h);
    gr.addColorStop(0, lit ? "#f6d9a8" : glass);
    gr.addColorStop(1, lit ? "#c9905a" : "#1c2a38");
    g.fillStyle = gr;
    g.fillRect(x0 + x, y0 + y, w, h);
    if (!lit) {
      g.fillStyle = "rgba(255,255,255,0.18)";
      g.beginPath();
      g.moveTo(x0 + x, y0 + y + h * 0.6);
      g.lineTo(x0 + x + w * 0.5, y0 + y);
      g.lineTo(x0 + x + w * 0.7, y0 + y);
      g.lineTo(x0 + x, y0 + y + h);
      g.fill();
    }
    if (lit) {
      e.fillStyle = warm;
      e.fillRect(x0 + x, y0 + y, w, h);
      // curtains / silhouettes
      g.fillStyle = "rgba(90,50,30,0.35)";
      g.fillRect(x0 + x, y0 + y, w * 0.22, h);
      e.fillStyle = "rgba(40,20,10,0.7)";
      e.fillRect(x0 + x, y0 + y, w * 0.22, h);
      if (variant % 2) {
        e.fillRect(x0 + x + w * 0.55, y0 + y + h * 0.45, w * 0.18, h * 0.55);
      }
    }
  };
  switch (style) {
    case "glass":
    case "office": {
      const glass = style === "glass" ? "#3b5a78" : "#4d6070";
      g.fillStyle = style === "glass" ? "#7f95a8" : "#e9e5de";
      g.fillRect(x0, y0, CELL, CELL);
      for (let i = 0; i < 2; i++) drawWin(10 + i * 60, style === "glass" ? 12 : 30, 48, style === "glass" ? 100 : 64, style === "glass" ? "#5d7286" : "#cfc9c0", glass);
      g.fillStyle = "rgba(0,0,0,0.18)";
      g.fillRect(x0, y0 + 118, CELL, 10);
      break;
    }
    case "deco":
    case "hotelTower": {
      drawWin(22, 34, 84, 58, "#2fa6a0", "#29506b");
      // eyebrow ledge with shadow
      g.fillStyle = "#ffffff";
      g.fillRect(x0, y0 + 18, CELL, 8);
      g.fillStyle = "rgba(0,0,0,0.28)";
      g.fillRect(x0, y0 + 26, CELL, 6);
      // speed lines
      g.fillStyle = "rgba(0,0,0,0.08)";
      for (let i = 0; i < 3; i++) g.fillRect(x0 + 6, y0 + 104 + i * 6, CELL - 12, 2);
      break;
    }
    case "apartment":
    case "house": {
      drawWin(30, 26, 68, 66, "#ffffff", "#2a3e52");
      g.fillStyle = "rgba(0,0,0,0.25)";
      g.fillRect(x0 + 24, y0 + 98, 80, 6);
      if (variant % 2 === 0) {
        // balcony railing
        g.fillStyle = "#e9e9e9";
        g.fillRect(x0 + 14, y0 + 92, 100, 4);
        for (let i = 0; i < 12; i++) g.fillRect(x0 + 16 + i * 8, y0 + 96, 2, 24);
        g.fillStyle = "rgba(0,0,0,0.2)";
        g.fillRect(x0 + 14, y0 + 120, 100, 4);
      } else {
        // AC unit
        g.fillStyle = "#cfd4d6";
        g.fillRect(x0 + 84, y0 + 100, 26, 18);
        g.fillStyle = "#8a9093";
        for (let i = 0; i < 4; i++) g.fillRect(x0 + 86, y0 + 103 + i * 4, 22, 1);
      }
      break;
    }
    case "warehouse":
    case "garage": {
      g.fillStyle = "rgba(0,0,0,0.12)";
      for (let i = 0; i < CELL; i += 8) g.fillRect(x0 + i, y0, 2, CELL);
      if (variant % 2 === 0) drawWin(20, 20, 88, 22, "#7d8a90", "#33434d");
      break;
    }
    case "club": {
      g.fillStyle = "#3a3448";
      g.fillRect(x0, y0, CELL, CELL);
      drawWin(34, 30, 60, 50, "#1d1a26", "#1a1430");
      // neon band
      const col = ["#ff2fa8", "#22e6ff", "#ffd23f", "#9d4dff"][variant % 4];
      g.fillStyle = col;
      g.fillRect(x0, y0 + 108, CELL, 5);
      e.fillStyle = col;
      e.fillRect(x0, y0 + 106, CELL, 9);
      break;
    }
    case "shop":
    case "gas": {
      drawWin(26, 28, 76, 60, "#ffffff", "#2d4256");
      break;
    }
  }
}

function storefront(g: CanvasRenderingContext2D, e: CanvasRenderingContext2D, cx: number, cy: number, variant: number, style: FacadeStyle): void {
  const x0 = cx * CELL, y0 = cy * CELL;
  g.fillStyle = style === "warehouse" || style === "garage" ? "#cfc8bd" : "#efe9df";
  g.fillRect(x0, y0, CELL, CELL);
  e.fillStyle = "#000";
  e.fillRect(x0, y0, CELL, CELL);
  if (style === "warehouse" || style === "garage") {
    // roller door
    g.fillStyle = "#8f979b";
    g.fillRect(x0 + 12, y0 + 30, 104, 98);
    g.fillStyle = "rgba(0,0,0,0.25)";
    for (let i = 0; i < 24; i++) g.fillRect(x0 + 12, y0 + 32 + i * 4, 104, 1);
    g.fillStyle = "#f0c419";
    g.fillRect(x0 + 12, y0 + 24, 104, 6);
    return;
  }
  if (style === "glass" || style === "office") {
    g.fillStyle = "#26323d";
    g.fillRect(x0 + 6, y0 + 20, 116, 108);
    g.fillStyle = "#c8d0d6";
    for (let i = 0; i < 4; i++) g.fillRect(x0 + 6 + i * 38, y0 + 20, 3, 108);
    e.fillStyle = "#cfe8ff";
    e.globalAlpha = 0.55;
    e.fillRect(x0 + 9, y0 + 26, 110, 100);
    e.globalAlpha = 1;
    return;
  }
  // shop window + door
  const door = variant % 2 === 0;
  g.fillStyle = "#1f2b36";
  g.fillRect(x0 + 8, y0 + 34, door ? 80 : 112, 80);
  const inside = ["#ffd9a0", "#ffe9c4", "#c4f0ff", "#ffc0de"][variant % 4];
  e.fillStyle = inside;
  e.globalAlpha = 0.85;
  e.fillRect(x0 + 10, y0 + 36, door ? 76 : 108, 76);
  e.globalAlpha = 1;
  // goods on shelves
  for (let i = 0; i < 6; i++) {
    g.fillStyle = ["#e57373", "#64b5f6", "#ffd54f", "#81c784"][i % 4];
    g.fillRect(x0 + 14 + i * 12, y0 + 92, 8, 14);
  }
  g.fillStyle = "rgba(255,255,255,0.2)";
  g.fillRect(x0 + 10, y0 + 36, 12, 76);
  if (door) {
    g.fillStyle = "#3e2723";
    g.fillRect(x0 + 94, y0 + 40, 26, 88);
    g.fillStyle = "#ffcc80";
    g.fillRect(x0 + 115, y0 + 84, 3, 6);
  }
  // kick plate
  g.fillStyle = "#6d6a66";
  g.fillRect(x0, y0 + 114, CELL, 14);
}

export interface FacadeAtlas {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
}

export function facadeAtlas(style: FacadeStyle): FacadeAtlas {
  const [c, g] = canvas(CELL * 4, CELL * 4);
  const [ce, e] = canvas(CELL * 4, CELL * 4);
  for (let i = 0; i < 4; i++) windowCell(g, e, i, 0, style, false, i);
  for (let i = 0; i < 4; i++) windowCell(g, e, i, 1, style, true, i);
  for (let i = 0; i < 4; i++) storefront(g, e, i, 2, i, style);
  for (let i = 0; i < 4; i++) {
    // plain wall / pilaster cells
    g.fillStyle = style === "glass" ? "#8fa2b3" : style === "club" ? "#3a3448" : "#f2eee8";
    g.fillRect(i * CELL, 3 * CELL, CELL, CELL);
    g.fillStyle = "rgba(0,0,0,0.07)";
    g.fillRect(i * CELL, 3 * CELL + CELL - 10, CELL, 10);
    e.fillStyle = "#000";
    e.fillRect(i * CELL, 3 * CELL, CELL, CELL);
  }
  noise(g, CELL * 4, CELL * 4, 10);
  const map = tex(c, false);
  const emissive = tex(ce, false);
  map.generateMipmaps = emissive.generateMipmaps = true;
  return { map, emissive };
}

/** Sign atlas: each sign text drawn once; returns UV rects. */
export class SignAtlas {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private x = 0;
  private y = 0;
  private rowH = 0;
  readonly texture: THREE.CanvasTexture;
  constructor(readonly size = 2048) {
    [this.canvas, this.g] = canvas(size, size);
    this.g.fillStyle = "#000";
    this.g.fillRect(0, 0, size, size);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
  }
  /** Draw neon text; returns uv rect [u0,v0,u1,v1] and aspect (w/h). */
  add(text: string, colour: number, vertical: boolean, script = false): { uv: [number, number, number, number]; aspect: number } {
    const g = this.g;
    const fs = 44;
    const font = script ? `italic 700 ${fs}px "Trebuchet MS", sans-serif` : `800 ${fs}px "Arial Black", "Arial", sans-serif`;
    g.font = font;
    const css = "#" + colour.toString(16).padStart(6, "0");
    let w: number, h: number;
    if (vertical) {
      w = fs + 24;
      h = text.length * (fs * 0.95) + 24;
    } else {
      w = g.measureText(text).width + 36;
      h = fs + 28;
    }
    w = Math.ceil(w);
    h = Math.ceil(h);
    if (this.x + w > this.size) {
      this.x = 0;
      this.y += this.rowH + 4;
      this.rowH = 0;
    }
    const x = this.x, y = this.y;
    this.x += w + 4;
    this.rowH = Math.max(this.rowH, h);
    // tube outline + glow
    g.save();
    g.strokeStyle = css;
    g.lineWidth = 3;
    g.strokeRect(x + 4, y + 4, w - 8, h - 8);
    g.shadowColor = css;
    g.shadowBlur = 14;
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    if (vertical) {
      for (let i = 0; i < text.length; i++) g.fillText(text[i], x + w / 2, y + 12 + fs * 0.5 + i * fs * 0.95);
    } else g.fillText(text, x + w / 2, y + h / 2 + 2);
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = css;
    g.globalAlpha = 0.55;
    g.fillRect(x, y, w, h);
    g.restore();
    const s = this.size;
    return { uv: [x / s, 1 - (y + h) / s, (x + w) / s, 1 - y / s], aspect: w / h };
  }
}

export function stripes(a: string, b: string): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? a : b;
    g.fillRect(i * 8, 0, 8, 64);
  }
  g.fillStyle = "rgba(0,0,0,0.25)";
  g.fillRect(0, 56, 64, 8);
  return tex(c);
}

export function frond(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 64);
  g.clearRect(0, 0, 128, 64);
  // a palm leaf: central rib with leaflets
  g.strokeStyle = "#3b6b2a";
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(0, 32);
  g.quadraticCurveTo(64, 26, 128, 34);
  g.stroke();
  for (let i = 4; i < 124; i += 5) {
    const len = 26 * Math.sin((i / 128) * Math.PI) + 4;
    const y = 32 - 6 * Math.sin((i / 128) * Math.PI);
    g.strokeStyle = i % 2 ? "#4f8a34" : "#6aa543";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(i, y);
    g.lineTo(i + 8, y - len);
    g.moveTo(i, y);
    g.lineTo(i + 8, y + len);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function radialGlow(inner = "rgba(255,220,170,1)", outer = "rgba(255,200,140,0)", soft = false): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, inner);
  if (soft) {
    gr.addColorStop(0.35, inner.replace(/[\d.]+\)$/, "0.35)"));
    gr.addColorStop(0.7, inner.replace(/[\d.]+\)$/, "0.08)"));
  }
  gr.addColorStop(1, outer);
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function cloudTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(512, 512);
  g.clearRect(0, 0, 512, 512);
  for (let i = 0; i < 70; i++) {
    const x = rnd() * 512, y = rnd() * 512, r = 20 + rnd() * 70;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, "rgba(255,255,255,0.55)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function carDetail(kind: "taxi" | "police" | "plain"): THREE.CanvasTexture {
  // side decal strip (checker for taxi, POLICE text for cruiser)
  const [c, g] = canvas(256, 64);
  g.clearRect(0, 0, 256, 64);
  if (kind === "taxi") {
    for (let i = 0; i < 32; i++) {
      g.fillStyle = (i + (i >> 4)) % 2 ? "#111" : "#fff";
      g.fillRect((i % 16) * 16, (i >> 4) * 12 + 20, 16, 12);
    }
  } else if (kind === "police") {
    g.fillStyle = "#f5f5f5";
    g.fillRect(0, 10, 256, 44);
    g.fillStyle = "#123";
    g.font = "900 30px Arial Black, Arial";
    g.textAlign = "center";
    g.fillText("POLICE", 128, 44);
    g.fillStyle = "#1e88e5";
    g.fillRect(0, 50, 256, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
