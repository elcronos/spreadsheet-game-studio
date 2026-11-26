/** Builds the static Meridian Bay meshes from the layout. */
import * as THREE from "three";
import type { Building, CityLayout, Rect } from "../city";
import { SHORE_X, SHORE_Z, COAST_Z, BOUNDS, SIDEWALK, roadHalfWidthX } from "../city";
import { Geo } from "./geo";
import * as T from "./textures";
import { RAMPS } from "../sim/vehicle";
import { signalFor, crossHalf } from "../sim/nav";

export interface CityVisuals {
  group: THREE.Group;
  /** Materials whose glow follows the night factor. */
  nightMats: { mat: THREE.Material & { color?: THREE.Color; emissiveIntensity?: number; opacity?: number }; day: number; night: number; prop: "emissiveIntensity" | "opacity" | "color" }[];
  signalLamps: THREE.InstancedMesh;
  signalInfo: { node: number; axis: "ns" | "ew"; lamp: 0 | 1 | 2 }[];
  wheel: THREE.Group;
  beacon: THREE.Group;
  mastLights: THREE.Mesh;
  lightPools: THREE.InstancedMesh;
  update(t: number, night: number): void;
  setWetness(w: number): void;
}

const BAY = 3.6;
const GF = 4.4; // ground floor height
const FL = 3.4;
const inset = 1 / 512;

function cellUV(i: number): [number, number, number, number] {
  const c = i % 4, r = Math.floor(i / 4);
  return [c / 4 + inset, 1 - (r + 1) / 4 + inset, (c + 1) / 4 - inset, 1 - r / 4 - inset];
}

function facadeKey(s: Building["style"]): T.FacadeStyle {
  return s;
}

