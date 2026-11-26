/**
 * Procedural facades for the real buildings: the walls carry (u = metres along the
 * footprint perimeter, v = metres up, seed) and a per-kind shader turns that into glass
 * curtain walls, office window bands, shopfronts, sandstone or rendered walls. Physically
 * based (roughness/metalness), so glass picks up the sky reflections from the PMREM env map,
 * and lit windows glow at night.
 */
import * as THREE from "three";
import type { BuildingDef } from "../map";

export const KINDS = ["tower", "office", "low", "heritage", "residential", "pavilion"] as const;
export type Kind = (typeof KINDS)[number];

const COMMON = /* glsl */ `
  varying vec3 vFac;
  uniform float uNight;
  float h1(float n){ return fract(sin(n*127.1)*43758.5453); }
  float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(h2(i),h2(i+vec2(1,0)),f.x), mix(h2(i+vec2(0,1)),h2(i+vec2(1,1)),f.x), f.y); }
  float lineMask(float x, float w){ float d = min(fract(x), 1.0-fract(x)); return 1.0 - smoothstep(w*0.5, w*0.5+0.02, d); }
`;

/** Each kind: GLSL that sets col (albedo), rough, metal, emi (emissive) from u, v, seed. */
const KIND_GLSL: Record<Kind, string> = {
  tower: `
    float colW = 1.5, flH = 3.8;
    vec2 cell = vec2(u/colW, v/flH);
    float mull = max(lineMask(cell.x, 0.035), lineMask(cell.y, 0.03));
    float spandrel = step(fract(cell.y), 0.22);
    float tint = h1(seed*7.0);
    vec3 glass = tint < 0.35 ? vec3(0.10,0.20,0.26) : tint < 0.65 ? vec3(0.13,0.22,0.22) : tint < 0.85 ? vec3(0.20,0.21,0.23) : vec3(0.22,0.17,0.12);
    glass *= 0.85 + 0.3*h2(floor(cell)+seed);
    col = mix(glass, glass*0.7 + 0.04, spandrel);
    rough = mix(0.05, 0.25, spandrel); metal = 0.9;
    if (mull > 0.5) { col = vec3(0.34,0.36,0.38); rough = 0.4; metal = 0.8; }
    float lit = step(0.80, h2(floor(cell)*vec2(1.0,3.0)+seed)) * (1.0-spandrel) * (1.0-mull);
    emi = lit * mix(vec3(1.0,0.86,0.62), vec3(0.75,0.85,1.0), h2(floor(cell)+7.7)) * uNight * (0.25 + 0.35*h2(floor(cell)+3.1));
  `,
  office: `
    float flH = 3.6, bay = 3.0;
    float fv = fract(v/flH);
    float win = step(0.30, fv) * step(fv, 0.92);
    float fin = lineMask(u/bay, 0.16/bay*2.0);
    float tone = h1(seed*3.0);
    vec3 conc = tone < 0.4 ? vec3(0.62,0.59,0.53) : tone < 0.7 ? vec3(0.52,0.52,0.50) : vec3(0.68,0.66,0.62);
    conc *= 0.9 + 0.15*vnoise(vec2(u,v)*0.7);
    vec3 glass = mix(vec3(0.10,0.17,0.20), vec3(0.16,0.2,0.22), h1(seed*11.0));
    col = mix(conc, glass, win*(1.0-fin));
    rough = mix(0.85, 0.08, win*(1.0-fin)); metal = mix(0.0, 0.85, win*(1.0-fin));
    float lit = step(0.74, h2(vec2(floor(u/bay), floor(v/flH))+seed)) * win*(1.0-fin);
    emi = lit * vec3(1.0,0.88,0.66) * uNight * 0.45;
  `,
  low: `
    float flH = 3.4, bay = 3.2;
    float tone = h1(seed*5.0);
    vec3 wall = tone < 0.25 ? vec3(0.74,0.70,0.60) : tone < 0.5 ? vec3(0.66,0.56,0.45) : tone < 0.75 ? vec3(0.58,0.58,0.56) : vec3(0.70,0.62,0.50);
    wall *= 0.9 + 0.12*vnoise(vec2(u,v)*1.3);
    vec2 c = vec2(fract(u/bay), fract(v/flH));
    float ground = step(v, 3.6);
    float shop = ground * step(0.06, c.x) * step(c.x, 0.94) * step(0.3, v) * step(v, 3.0);
    float win = (1.0-ground) * step(0.25, c.x) * step(c.x, 0.75) * step(0.3, c.y) * step(c.y, 0.82);
    float g = max(shop, win);
    col = mix(wall, vec3(0.11,0.14,0.16), g);
    rough = mix(0.8, 0.1, g); metal = mix(0.0, 0.7, g);
    emi = (shop * 0.55 + win * step(0.7, h2(vec2(floor(u/bay), floor(v/flH))+seed)) * 0.4) * vec3(1.0,0.82,0.55) * uNight;
  `,
  heritage: `
    float flH = 4.2, bay = 3.4;
    float brick = step(0.5, h1(seed*13.0));
    vec3 wall = brick > 0.5 ? vec3(0.62,0.34,0.24) : vec3(0.84,0.74,0.56);
    // brick courses / ashlar blocks
    float course = lineMask(v/(brick > 0.5 ? 0.08 : 0.45), 0.08);
    wall *= 1.0 - 0.10*course;
    wall *= 0.9 + 0.15*vnoise(vec2(u,v)*2.0);
    vec2 c = vec2(fract(u/bay), fract(v/flH));
    float arch = step(0.32, c.x) * step(c.x, 0.68) * step(0.18, c.y) * step(c.y, 0.80 - 0.15*pow(abs(c.x-0.5)/0.18, 2.0));
    float cornice = step(fract(v/flH), 0.06);
    col = mix(wall, vec3(0.08,0.10,0.12), arch);
    col = mix(col, vec3(0.92,0.88,0.80), cornice);
    rough = mix(0.9, 0.15, arch); metal = 0.0;
    emi = arch * step(0.55, h2(vec2(floor(u/bay), floor(v/flH))+seed)) * vec3(1.0,0.8,0.5) * uNight * 0.8;
  `,
  residential: `
    float flH = 3.1, bay = 4.0;
    vec3 wall = mix(vec3(0.80,0.79,0.75), vec3(0.72,0.69,0.63), h1(seed*2.0));
    vec2 c = vec2(fract(u/bay), fract(v/flH));
    float slab = step(c.y, 0.10);
    float glazing = step(0.12, c.y) * step(c.y, 0.85) * step(0.1, c.x) * step(c.x, 0.9);
    float rail = step(0.12, c.y) * step(c.y, 0.40) * step(0.1, c.x) * step(c.x, 0.9);
    col = mix(wall, vec3(0.12,0.16,0.18), glazing);
    col = mix(col, vec3(0.55,0.62,0.66), rail*0.6);
    col = mix(col, wall*0.8, slab);
    rough = mix(0.75, 0.1, glazing); metal = mix(0.0, 0.6, glazing);
    emi = glazing * (1.0-rail) * step(0.66, h2(vec2(floor(u/bay), floor(v/flH))+seed)) * vec3(1.0,0.84,0.6) * uNight * 0.45;
  `,
  pavilion: `
    col = vec3(0.78,0.78,0.76) * (0.9 + 0.1*vnoise(vec2(u,v)));
    float g = step(0.2, v) * step(v, 2.8) * step(0.1, fract(u/2.5));
    col = mix(col, vec3(0.12,0.15,0.17), g);
    rough = mix(0.5, 0.1, g); metal = mix(0.3, 0.8, g);
    emi = g * vec3(1.0,0.85,0.6) * uNight * 0.6;
  `,
};

export const nightUniform = { value: 0 };

export function facadeMaterial(kind: Kind): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = nightUniform;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute vec3 aFac;\nvarying vec3 vFac;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvFac = aFac;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\n" + COMMON)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float u = vFac.x, v = vFac.y, seed = vFac.z;
        vec3 col; float rough, metal; vec3 emi = vec3(0.0);
        if (seed < 0.0) { // roofs
          float s = -seed;
          col = vec3(0.42,0.42,0.42) * (0.75 + 0.35*vnoise(vec2(u,v)*0.35 + s));
          rough = 0.9; metal = 0.0;
        } else { ${KIND_GLSL[kind]} }
        diffuseColor.rgb = col;`,
      )
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = rough;")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor = metal;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += emi;");
  };
  m.customProgramCacheKey = () => "facade-" + kind;
  return m;
}

function signedArea(r: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Extrude footprints into one geometry per kind (walls + roofs), world coords (z = -y). */
export function buildingGeometries(defs: BuildingDef[], skip: (b: BuildingDef) => boolean): Map<Kind, THREE.BufferGeometry> {
  const acc = new Map<Kind, { pos: number[]; nor: number[]; fac: number[] }>();
  for (const k of KINDS) acc.set(k, { pos: [], nor: [], fac: [] });
  let seedN = 0;
  for (const b of defs) {
    if (skip(b)) continue;
    const kind = (KINDS as readonly string[]).includes(b.k) ? (b.k as Kind) : "low";
    const A = acc.get(kind)!;
    const ring = b.p.slice();
    const ccw = signedArea(ring) > 0;
    const y0 = b.minh, y1 = Math.max(b.h, b.minh + 2.5);
    const seed = (seedN++ * 0.6180339) % 1 * 97 + 1;
    let u = 0;
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      if (len < 0.05) continue;
      // outward normal in data coords, then to world (x, z = -y)
      const nx = ccw ? dy / len : -dy / len, ny = ccw ? -dx / len : dx / len;
      const wn = [nx, 0, -ny];
      const P = (x: number, y: number, h: number) => [x, h, -y];
      const a0 = P(ax, ay, y0), b0 = P(bx, by, y0), b1 = P(bx, by, y1), a1 = P(ax, ay, y1);
      // winding: front face must face the outward normal
      const e1 = [b0[0] - a0[0], b0[1] - a0[1], b0[2] - a0[2]], e2 = [a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]];
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const flip = cr[0] * wn[0] + cr[2] * wn[2] < 0;
      const tri = flip ? [a0, a1, b0, b0, a1, b1] : [a0, b0, a1, b0, b1, a1];
      const fu = (p: number[]) => (p === a0 || p === a1 ? u : u + len);
      for (const p of tri) {
        A.pos.push(p[0], p[1], p[2]);
        A.nor.push(wn[0], wn[1], wn[2]);
        A.fac.push(fu(p), p[1], seed);
      }
      u += len;
    }
    // roof
    const contour = ring.map(([x, y]) => new THREE.Vector2(x, y));
    let tris: number[][] = [];
    try {
      tris = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
      tris = [];
    }
    for (const t of tris) {
      const pts = t.map((i) => ring[i]);
      // world-space triangle facing up
      const w = pts.map(([x, y]) => [x, y1, -y]);
      const e1 = [w[1][0] - w[0][0], w[1][2] - w[0][2]], e2 = [w[2][0] - w[0][0], w[2][2] - w[0][2]];
      const up = e1[1] * e2[0] - e1[0] * e2[1] > 0; // y component of cross(e1, e2)
      const order = up ? [0, 1, 2] : [0, 2, 1];
      for (const o of order) {
        A.pos.push(w[o][0], w[o][1], w[o][2]);
        A.nor.push(0, 1, 0);
        A.fac.push(w[o][0], w[o][2], -seed);
      }
    }
  }
  const out = new Map<Kind, THREE.BufferGeometry>();
  for (const [k, A] of acc) {
    if (!A.pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(A.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(A.nor, 3));
    g.setAttribute("aFac", new THREE.Float32BufferAttribute(A.fac, 3));
    g.computeBoundingSphere();
    out.set(k, g);
  }
  return out;
}