export function buildCityVisuals(city: CityLayout, scene: THREE.Scene): CityVisuals {
  const group = new THREE.Group();
  scene.add(group);
  const nightMats: CityVisuals["nightMats"] = [];
  const R = (() => {
    let s = 4242;
    return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  })();

  // ------------------------------------------------------------ ground
  const texAsphalt = T.asphalt(), texPave = T.pavement(), texSand = T.sand(), texGrass = T.grass(), texWood = T.wood(), texRoof = T.roof(), texConcrete = T.concrete(), texPromenade = T.promenade();
  const mat = (map: THREE.Texture, opts: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ map, roughness: 0.92, metalness: 0, vertexColors: true, ...opts });
  const mAsphalt = mat(texAsphalt, { roughness: 0.88 });
  const mPave = mat(texPave);
  const mSand = mat(texSand);
  const mGrass = mat(texGrass);
  const mWood = mat(texWood);
  const mConcrete = mat(texConcrete);
  const mPromenade = mat(texPromenade);
  const mRoof = mat(texRoof);
  const mPaint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const mPlain = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, flatShading: true });
  const mMetal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.6, flatShading: true });

  const add = (g: Geo, m: THREE.Material, shadow = true, cast = false) => {
    if (!g.vertexCount) return null;
    const mesh = new THREE.Mesh(g.build(), m);
    mesh.receiveShadow = shadow;
    mesh.castShadow = cast;
    group.add(mesh);
    return mesh;
  };

  const sandG = new Geo();
  sandG.flat(BOUNDS.x0 - 60, BOUNDS.z0 - 60, SHORE_X, SHORE_Z, 0, 12);
  // shore slope into the water
  sandG.quad([SHORE_X, 0, SHORE_Z], [SHORE_X + 14, -1.6, SHORE_Z + 14], [SHORE_X + 14, -1.6, BOUNDS.z0 - 60], [SHORE_X, 0, BOUNDS.z0 - 60], [0, 0, 1, 40], 0xd9c08a);
  sandG.quad([BOUNDS.x0 - 60, 0, SHORE_Z], [BOUNDS.x0 - 60, -1.6, SHORE_Z + 14], [SHORE_X + 14, -1.6, SHORE_Z + 14], [SHORE_X, 0, SHORE_Z], [0, 0, 40, 1], 0xd9c08a);
  add(sandG, mSand);

  // roads
  const roadG = new Geo();
  for (const e of city.edges) roadG.ribbon(e.pts, e.halfWidth, 0.02, 8);
  for (const n of city.nodes) {
    const hx = roadHalfWidthX(n.x), hz = 7;
    roadG.flat(n.x - hx, n.z - hz, n.x + hx, n.z + hz, 0.021, 8);
  }
  for (const a of city.alleys) roadG.flat(a.x0, a.z0, a.x1, a.z1, 0.17, 8, 0xb8b0a8);
  for (const p of city.parking) roadG.flat(p.x0, p.z0, p.x1, p.z1, 0.16, 8, 0xd8d8d8);
  add(roadG, mAsphalt);

  // sidewalks, kerbs, block interiors
  const paveG = new Geo(), kerbG = new Geo(), grassG = new Geo(), promG = new Geo();
  for (const b of city.blocks) {
    if (b.district === "park") {
      paveG.flat(b.x0, b.z0, b.x1, b.z1, 0.15, 4);
      grassG.flat(b.x0 + SIDEWALK, b.z0 + SIDEWALK, b.x1 - SIDEWALK, b.z1 - SIDEWALK, 0.16, 6);
    } else paveG.flat(b.x0, b.z0, b.x1, b.z1, 0.15, 4);
    const k = 0.15;
    kerbG.quad([b.x0, 0, b.z1], [b.x1, 0, b.z1], [b.x1, k, b.z1], [b.x0, k, b.z1], [0, 0, 1, 1], 0xcfc9be, [0, 0, 1]);
    kerbG.quad([b.x1, 0, b.z0], [b.x0, 0, b.z0], [b.x0, k, b.z0], [b.x1, k, b.z0], [0, 0, 1, 1], 0xcfc9be, [0, 0, -1]);
    kerbG.quad([b.x1, 0, b.z1], [b.x1, 0, b.z0], [b.x1, k, b.z0], [b.x1, k, b.z1], [0, 0, 1, 1], 0xcfc9be, [1, 0, 0]);
    kerbG.quad([b.x0, 0, b.z0], [b.x0, 0, b.z1], [b.x0, k, b.z1], [b.x0, k, b.z0], [0, 0, 1, 1], 0xcfc9be, [-1, 0, 0]);
  }
  // park paths & fountain plaza
  const pk = city.park;
  const pcx = (pk.x0 + pk.x1) / 2, pcz = (pk.z0 + pk.z1) / 2;
  paveG.flat(pcx - 2.5, pk.z0, pcx + 2.5, pk.z1, 0.17, 4, 0xe8dccb);
  paveG.flat(pk.x0, pcz - 2.5, pk.x1, pcz + 2.5, 0.17, 4, 0xe8dccb);
  paveG.flat(pcx - 11, pcz - 11, pcx + 11, pcz + 11, 0.171, 4, 0xf0e2cf);
  // beach promenade
  promG.flat(208, -178, 234, 234, 0.05, 6);
  add(paveG, mPave);
  add(kerbG, mConcrete);
  add(grassG, mGrass);
  add(promG, mPromenade);

  // ------------------------------------------------------------ markings
  const markG = new Geo();
  const WHITE = 0xf2f2ee, YELLOW = 0xf2c230;
  const dash = (x0: number, z0: number, x1: number, z1: number, w: number, c: number, y = 0.03) => {
    const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz) || 1;
    const nx = (-dz / l) * w * 0.5, nz = (dx / l) * w * 0.5;
    markG.quad([x0 + nx, y, z0 + nz], [x1 + nx, y, z1 + nz], [x1 - nx, y, z1 - nz], [x0 - nx, y, z0 - nz], [0, 0, 1, 1], c, [0, 1, 0]);
  };
  for (const e of city.edges) {
    const nA = city.nodes[e.a], nB = city.nodes[e.b];
    const s0 = crossHalf(city, nA) + 1, s1 = e.length - crossHalf(city, nB) - 1;
    let acc = 0;
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b = e.pts[i];
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      const dx = (b.x - a.x) / l, dz = (b.z - a.z) / l;
      const nx = -dz, nz = dx;
      for (let s = 0; s < l; s += 1) {
        const g = acc + s;
        if (g < s0 || g > s1) continue;
        const px = a.x + dx * s, pz = a.z + dz * s;
        const step = Math.min(1, l - s);
        if (e.halfWidth > 9) {
          // boulevard: median kerb lines
          for (const o of [-2.1, 2.1]) dash(px + nx * o, pz + nz * o, px + nx * o + dx * step, pz + nz * o + dz * step, 0.15, YELLOW);
        } else for (const o of [-0.12, 0.12]) dash(px + nx * o, pz + nz * o, px + nx * o + dx * step, pz + nz * o + dz * step, 0.1, YELLOW);
        if (Math.floor(g / 3) % 3 === 0) {
          const off = e.halfWidth > 9 ? 5.6 : 3.5;
          for (const o of [-off, off]) dash(px + nx * o, pz + nz * o, px + nx * o + dx * step, pz + nz * o + dz * step, 0.12, WHITE);
        }
        for (const o of [-e.halfWidth + 0.35, e.halfWidth - 0.35]) dash(px + nx * o, pz + nz * o, px + nx * o + dx * step, pz + nz * o + dz * step, 0.1, WHITE);
      }
      acc += l;
    }
  }
  // crosswalks & stop lines
  for (const c of city.crosswalks) {
    const dx = c.b.x - c.a.x, dz = c.b.z - c.a.z, l = Math.hypot(dx, dz);
    const ux = dx / l, uz = dz / l;
    for (let s = 2.6; s < l - 2.6; s += 1.1) {
      const px = c.a.x + ux * s, pz = c.a.z + uz * s;
      dash(px - uz * 1.4, pz + ux * 1.4, px + uz * 1.4, pz - ux * 1.4, 0.55, WHITE, 0.031);
    }
  }
  // parking bays
  for (const p of city.parking)
    for (let x = p.x0 + 1.6; x < p.x1 - 1; x += 3.2) {
      dash(x, p.z0 + 0.5, x, p.z0 + 5.5, 0.12, WHITE, 0.175);
      dash(x, p.z1 - 5.5, x, p.z1 - 0.5, 0.12, WHITE, 0.175);
    }
  add(markG, mPaint);

  // ------------------------------------------------------------ buildings
  const atlases = new Map<T.FacadeStyle, T.FacadeAtlas>();
  const facadeGeos = new Map<T.FacadeStyle, Geo>();
  const roofG = new Geo(), trimG = new Geo(), awnG = new Geo(), neonG = new Geo(), boardG = new Geo(), metalG = new Geo();
  const signs = new T.SignAtlas(2048);
  const signG = new Geo();
  const fg = (s: T.FacadeStyle) => {
    let g = facadeGeos.get(s);
    if (!g) {
      g = new Geo();
      facadeGeos.set(s, g);
      atlases.set(s, T.facadeAtlas(s));
    }
    return g;
  };

  for (const b of city.buildings) {
    const style = facadeKey(b.style);
    const g = fg(style);
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
    const h = b.h;
    const litP = b.style === "glass" || b.style === "office" ? 0.35 : 0.5;
    const shopGround = ["shop", "deco", "club", "glass", "office", "hotelTower", "gas"].includes(b.style);
    const industrial = b.style === "warehouse" || b.style === "garage";
    // walls: [ax,az,bx,bz,normalSide]
    const walls: [number, number, number, number, number][] = [
      [x1, z0, x0, z0, 0], // north face, normal -z
      [x1, z1, x1, z0, 1], // east face, normal +x
      [x0, z1, x1, z1, 2], // south, +z
      [x0, z0, x0, z1, 3], // west, -x
    ];
    let rr = b.seed * 9301;
    const r = () => ((rr = (rr * 16807 + 11) % 2147483647) / 2147483647);
    for (const [ax, az, bx, bz, side] of walls) {
      const len = Math.hypot(bx - ax, bz - az);
      const bays = Math.max(1, Math.round(len / (industrial ? 6 : BAY)));
      const bw = len / bays;
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      const front = side === b.face;
      const floors: [number, number][] = [];
      floors.push([0, Math.min(GF, h)]);
      let y = GF;
      while (y + FL <= h - 0.6) {
        floors.push([y, y + FL]);
        y += FL;
      }
      if (y < h) floors.push([y, h]);
      for (let i = 0; i < bays; i++) {
        const px0 = ax + ux * bw * i, pz0 = az + uz * bw * i, px1 = ax + ux * bw * (i + 1), pz1 = az + uz * bw * (i + 1);
        floors.forEach(([fy0, fy1], fi) => {
          let cell: number;
          const partial = fy1 - fy0 < FL - 0.01 && fi > 0;
          if (partial) cell = 12 + (b.seed % 4);
          else if (fi === 0) cell = (front && shopGround) || industrial ? 8 + Math.floor(r() * 4) : b.style === "house" || b.style === "apartment" ? (r() < 0.5 ? 12 : Math.floor(r() * 4)) : 12 + (i % 4);
          else cell = (r() < litP ? 4 : 0) + Math.floor(r() * 4);
          if (b.style === "club" && fi > 0 && r() < 0.5) cell = 12;
          const uv = cellUV(cell);
          if (partial) uv[3] = uv[1] + (uv[3] - uv[1]) * ((fy1 - fy0) / FL);
          g.quad([px0, fy0, pz0], [px1, fy0, pz1], [px1, fy1, pz1], [px0, fy1, pz0], uv, b.colour);
        });
        // awning over storefronts
        if (front && (b.style === "shop" || b.style === "deco") && i % 2 === 0 && h > 5) {
          const n = [-uz, 0, ux]; // outward normal
          const o = 1.4;
          const ay = GF - 0.7;
          awnG.quad([px0, ay + 0.9, pz0], [px1, ay + 0.9, pz1], [px1 + n[0] * o, ay, pz1 + n[2] * o], [px0 + n[0] * o, ay, pz0 + n[2] * o], [0, 0, 1, 1], b.trim === 0xffffff ? [0xe57373, 0x4db6ac, 0xffb74d, 0x7986cb][b.seed % 4] : b.trim);
        }
      }
      // floor bands for deco & hotels
      if ((b.style === "deco" || b.style === "hotelTower") && front) {
        const n = [-uz, 0, ux];
        for (let fy = GF; fy < h - 1; fy += FL) {
          const o = 0.25;
          trimG.quad([ax + n[0] * o, fy, az + n[2] * o], [bx + n[0] * o, fy, bz + n[2] * o], [bx + n[0] * o, fy + 0.25, bz + n[2] * o], [ax + n[0] * o, fy + 0.25, az + n[2] * o], [0, 0, 1, 1], b.trim);
        }
      }
    }
    // roof + parapet
    roofG.flat(x0, z0, x1, z1, h, 6);
    const pc = b.style === "glass" ? 0x6f8193 : b.style === "club" ? 0x2a2438 : 0xe9e4dc;
    const pp = 0.35;
    trimG.box(x0 - 0.1, h, z0 - 0.1, x1 + 0.1, h + 0.7, z0 + pp, pc);
    trimG.box(x0 - 0.1, h, z1 - pp, x1 + 0.1, h + 0.7, z1 + 0.1, pc);
    trimG.box(x0 - 0.1, h, z0, x0 + pp, h + 0.7, z1, pc);
    trimG.box(x1 - pp, h, z0, x1 + 0.1, h + 0.7, z1, pc);
    // rooftop props
    const nProps = Math.floor(r() * 3) + (b.w * b.d > 400 ? 2 : 0);
    for (let k = 0; k < nProps; k++) {
      const px = x0 + 2 + r() * (b.w - 4), pz = z0 + 2 + r() * (b.d - 4);
      if (b.style === "apartment" && k === 0) {
        metalG.box(px - 1, h, pz - 1, px + 1, h + 1.2, pz + 1, 0x6d6d6d);
        trimG.box(px - 1.1, h + 1.2, pz - 1.1, px + 1.1, h + 2.8, pz + 1.1, 0x9a6b4a);
      } else metalG.box(px - 0.8, h, pz - 0.6, px + 0.8, h + 0.9, pz + 0.6, 0xb0b4b8);
    }
    // stepped crowns on deco & the hotel tower
    if (b.style === "deco" || b.style === "hotelTower") {
      const cw = b.w * 0.45, cd = b.d * 0.45, ch = b.style === "hotelTower" ? 8 : 3 + r() * 3;
      trimG.box(b.x - cw / 2, h, b.z - cd / 2, b.x + cw / 2, h + ch, b.z + cd / 2, b.colour);
      trimG.box(b.x - cw / 4, h + ch, b.z - cd / 4, b.x + cw / 4, h + ch + ch * 0.6, b.z + cd / 4, b.trim);
      // neon outline along the crown top (glows at night)
      const ny = h + ch;
      const t = 0.18;
      neonG.box(b.x - cw / 2 - t, ny - t, b.z - cd / 2 - t, b.x + cw / 2 + t, ny, b.z - cd / 2, b.trim);
      neonG.box(b.x - cw / 2 - t, ny - t, b.z + cd / 2, b.x + cw / 2 + t, ny, b.z + cd / 2 + t, b.trim);
      neonG.box(b.x - cw / 2 - t, ny - t, b.z - cd / 2, b.x - cw / 2, ny, b.z + cd / 2, b.trim);
      neonG.box(b.x + cw / 2, ny - t, b.z - cd / 2, b.x + cw / 2 + t, ny, b.z + cd / 2, b.trim);
    }
    // neon edge along the top of the street face for clubs and deco
    if (b.style === "club" || b.style === "deco" || b.style === "hotelTower") {
      const col = b.style === "club" ? b.trim : b.sign?.colour ?? b.trim;
      const y = b.style === "club" ? GF - 0.3 : h - 0.2;
      const t = 0.14;
      if (b.face === 0) neonG.box(x0, y, z0 - t * 2, x1, y + t, z0 - t, col);
      if (b.face === 2) neonG.box(x0, y, z1 + t, x1, y + t, z1 + t * 2, col);
      if (b.face === 1) neonG.box(x1 + t, y, z0, x1 + t * 2, y + t, z1, col);
      if (b.face === 3) neonG.box(x0 - t * 2, y, z0, x0 - t, y + t, z1, col);
    }
    // signs
    if (b.sign) {
      const s = signs.add(b.sign.text, b.sign.colour, !!b.sign.vertical);
      const fn = [[0, -1], [1, 0], [0, 1], [-1, 0]][b.face];
      const along = [[1, 0], [0, 1], [1, 0], [0, 1]][b.face];
      const fx = b.face === 0 ? b.x : b.face === 2 ? b.x : b.face === 1 ? x1 : x0;
      const fz = b.face === 1 || b.face === 3 ? b.z : b.face === 0 ? z0 : z1;
      if (b.sign.vertical) {
        const sh = Math.min(h * 0.62, 16), sw = sh * s.aspect;
        const y0 = Math.max(GF + 0.5, h - sh - 1.5);
        const faceLen = b.face % 2 ? b.d : b.w;
        const px = fx + along[0] * faceLen * 0.3, pz = fz + along[1] * faceLen * 0.3;
        const ix = px + fn[0] * 0.3, iz = pz + fn[1] * 0.3; // inner edge
        const ox = px + fn[0] * (0.3 + sw), oz = pz + fn[1] * (0.3 + sw); // outer edge
        const t = 0.14;
        boardG.box(Math.min(ix, ox) - Math.abs(along[0]) * t, y0 - 0.2, Math.min(iz, oz) - Math.abs(along[1]) * t, Math.max(ix, ox) + Math.abs(along[0]) * t, y0 + sh + 0.2, Math.max(iz, oz) + Math.abs(along[1]) * t, 0x1b1d24);
        const [u0, v0, u1, v1] = s.uv;
        const e = t + 0.03;
        const A = (sgn: number) => [along[0] * e * sgn, along[1] * e * sgn];
        const [ax1, az1] = A(1), [ax2, az2] = A(-1);
        signG.quad([ix + ax1, y0, iz + az1], [ox + ax1, y0, oz + az1], [ox + ax1, y0 + sh, oz + az1], [ix + ax1, y0 + sh, iz + az1], [u0, v0, u1, v1]);
        signG.quad([ox + ax2, y0, oz + az2], [ix + ax2, y0, iz + az2], [ix + ax2, y0 + sh, iz + az2], [ox + ax2, y0 + sh, oz + az2], [u0, v0, u1, v1]);
      } else {
        const sh = b.style === "warehouse" ? 2.2 : 1.6;
        const sw = Math.min(sh * s.aspect, (b.face % 2 ? b.d : b.w) * 0.9);
        const shh = sw / s.aspect;
        const y0 = b.style === "gas" ? h - shh - 0.3 : Math.min(GF + 0.1, h - shh - 0.2);
        const off = 0.12;
        const cx = fx + fn[0] * off, cz = fz + fn[1] * off;
        const ax = along[0] * sw / 2, az = along[1] * sw / 2;
        const [u0, v0, u1, v1] = s.uv;
        boardG.quad(
          ...(b.face === 0 || b.face === 1
            ? [[cx + ax - fn[0] * 0.05, y0 - 0.1, cz + az - fn[1] * 0.05], [cx - ax - fn[0] * 0.05, y0 - 0.1, cz - az - fn[1] * 0.05], [cx - ax - fn[0] * 0.05, y0 + shh + 0.1, cz - az - fn[1] * 0.05], [cx + ax - fn[0] * 0.05, y0 + shh + 0.1, cz + az - fn[1] * 0.05]]
            : [[cx - ax - fn[0] * 0.05, y0 - 0.1, cz - az - fn[1] * 0.05], [cx + ax - fn[0] * 0.05, y0 - 0.1, cz + az - fn[1] * 0.05], [cx + ax - fn[0] * 0.05, y0 + shh + 0.1, cz + az - fn[1] * 0.05], [cx - ax - fn[0] * 0.05, y0 + shh + 0.1, cz - az - fn[1] * 0.05]]) as [number[], number[], number[], number[]],
          [0, 0, 1, 1],
          0x1b1d24,
        );
        if (b.face === 0 || b.face === 1) signG.quad([cx + ax, y0, cz + az], [cx - ax, y0, cz - az], [cx - ax, y0 + shh, cz - az], [cx + ax, y0 + shh, cz + az], [u0, v0, u1, v1]);
        else signG.quad([cx - ax, y0, cz - az], [cx + ax, y0, cz + az], [cx + ax, y0 + shh, cz + az], [cx - ax, y0 + shh, cz - az], [u0, v0, u1, v1]);
      }
    }
  }
  signs.texture.needsUpdate = true;
  const facadeMats: THREE.MeshStandardMaterial[] = [];
  for (const [style, g] of facadeGeos) {
    const at = atlases.get(style)!;
    const m = new THREE.MeshStandardMaterial({ map: at.map, emissiveMap: at.emissive, emissive: 0xffffff, emissiveIntensity: 0, vertexColors: true, roughness: style === "glass" ? 0.25 : 0.85, metalness: style === "glass" ? 0.5 : 0 });
    facadeMats.push(m);
    nightMats.push({ mat: m, day: 0.0, night: 1.25, prop: "emissiveIntensity" });
    add(g, m, true, true);
  }
  add(roofG, mRoof, true, false);
  add(trimG, mPlain, true, true);
  const awnTex = T.stripes("#ffffff", "#d9d9d9");
  add(awnG, new THREE.MeshStandardMaterial({ map: awnTex, vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }), true, true);
  add(metalG, mMetal, true, true);
  add(boardG, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, side: THREE.DoubleSide }), false, false);
  const neonMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  nightMats.push({ mat: neonMat, day: 0.55, night: 2.2, prop: "color" });
  add(neonG, neonMat, false, false);
  const signMat = new THREE.MeshBasicMaterial({ map: signs.texture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
  nightMats.push({ mat: signMat, day: 0.75, night: 2.0, prop: "color" });
  add(signG, signMat, false, false);

  // ------------------------------------------------------------ props (instanced)
  const dummy = new THREE.Object3D();
  const inst = (geo: THREE.BufferGeometry, m: THREE.Material, pts: { x: number; z: number; y?: number; rot?: number; s?: number }[], cast = true) => {
    const im = new THREE.InstancedMesh(geo, m, Math.max(1, pts.length));
    pts.forEach((p, i) => {
      dummy.position.set(p.x, p.y ?? 0, p.z);
      dummy.rotation.set(0, p.rot ?? 0, 0);
      dummy.scale.setScalar(p.s ?? 1);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    });
    im.count = pts.length;
    im.castShadow = cast;
    im.receiveShadow = false;
    group.add(im);
    return im;
  };
  // palms: curved trunk + drooping fronds
  const trunk = new Geo();
  const segs = 7;
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    const bend = (t: number) => 0.9 * t * t;
    const r0 = 0.28 - 0.12 * t0, r1 = 0.28 - 0.12 * t1;
    const y0 = t0 * 8.5, y1 = t1 * 8.5;
    const c = i % 2 ? 0x8a6a48 : 0x7a5c3e;
    for (let k = 0; k < 6; k++) {
      const a0 = (k / 6) * Math.PI * 2, a1 = ((k + 1) / 6) * Math.PI * 2;
      trunk.quad([bend(t0) + Math.cos(a0) * r0, y0, Math.sin(a0) * r0], [bend(t0) + Math.cos(a1) * r0, y0, Math.sin(a1) * r0], [bend(t1) + Math.cos(a1) * r1, y1, Math.sin(a1) * r1], [bend(t1) + Math.cos(a0) * r1, y1, Math.sin(a0) * r1], [0, 0, 1, 1], c);
    }
  }
  const frondG = new Geo();
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + (k % 2) * 0.2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const L = 3.6, W = 0.8;
    const top = [0.9, 8.5, 0];
    const mid = [0.9 + ca * L * 0.55, 8.9, sa * L * 0.55];
    const tip = [0.9 + ca * L, 7.4, sa * L];
    const px = -sa * W, pz = ca * W;
    frondG.quad([top[0] - px * 0.2, top[1], top[2] - pz * 0.2], [top[0] + px * 0.2, top[1], top[2] + pz * 0.2], [mid[0] + px, mid[1], mid[2] + pz], [mid[0] - px, mid[1], mid[2] - pz], [0, 0, 0.55, 1]);
    frondG.quad([mid[0] - px, mid[1], mid[2] - pz], [mid[0] + px, mid[1], mid[2] + pz], [tip[0] + px * 0.3, tip[1], tip[2] + pz * 0.3], [tip[0] - px * 0.3, tip[1], tip[2] - pz * 0.3], [0.55, 0, 1, 1]);
  }
  const frondTex = T.frond();
  const palmPts = city.palms.map((p) => ({ x: p.x, z: p.z, rot: R() * Math.PI * 2, s: 0.8 + R() * 0.45 }));
  inst(trunk.build(), mPlain, palmPts);
  inst(frondG.build(), new THREE.MeshStandardMaterial({ map: frondTex, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.8, vertexColors: true }), palmPts);
  // park trees
  const treeG = new Geo();
  treeG.box(-0.2, 0, -0.2, 0.2, 2.4, 0.2, 0x6d4c41);
  const canopy = new THREE.IcosahedronGeometry(2.2, 0).translate(0, 3.8, 0);
  const tg = treeG.build();
  inst(tg, mPlain, city.trees);
  inst(canopy, new THREE.MeshStandardMaterial({ color: 0x4e8a3a, flatShading: true, roughness: 0.9 }), city.trees.map((p) => ({ ...p, rot: R() * 6, s: 0.8 + R() * 0.5 })));

  // street lights
  const poleG = new Geo();
  poleG.box(-0.09, 0, -0.09, 0.09, 7, 0.09, 0x4a4f55);
  poleG.box(-0.06, 6.8, 0, 0.06, 6.92, 2.2, 0x4a4f55);
  inst(poleG.build(), mMetal, city.streetLights.map((l) => ({ x: l.x, z: l.z, rot: l.rot + Math.PI })));
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff1c8, toneMapped: false });
  nightMats.push({ mat: lampMat, day: 0.5, night: 2.4, prop: "color" });
  const lampGeo = new THREE.BoxGeometry(0.5, 0.14, 0.8).translate(0, 6.72, 2.0);
  inst(lampGeo, lampMat, city.streetLights.map((l) => ({ x: l.x, z: l.z, rot: l.rot + Math.PI })), false);
  // ground light pools (night)
  const poolTex = T.radialGlow("rgba(255,214,150,0.75)", "rgba(255,190,120,0)", true);
  const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, toneMapped: false });
  nightMats.push({ mat: poolMat, day: 0, night: 0.32, prop: "opacity" });
  const poolGeo = new THREE.PlaneGeometry(6, 6).rotateX(-Math.PI / 2).translate(0, 0.2, 2.0);
  const lightPools = inst(poolGeo, poolMat, city.streetLights.map((l) => ({ x: l.x, z: l.z, rot: l.rot + Math.PI })), false);
  lightPools.renderOrder = 2;

  // traffic signals: a pole on each corner facing approaching traffic
  const sigPole = new Geo();
  sigPole.box(-0.08, 0, -0.08, 0.08, 4.2, 0.08, 0x2b2f33);
  sigPole.box(-0.22, 3.0, -0.18, 0.22, 4.3, 0.18, 0x1c1f22);
  const signalPts: { x: number; z: number; rot: number }[] = [];
  const signalInfo: CityVisuals["signalInfo"] = [];
  for (const n of city.nodes) {
    const hx = roadHalfWidthX(n.x) + 1, hz = 8;
    // approaches: from north (moving +z) sees pole at NW... place on the right-hand near corner
    const approaches: { x: number; z: number; rot: number; axis: "ns" | "ew" }[] = [
      { x: n.x - hx, z: n.z - hz, rot: Math.PI, axis: "ns" }, // southbound traffic (from north) faces +z, sees head facing -z
      { x: n.x + hx, z: n.z + hz, rot: 0, axis: "ns" },
      { x: n.x + hx, z: n.z - hz, rot: Math.PI / 2, axis: "ew" },
      { x: n.x - hx, z: n.z + hz, rot: -Math.PI / 2, axis: "ew" },
    ];
    for (const a of approaches) {
      signalPts.push(a);
      for (let lamp = 0; lamp < 3; lamp++) signalInfo.push({ node: n.id, axis: a.axis, lamp: lamp as 0 | 1 | 2 });
    }
  }
  inst(sigPole.build(), mMetal, signalPts);
  const lampDisc = new THREE.CircleGeometry(0.12, 8);
  const signalLamps = new THREE.InstancedMesh(lampDisc, new THREE.MeshBasicMaterial({ toneMapped: false }), signalInfo.length);
  let li = 0;
  for (const a of signalPts)
    for (let lamp = 0; lamp < 3; lamp++) {
      dummy.position.set(a.x + Math.sin(a.rot + Math.PI) * -0.19, 4.0 - lamp * 0.38, a.z + Math.cos(a.rot + Math.PI) * -0.19);
      dummy.rotation.set(0, a.rot + Math.PI, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      signalLamps.setMatrixAt(li, dummy.matrix);
      signalLamps.setColorAt(li++, new THREE.Color(0x222222));
    }
  group.add(signalLamps);

  // ------------------------------------------------------------ beach & pier
  const beachG = new Geo(), woodG = new Geo();
  const pier = city.pier;
  woodG.flat(pier.x0, pier.z0, pier.x1, pier.z1, 0.18, 4);
  for (let x = SHORE_X; x < pier.x1; x += 6) {
    for (const z of [pier.z0 + 0.4, pier.z1 - 0.4]) beachG.box(x - 0.25, -3, z - 0.25, x + 0.25, 0.18, z + 0.25, 0x5d4632);
  }
  for (const z of [pier.z0 - 0.5, pier.z1 + 0.5]) beachG.box(SHORE_X, 0.18, z - 0.06, pier.x1, 1.15, z + 0.06, 0xf2efe8);
  // lifeguard towers
  const towerCols = [0xff8a65, 0x4fc3f7, 0xfff176, 0xf48fb1];
  [-120, -40, 60, 150].forEach((z, i) => {
    for (const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) beachG.box(240 + dx - 0.1, 0, z + dz - 0.1, 240 + dx + 0.1, 2.4, z + dz + 0.1, 0xeeeeee);
    beachG.box(238, 2.4, z - 2, 242, 4.6, z + 2, towerCols[i]);
    beachG.box(237.6, 4.6, z - 2.4, 242.4, 5.0, z + 2.4, 0xffffff);
  });
  // umbrellas & towels
  for (let k = 0; k < 40; k++) {
    const x = 238 + R() * 28, z = -170 + R() * 400;
    if (Math.abs(z) < 12 || (x > 226 && x < 250 && Math.abs(((z + 1000) % 100) - 0) < 0)) continue;
    const c = [0xff5252, 0x40c4ff, 0xffd740, 0x69f0ae, 0xff80ab][k % 5];
    beachG.box(x - 0.04, 0, z - 0.04, x + 0.04, 2.2, z + 0.04, 0xeeeeee);
    const r2 = 1.3;
    for (let s = 0; s < 6; s++) {
      const a0 = (s / 6) * Math.PI * 2, a1 = ((s + 1) / 6) * Math.PI * 2;
      beachG.quad([x + Math.cos(a0) * r2, 1.85, z + Math.sin(a0) * r2], [x, 2.35, z], [x, 2.35, z], [x + Math.cos(a1) * r2, 1.85, z + Math.sin(a1) * r2], [0, 0, 1, 1], s % 2 ? c : 0xffffff);
    }
    beachG.box(x + 1, 0, z - 0.5, x + 2.8, 0.03, z + 0.5, [0xffffff, 0x00bcd4, 0xff7043][k % 3]);
  }
  add(beachG, mPlain, true, true);
  add(woodG, mWood, true, false);

  // Ferris wheel at the end of the pier
  const wheel = new THREE.Group();
  const wcx = pier.x1 - 14, wr = 16;
  wheel.position.set(wcx, wr + 2.5, 0);
  const wheelG = new Geo();
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2, a2 = ((k + 1) / 16) * Math.PI * 2;
    const p0 = [Math.cos(a) * wr, Math.sin(a) * wr], p1 = [Math.cos(a2) * wr, Math.sin(a2) * wr];
    for (const z of [-1.2, 1.2]) {
      wheelG.box(Math.min(p0[0], p1[0]) - 0.1, Math.min(p0[1], p1[1]) - 0.1, z - 0.1, Math.max(p0[0], p1[0]) + 0.1, Math.max(p0[1], p1[1]) + 0.1, z + 0.1, 0xfafafa);
    }
    // spokes
    const sx = Math.cos(a) * wr, sy = Math.sin(a) * wr;
    for (let s = 0; s < 8; s++) {
      const u = s / 8;
      wheelG.box(sx * u - 0.06, sy * u - 0.06, -0.06, sx * u + 0.06, sy * u + 0.06, 0.06, 0xe0e0e0);
    }
  }
  const wheelMesh = new THREE.Mesh(wheelG.build(), mPlain);
  wheelMesh.rotation.y = Math.PI / 2;
  wheel.add(wheelMesh);
  const wheelLights = new Geo();
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    wheelLights.box(Math.cos(a) * wr - 0.18, Math.sin(a) * wr - 0.18, -1.4, Math.cos(a) * wr + 0.18, Math.sin(a) * wr + 0.18, 1.4, [0xff3fb4, 0x22e6ff, 0xffd23f][k % 3]);
  }
  const wlMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  nightMats.push({ mat: wlMat, day: 0.7, night: 2.4, prop: "color" });
  const wlMesh = new THREE.Mesh(wheelLights.build(), wlMat);
  wlMesh.rotation.y = Math.PI / 2;
  wheel.add(wlMesh);
  const cabins: THREE.Mesh[] = [];
  for (let k = 0; k < 12; k++) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.8, 1.6), new THREE.MeshStandardMaterial({ color: [0xff5252, 0x40c4ff, 0xffd740, 0x69f0ae][k % 4], flatShading: true }));
    wheel.add(c);
    cabins.push(c);
  }
  group.add(wheel);
  const standG = new Geo();
  standG.box(wcx - 0.6, 0, -3, wcx + 0.6, wr + 3, -2.2, 0xdddddd);
  standG.box(wcx - 0.6, 0, 2.2, wcx + 0.6, wr + 3, 3, 0xdddddd);
  add(standG, mPlain, true, true);

  // radio mast with blinking lights (landmark)
  const mast = city.pois.mast;
  const mastG = new Geo();
  for (let y = 0; y < 110; y += 5) {
    const w = 2.2 * (1 - y / 130);
    mastG.box(mast.x - w, y, mast.z - w, mast.x + w, y + 0.3, mast.z + w, y % 10 ? 0xffffff : 0xe53935);
    for (const [dx, dz] of [[-w, -w], [w, -w], [-w, w], [w, w]]) mastG.box(mast.x + dx - 0.12, y, mast.z + dz - 0.12, mast.x + dx + 0.12, y + 5, mast.z + dz + 0.12, (y / 5) % 2 ? 0xffffff : 0xe53935);
  }
  add(mastG, mPlain, true, true);
  const mastLights = new THREE.Mesh(new THREE.SphereGeometry(0.6, 6, 4), new THREE.MeshBasicMaterial({ color: 0xff2020, toneMapped: false }));
  mastLights.position.set(mast.x, 111, mast.z);
  group.add(mastLights);

  // lighthouse with rotating beam
  const lh = city.pois.lighthouse;
  const lhG = new Geo();
  for (let k = 0; k < 6; k++) lhG.box(lh.x - 3.4 + k * 0.25, k * 5, lh.z - 3.4 + k * 0.25, lh.x + 3.4 - k * 0.25, k * 5 + 5, lh.z + 3.4 - k * 0.25, k % 2 ? 0xffffff : 0xd32f2f);
  lhG.box(lh.x - 2.6, 30, lh.z - 2.6, lh.x + 2.6, 30.5, lh.z + 2.6, 0x333333);
  add(lhG, mPlain, true, true);
  const beacon = new THREE.Group();
  beacon.position.set(lh.x, 32, lh.z);
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 2.4, 8), new THREE.MeshBasicMaterial({ color: 0xfff3c0, toneMapped: false }));
  beacon.add(lantern);
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff0b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  nightMats.push({ mat: beamMat, day: 0, night: 0.22, prop: "opacity" });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(9, 0.8, 140, 12, 1, true).rotateZ(Math.PI / 2).translate(70, 0, 0), beamMat);
  beacon.add(beam);
  group.add(beacon);

  // the Meridian's neon crown ring
  const mer = city.buildings.find((b) => b.style === "hotelTower");
  if (mer) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.min(mer.w, mer.d) * 0.32, 0.35, 6, 24), neonMat);
    ring.position.set(mer.x, mer.h + 14.5, mer.z);
    ring.rotation.x = Math.PI / 2;
    const c = new THREE.Color(0xff3fb4);
    const g = ring.geometry as THREE.BufferGeometry;
    const n = g.getAttribute("position").count;
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => [c.r, c.g, c.b]), 3));
    group.add(ring);
  }

  // ramps & boulevard median planter
  const rampG = new Geo();
  for (const r of RAMPS) {
    const h = r.height;
    if (r.dir === 1) rampG.quad([r.x0, 0, r.z1], [r.x1, h, r.z1], [r.x1, h, r.z0], [r.x0, 0, r.z0], [0, 0, 2, 2], 0xb0a08a);
    if (r.dir === 3) rampG.quad([r.x0, h, r.z1], [r.x1, 0, r.z1], [r.x1, 0, r.z0], [r.x0, h, r.z0], [0, 0, 2, 2], 0xb0a08a);
    const xs = r.dir === 1 ? r.x1 : r.x0;
    rampG.quad([xs, 0, r.z0], [xs, 0, r.z1], [xs, h, r.z1], [xs, h, r.z0], [0, 0, 1, 1], 0x8a7a66);
  }
  add(rampG, mWood, true, true);
  const medG = new Geo();
  for (let z = -180; z < 180; z += 90) medG.box(188.2, 0, z + 12, 191.8, 0.35, z + 78, 0xcfc9be);
  add(medG, mConcrete, true, false);
  const medGrass = new Geo();
  for (let z = -180; z < 180; z += 90) medGrass.flat(188.5, z + 12.3, 191.5, z + 77.7, 0.36, 4);
  add(medGrass, mGrass);

  // fountain
  const fG = new Geo();
  fG.box(pcx - 4, 0.15, pcz - 4, pcx + 4, 0.8, pcz + 4, 0xe8e0d4);
  fG.box(pcx - 0.5, 0.8, pcz - 0.5, pcx + 0.5, 2.6, pcz + 0.5, 0xe8e0d4);
  add(fG, mPlain, true, true);
  const fWater = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 7.4).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3fa9c9, roughness: 0.1, metalness: 0.3 }));
  fWater.position.set(pcx, 0.75, pcz);
  group.add(fWater);

  // hideout lock-up and mission dressing
  const hd = city.pois.hideout;
  const hG = new Geo();
  hG.box(hd.x - 26, 0, hd.z - 8, hd.x - 12, 5, hd.z + 8, 0x5f6b70);
  add(hG, mPlain, true, true);

  // gas station canopy
  const gas = city.pois.gas;
  const gG = new Geo();
  gG.box(gas.x - 12, 5.2, gas.z - 7, gas.x + 8, 5.8, gas.z + 7, 0xf4f1ea);
  gG.box(gas.x - 12, 5.8, gas.z - 7, gas.x + 8, 6.4, gas.z + 7, 0xe53935);
  for (const [dx, dz] of [[-6, -4], [4, -4], [-6, 4], [4, 4]]) gG.box(gas.x + dx - 0.2, 0, gas.z + dz - 0.2, gas.x + dx + 0.2, 5.2, gas.z + dz + 0.2, 0xdddddd);
  add(gG, mPlain, true, true);

  // ------------------------------------------------------------ update
  const lampColours = { green: new THREE.Color(0x30ff6a), yellow: new THREE.Color(0xffc61a), red: new THREE.Color(0xff2a2a), off: new THREE.Color(0x1d1d1d) };
  return {
    group,
    nightMats,
    signalLamps,
    signalInfo,
    wheel,
    beacon,
    mastLights,
    lightPools,
    setWetness(w: number) {
      // darker, slightly glossier surfaces; keep env reflections weak so wet roads don't turn white
      mAsphalt.color.setScalar(1 - 0.45 * w);
      mAsphalt.roughness = 0.88 - 0.12 * w;
      mAsphalt.envMapIntensity = 1 - 0.7 * w;
      mPave.color.setScalar(1 - 0.3 * w);
      mPave.roughness = 0.94 - 0.1 * w;
      mPave.envMapIntensity = 1 - 0.7 * w;
    },
    update(t: number, night: number) {
      // signals
      signalInfo.forEach((s, i) => {
        const st = signalFor(city.nodes[s.node], s.axis, t);
        const on = (s.lamp === 0 && st === "red") || (s.lamp === 1 && st === "yellow") || (s.lamp === 2 && st === "green");
        signalLamps.setColorAt(i, on ? lampColours[st] : lampColours.off);
      });
      signalLamps.instanceColor!.needsUpdate = true;
      wheelMesh.rotation.x = t * 0.05;
      wlMesh.rotation.x = t * 0.05;
      cabins.forEach((c, k) => {
        const a = (k / cabins.length) * Math.PI * 2 + t * 0.05;
        c.position.set(0, Math.sin(a) * wr - 1.2, -Math.cos(a) * wr);
      });
      beacon.rotation.y = t * 0.6;
      (mastLights.material as THREE.MeshBasicMaterial).color.setScalar(Math.sin(t * 3) > 0.2 ? 1 : 0.1).multiply(new THREE.Color(1, 0.12, 0.12));
      for (const n of nightMats) {
        const v = n.day + (n.night - n.day) * night;
        if (n.prop === "emissiveIntensity") (n.mat as THREE.MeshStandardMaterial).emissiveIntensity = v;
        else if (n.prop === "opacity") (n.mat as THREE.MeshBasicMaterial).opacity = v;
        else (n.mat as THREE.MeshBasicMaterial).color.setScalar(v);
      }
    },
  };
}

export { COAST_Z };
export type { Rect };
