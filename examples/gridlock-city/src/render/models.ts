/** Original low-poly vehicle and character models, built from code. */
import * as THREE from "three";
import type { VehicleKind } from "../config";
import { DIMS, Vehicle } from "../sim/vehicle";
import type { Human, Look } from "../sim/human";
import { carDetail, canvas } from "./textures";

/** Soft elliptical headlight pool on the road ahead (fades with distance). */
function headGlowTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 128);
  const gr = g.createRadialGradient(32, 120, 4, 32, 70, 70);
  gr.addColorStop(0, "rgba(255,240,200,1)");
  gr.addColorStop(0.5, "rgba(255,230,180,0.45)");
  gr.addColorStop(1, "rgba(255,220,160,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------------ vehicles
/** Side profiles (z forward = +x of the shape, y up), metres, from rear to front. */
const PROFILES: Record<VehicleKind, { body: [number, number][]; glass: [number, number][] }> = {
  sports: {
    body: [[-2.15, 0.28], [-2.18, 0.62], [-1.95, 0.86], [-0.9, 0.98], [-0.35, 1.16], [0.55, 1.18], [1.25, 0.86], [2.05, 0.7], [2.17, 0.42], [2.1, 0.28]],
    glass: [[-1.0, 0.96], [-0.4, 1.135], [0.5, 1.155], [1.15, 0.88]],
  },
  sedan: {
    body: [[-2.3, 0.3], [-2.32, 0.78], [-2.0, 0.92], [-1.35, 0.95], [-0.95, 1.42], [0.55, 1.44], [1.15, 0.98], [2.2, 0.86], [2.3, 0.52], [2.25, 0.3]],
    glass: [[-1.3, 0.97], [-0.92, 1.4], [0.52, 1.42], [1.08, 0.99]],
  },
  taxi: {
    body: [[-2.35, 0.3], [-2.37, 0.8], [-2.05, 0.94], [-1.4, 0.97], [-1.0, 1.45], [0.6, 1.47], [1.2, 1.0], [2.25, 0.88], [2.35, 0.54], [2.3, 0.3]],
    glass: [[-1.35, 0.99], [-0.97, 1.43], [0.57, 1.45], [1.13, 1.01]],
  },
  police: {
    body: [[-2.4, 0.3], [-2.42, 0.82], [-2.1, 0.95], [-1.45, 0.98], [-1.05, 1.46], [0.6, 1.48], [1.25, 1.0], [2.3, 0.9], [2.4, 0.55], [2.35, 0.3]],
    glass: [[-1.4, 1.0], [-1.02, 1.44], [0.57, 1.46], [1.18, 1.02]],
  },
  van: {
    body: [[-2.7, 0.35], [-2.7, 2.42], [1.25, 2.42], [1.7, 1.75], [2.6, 1.3], [2.7, 0.9], [2.7, 0.35]],
    glass: [[1.28, 2.3], [1.68, 1.73], [2.48, 1.32], [1.28, 1.32]],
  },
};

function extrude(profile: [number, number][], width: number, bevel = 0.06): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  profile.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 1 });
  // shape x -> vehicle z (forward), extrusion -> vehicle x (width), centred
  g.translate(0, 0, -(width - bevel * 2) / 2);
  g.rotateY(-Math.PI / 2);
  return g.toNonIndexed();
}

/**
 * Smooth variant: a lofted body. Each station along the car is a superellipse cross-section
 * sized from the side profile, with rounded corners in plan, tumblehome above the waist,
 * wheel arches cut into the sills and the glasshouse as a second material group.
 */
export function loftBody(k: VehicleKind): THREE.BufferGeometry {
  const prof = PROFILES[k].body, gl = PROFILES[k].glass, d = DIMS[k];
  const floor = prof[0][1];
  const top = prof.slice(1, -1).slice().sort((p, q) => p[0] - q[0]);
  const zMin = Math.min(...prof.map((p) => p[0])), zMax = Math.max(...prof.map((p) => p[0]));
  const lerpY = (pts: [number, number][], z: number) => {
    if (z <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++)
      if (z <= pts[i][0]) {
        const t = (z - pts[i - 1][0]) / Math.max(1e-6, pts[i][0] - pts[i - 1][0]);
        return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
      }
    return pts[pts.length - 1][1];
  };
  // smooth the roof line a little so the pillars flow
  const roof = (z: number) => (lerpY(top, z - 0.12) + 2 * lerpY(top, z) + lerpY(top, z + 0.12)) / 4;
  const gz0 = gl[0][0], gz1 = gl[gl.length - 1][0];
  const belt = (z: number) => {
    const t = THREE.MathUtils.clamp((z - gz0) / (gz1 - gz0), 0, 1);
    return gl[0][1] + (gl[gl.length - 1][1] - gl[0][1]) * t + 0.01;
  };
  const wb = d.wheelbase / 2;
  const W = d.width / 2;
  // one half of the cross-section, bottom centre to top centre; mirrored for the other side
  const half = (hw: number, fl: number, rt: number, bz: number, steep: boolean, cabin: boolean): { x: number; y: number; g: boolean }[] => {
    const out: { x: number; y: number; g: boolean }[] = [];
    const P = (x: number, y: number, g = false) => out.push({ x, y, g });
    const waist = Math.min(bz, rt);
    const gh = rt - waist; // glasshouse height at this station
    const k = THREE.MathUtils.clamp(gh / 0.3, 0, 1);
    const gw = THREE.MathUtils.lerp(hw - 0.05, hw * 0.74, k);
    const r = Math.min(0.11, Math.max(0.03, gh * 0.4 + 0.04));
    const sb = Math.max(fl + 0.16, waist - 0.09);
    P(0, fl); P(hw * 0.55, fl); P(hw - 0.12, fl); P(hw - 0.035, fl + 0.035); P(hw, fl + 0.12);
    for (let i = 1; i <= 3; i++) P(hw + 0.015 * Math.sin((i / 4) * Math.PI), fl + 0.12 + ((sb - fl - 0.12) * i) / 4);
    P(hw, sb); P(hw - 0.015, waist - 0.03); P(hw - 0.05, waist);
    const gl = cabin && gh > 0.15;
    for (let i = 1; i <= 3; i++) {
      const t = i / 4;
      P(THREE.MathUtils.lerp(hw - 0.05, gw, t), THREE.MathUtils.lerp(waist, rt - r, t), gl);
    }
    P(gw, rt - r, gl);
    P(gw - r * 0.3, rt - r * 0.3, gl && steep); P(gw - r, rt, gl && steep);
    P((gw - r) * 0.5, rt, gl && steep); P(0, rt, gl && steep);
    // the side window frame: keep the first glass row painted so there is a visible waist line
    return out;
  };
  const NS = 72;
  const rings: { x: number; y: number; z: number; g: boolean }[][] = [];
  for (let i = 0; i <= NS; i++) {
    const u = i / NS;
    const z = zMin + (zMax - zMin) * (0.5 - 0.5 * Math.cos(Math.PI * u));
    const e = Math.min(z - zMin, zMax - z);
    const plan = 0.6 + 0.4 * Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, 1 - e / 0.8), 2)));
    let fl = floor;
    for (const az of [wb, -wb]) {
      const q = Math.abs(z - az) / 0.5;
      if (q < 1) fl = Math.max(fl, floor + 0.36 * Math.sqrt(1 - q * q));
    }
    const rt = Math.max(fl + 0.2, roof(z));
    const slope = Math.abs(roof(z + 0.08) - roof(z - 0.08)) / 0.16;
    const inCabin = z > gz0 - 0.05 && z < gz1 + 0.05;
    const h = half(W * plan, fl, rt, belt(z), slope > 0.35, inCabin);
    const ring: { x: number; y: number; z: number; g: boolean }[] = [];
    for (const q of h) ring.push({ x: q.x, y: q.y, z, g: q.g });
    for (let j = h.length - 2; j >= 1; j--) ring.push({ x: -h[j].x, y: h[j].y, z, g: h[j].g });
    rings.push(ring);
  }
  const NA = rings[0].length;
  const pos: number[] = [], isGlass: boolean[] = [];
  for (const ring of rings) for (const q of ring) { pos.push(q.x, q.y, q.z); isGlass.push(q.g); }
  const body: number[] = [], glass: number[] = [];
  const id = (i: number, j: number) => i * NA + (j % NA);
  for (let i = 0; i < NS; i++)
    for (let j = 0; j < NA; j++) {
      const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), dd = id(i, j + 1);
      const g = isGlass[a] && isGlass[b] && isGlass[c] && isGlass[dd];
      (g ? glass : body).push(a, b, c, a, c, dd);
    }
  // caps at nose and tail
  const capC = (i: number) => {
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < NA; j++) {
      cx += pos[id(i, j) * 3]; cy += pos[id(i, j) * 3 + 1]; cz += pos[id(i, j) * 3 + 2];
    }
    pos.push(cx / NA, cy / NA, cz / NA);
    return pos.length / 3 - 1;
  };
  const c0 = capC(0), c1 = capC(NS);
  for (let j = 0; j < NA; j++) {
    body.push(c0, id(0, j + 1), id(0, j));
    body.push(c1, id(NS, j), id(NS, j + 1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex([...body, ...glass]);
  g.addGroup(0, body.length, 0);
  g.addGroup(body.length, glass.length, 1);
  // winding: make sure normals point out (sample a side vertex)
  g.computeVertexNormals();
  const n = g.getAttribute("normal") as THREE.BufferAttribute;
  const probe = id(NS >> 1, 6);
  if (n.getX(probe) * pos[probe * 3] < 0) {
    const idx = g.getIndex()!.array as Uint32Array | Uint16Array;
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
    g.computeVertexNormals();
  }
  return g;
}

let vehicleStyle: "block" | "smooth" = "block";
/** "block" (Gridlock City) or "smooth" (splined, bevelled bodies; used by Quayside). */
export function setVehicleStyle(s: "block" | "smooth"): void {
  vehicleStyle = s;
}

export interface VehicleRig {
  root: THREE.Group;
  body: THREE.Group; // pitch/roll applied here
  bodyMesh: THREE.Mesh;
  wheels: THREE.Object3D[]; // [FL, FR, RL, RR]
  head: THREE.Mesh;
  tail: THREE.Mesh;
  tailMat: THREE.MeshStandardMaterial;
  headMat: THREE.MeshStandardMaterial;
  bar?: { red: THREE.Mesh; blue: THREE.Mesh };
  cone: THREE.Mesh;
  smoke: number;
  basePositions: Float32Array;
  dentVersion: number;
}

const shared = {
  glass: null as THREE.MeshStandardMaterial | null,
  trim: null as THREE.MeshStandardMaterial | null,
  tyre: null as THREE.MeshStandardMaterial | null,
  rim: null as THREE.MeshStandardMaterial | null,
  wheelGeo: null as THREE.BufferGeometry | null,
  rimGeo: null as THREE.BufferGeometry | null,
  bodyGeo: new Map<VehicleKind, THREE.BufferGeometry>(),
  glassGeo: new Map<VehicleKind, THREE.BufferGeometry>(),
  paint: new Map<number, THREE.MeshStandardMaterial>(),
  decal: new Map<string, THREE.MeshStandardMaterial>(),
  coneGeo: null as THREE.BufferGeometry | null,
  coneMat: null as THREE.MeshBasicMaterial | null,
  red: null as THREE.MeshBasicMaterial | null,
  blue: null as THREE.MeshBasicMaterial | null,
};

function paint(colour: number): THREE.MeshStandardMaterial {
  const key = vehicleStyle === "smooth" ? -1 - colour : colour;
  let m = shared.paint.get(key);
  if (!m) {
    m = vehicleStyle === "smooth"
      ? new THREE.MeshPhysicalMaterial({ color: colour, metalness: 0.5, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.08, vertexColors: true })
      : new THREE.MeshStandardMaterial({ color: colour, metalness: 0.35, roughness: 0.32, flatShading: true, vertexColors: true });
    shared.paint.set(key, m);
  }
  return m;
}

function smoothShapes(k: VehicleKind): { body: THREE.BufferGeometry; glass: THREE.BufferGeometry | null } {
  const key = `smooth:${k}` as VehicleKind;
  let body = shared.bodyGeo.get(key);
  if (!body) {
    body = loftBody(k);
    const n = body.getAttribute("position").count;
    body.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    shared.bodyGeo.set(key, body);
  }
  return { body, glass: null };
}

function initShared(): void {
  if (shared.glass) return;
  shared.glass = new THREE.MeshStandardMaterial({ color: 0x0b1118, metalness: 0.55, roughness: 0.18, flatShading: true, envMapIntensity: 0.45 });
  shared.trim = new THREE.MeshStandardMaterial({ color: 0x1f2226, roughness: 0.7, metalness: 0.2 });
  shared.tyre = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
  shared.rim = new THREE.MeshStandardMaterial({ color: 0xc8ccd0, metalness: 0.8, roughness: 0.3 });
  shared.wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 10).rotateZ(Math.PI / 2);
  shared.rimGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.28, 6).rotateZ(Math.PI / 2);
  for (const k of Object.keys(PROFILES) as VehicleKind[]) {
    const d = DIMS[k];
    const b = extrude(PROFILES[k].body, d.width);
    // vertex colour 1 everywhere (darkened by dents)
    const n = b.getAttribute("position").count;
    b.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    shared.bodyGeo.set(k, b);
    shared.glassGeo.set(k, extrude(PROFILES[k].glass, d.width + 0.04, 0.02));
  }
  // headlight cone: open cylinder narrowing at the car, additive
  shared.coneGeo = new THREE.PlaneGeometry(4.2, 11).rotateX(-Math.PI / 2).translate(0, 0, 6.2);
  shared.coneMat = new THREE.MeshBasicMaterial({ color: 0xffe2a8, map: headGlowTexture(), transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4 });
  shared.red = new THREE.MeshBasicMaterial({ color: 0xff1a1a, toneMapped: false });
  shared.blue = new THREE.MeshBasicMaterial({ color: 0x1a5cff, toneMapped: false });
}

let sGlass: THREE.MeshPhysicalMaterial | null = null;
function smoothGlass(): THREE.MeshPhysicalMaterial {
  return (sGlass ??= new THREE.MeshPhysicalMaterial({ color: 0x020406, metalness: 0.0, roughness: 0.06, envMapIntensity: 0.55, specularIntensity: 0.6 }));
}
let sWheel: { tyre: THREE.BufferGeometry; rim: THREE.BufferGeometry } | null = null;
function smoothWheel(): { tyre: THREE.BufferGeometry; rim: THREE.BufferGeometry } {
  if (!sWheel) {
    // tyre: a fat torus; rim: a dished disc with five spokes
    const tyre = new THREE.TorusGeometry(0.26, 0.1, 10, 28).rotateY(Math.PI / 2);
    tyre.scale(1.3, 1, 1);
    const disc = new THREE.CylinderGeometry(0.22, 0.22, 0.2, 24).rotateZ(Math.PI / 2);
    const parts: THREE.BufferGeometry[] = [disc];
    for (let i = 0; i < 5; i++) {
      const sp = new THREE.BoxGeometry(0.04, 0.2, 0.06).translate(0.11, 0.1, 0).rotateX((i / 5) * Math.PI * 2);
      parts.push(sp);
    }
    const rim = mergeSimple(parts);
    sWheel = { tyre, rim };
  }
  return sWheel;
}
function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  let n = 0;
  for (const p of flat) n += p.getAttribute("position").count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const p of flat) {
    pos.set(p.getAttribute("position").array as Float32Array, o * 3);
    nor.set(p.getAttribute("normal").array as Float32Array, o * 3);
    o += p.getAttribute("position").count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  return g;
}

function decalMat(kind: "taxi" | "police"): THREE.MeshStandardMaterial {
  let m = shared.decal.get(kind);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: carDetail(kind), transparent: true, roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -2 });
    shared.decal.set(kind, m);
  }
  return m;
}

export function buildVehicle(v: Vehicle): VehicleRig {
  initShared();
  const d = DIMS[v.kind];
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const smooth = vehicleStyle === "smooth";
  const shapes = smooth ? smoothShapes(v.kind) : { body: shared.bodyGeo.get(v.kind)!, glass: shared.glassGeo.get(v.kind)! };
  const geo = shapes.body.clone();
  const bodyMesh = new THREE.Mesh(geo, smooth ? [paint(v.colour), smoothGlass()] : paint(v.colour));
  bodyMesh.castShadow = true;
  body.add(bodyMesh);
  if (shapes.glass) body.add(new THREE.Mesh(shapes.glass, shared.glass!));
  // bumpers & sills
  const L = d.length, W = d.width;
  const bump = new THREE.Mesh(smooth ? new THREE.CapsuleGeometry(0.07, W * 0.5, 4, 10).rotateZ(Math.PI / 2) : new THREE.BoxGeometry(W + 0.04, 0.22, 0.22), shared.trim!);
  bump.position.set(0, smooth ? 0.4 : 0.36, L / 2 - (smooth ? 0.1 : 0.08));
  body.add(bump);
  const bump2 = bump.clone();
  bump2.position.z = -L / 2 + (smooth ? 0.1 : 0.08);
  body.add(bump2);
  const sill = new THREE.Mesh(new THREE.BoxGeometry(smooth ? W - 0.12 : W + 0.02, 0.12, L * 0.6), shared.trim!);
  sill.position.set(0, 0.34, 0);
  if (!smooth) body.add(sill);
  // lights
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6e0, emissive: 0xfff1cc, emissiveIntensity: 0.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x8a0f12, emissive: 0xff1a1a, emissiveIntensity: 0.15 });
  const hy = v.kind === "van" ? 0.95 : v.kind === "sports" ? 0.62 : 0.72;
  const head = new THREE.Mesh(smooth ? new THREE.CapsuleGeometry(0.05, W * 0.5, 3, 8).rotateZ(Math.PI / 2) : new THREE.BoxGeometry(W * 0.86, 0.13, 0.06), headMat);
  head.position.set(0, hy, L / 2 + (smooth ? -0.1 : 0.02));
  body.add(head);
  const tail = new THREE.Mesh(smooth ? new THREE.CapsuleGeometry(0.055, W * 0.52, 3, 8).rotateZ(Math.PI / 2) : new THREE.BoxGeometry(W * 0.9, 0.2, 0.06), tailMat);
  tail.position.set(0, hy + (v.kind === "van" ? 0.3 : 0.05), -L / 2 + (smooth ? 0.08 : -0.02));
  body.add(tail);
  // kind-specific details
  let bar: VehicleRig["bar"];
  if (v.kind === "police") {
    const red = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.13, 0.28), shared.red!.clone());
    const blue = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.13, 0.28), shared.blue!.clone());
    red.position.set(-0.32, 1.56, -0.2);
    blue.position.set(0.32, 1.56, -0.2);
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.06, 0.32), shared.trim!);
    base.position.set(0, 1.49, -0.2);
    body.add(red, blue, base);
    bar = { red, blue };
    // white doors
    const door = new THREE.Mesh(new THREE.BoxGeometry(W + 0.03, 0.42, 1.9), new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.35, metalness: 0.2 }));
    door.position.set(0, 0.72, 0.05);
    body.add(door);
    for (const s of [-1, 1]) {
      const dec = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.42), decalMat("police"));
      dec.position.set(s * (W / 2 + 0.03), 0.72, 0.05);
      dec.rotation.y = (s * Math.PI) / 2;
      body.add(dec);
    }
  }
  if (v.kind === "taxi") {
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.22, 0.3), new THREE.MeshStandardMaterial({ color: 0xfff2a0, emissive: 0xffe066, emissiveIntensity: 0.8 }));
    sign.position.set(0, 1.58, -0.2);
    body.add(sign);
    for (const s of [-1, 1]) {
      const dec = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.5), decalMat("taxi"));
      dec.position.set(s * (W / 2 + 0.03), 0.62, 0);
      dec.rotation.y = (s * Math.PI) / 2;
      body.add(dec);
    }
  }
  if (v.kind === "sports") {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(W * (smooth ? 0.7 : 0.95), 0.05, 0.32), shared.trim!);
    wing.position.set(0, 0.98, -L / 2 + 0.25);
    body.add(wing);
  }
  if (v.kind === "van") {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(W + 0.03, 0.18, 3.6), new THREE.MeshStandardMaterial({ color: 0xffb000, roughness: 0.5 }));
    stripe.position.set(0, 1.25, -0.8);
    body.add(stripe);
  }
  // wheels
  const wheels: THREE.Object3D[] = [];
  const wb = d.wheelbase / 2, tw = smooth ? W / 2 - 0.13 : W / 2 + 0.02;
  for (const [x, z] of [[tw, wb], [-tw, wb], [tw, -wb], [-tw, -wb]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.34, z);
    const tyre = new THREE.Mesh(smooth ? smoothWheel().tyre : shared.wheelGeo!, shared.tyre!);
    const rim = new THREE.Mesh(smooth ? smoothWheel().rim : shared.rimGeo!, shared.rim!);
    const spin = new THREE.Group();
    spin.add(tyre, rim);
    pivot.add(spin);
    root.add(pivot);
    wheels.push(pivot);
  }
  const cone = new THREE.Mesh(shared.coneGeo!, shared.coneMat!);
  cone.position.set(0, 0.06, L / 2 - 0.4);
  cone.visible = false;
  root.add(cone);
  return { root, body, bodyMesh, wheels, head, tail, tailMat, headMat, bar, cone, smoke: 0, basePositions: new Float32Array(geo.getAttribute("position").array as Float32Array), dentVersion: 0 };
}

/** Crumple the body mesh around dent points (local x right, z forward). */
export function applyDents(rig: VehicleRig, v: Vehicle): void {
  if (rig.dentVersion === v.dentVersion) return;
  rig.dentVersion = v.dentVersion;
  const pos = rig.bodyMesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  const col = rig.bodyMesh.geometry.getAttribute("color") as THREE.BufferAttribute;
  const base = rig.basePositions;
  for (let i = 0; i < pos.count; i++) {
    let x = base[i * 3], y = base[i * 3 + 1], z = base[i * 3 + 2];
    let dark = 1;
    for (const d of v.dents) {
      // model x is mirrored relative to sim "right" (sim right = -x in model space)
      const dx = x - -d.lx, dz = z - d.lz;
      const dist = Math.hypot(dx, dz);
      const R = 1.3;
      if (dist < R) {
        const k = (1 - dist / R) * d.amount;
        x -= Math.sign(x) * k * 0.28 * (Math.abs(d.lx) > 0.2 ? 1 : 0.3);
        z -= Math.sign(z) * k * 0.3 * (Math.abs(d.lz) > 1 ? 1 : 0.2);
        y -= k * 0.12 * (y > 0.8 ? 1 : 0.3);
        dark = Math.min(dark, 1 - k * 0.45);
      }
    }
    pos.setXYZ(i, x, y, z);
    col.setXYZ(i, dark, dark, dark);
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  rig.bodyMesh.geometry.computeVertexNormals();
}

// ------------------------------------------------------------------ people
export interface HumanRig {
  root: THREE.Group;
  hips: THREE.Group;
  torso: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  foreL: THREE.Group;
  foreR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  shinL: THREE.Group;
  shinR: THREE.Group;
  umbrella?: THREE.Group;
  fall: number;
}

let humanMat: THREE.MeshStandardMaterial | null = null;
const tc = new THREE.Color();

function coloured(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  tc.setHex(hex);
  const n = g.getAttribute("position").count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = tc.r;
    a[i * 3 + 1] = tc.g;
    a[i * 3 + 2] = tc.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  g.deleteAttribute("uv");
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute("position").count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.getAttribute("position").array as Float32Array, o * 3);
    nor.set(p.getAttribute("normal").array as Float32Array, o * 3);
    col.set(p.getAttribute("color").array as Float32Array, o * 3);
    o += p.getAttribute("position").count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

/** "block" (Gridlock City) or "smooth" (rounded capsules, smooth shading; used by Quayside). */
let humanStyle: "block" | "smooth" = "block";
let smoothMat: THREE.MeshStandardMaterial | null = null;
export function setHumanStyle(s: "block" | "smooth"): void {
  humanStyle = s;
}
const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry => {
  if (humanStyle === "block") return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  // a little fuller than the blocks, and long enough to overlap at the joints
  const W2 = w * 1.18, D2 = d * 1.18;
  const r = Math.min(W2, D2) / 2;
  if (h <= 2 * r + 0.01) {
    // small rounded part (head, hands, shoes): a squashed sphere
    return new THREE.SphereGeometry(0.5, 16, 12).scale(W2, h * 1.12, D2).translate(x, y, z);
  }
  return new THREE.CapsuleGeometry(r, Math.max(0.01, h - 2 * r + r * 1.2), 6, 16).scale(W2 / (2 * r), 1, D2 / (2 * r)).translate(x, y, z);
};

export function buildHuman(look: Look, isPlayer = false): HumanRig {
  if (!humanMat) humanMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, flatShading: true });
  if (!smoothMat) smoothMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, flatShading: false });
  const savedMat = humanMat;
  if (humanStyle === "smooth") humanMat = smoothMat;
  try {
    return buildHumanWith(look, isPlayer);
  } finally {
    humanMat = savedMat;
  }
}

function buildHumanWith(look: Look, isPlayer: boolean): HumanRig {
  const s = look.height / 1.8;
  const b = look.build;
  const root = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = 0.95 * s;
  root.add(hips);
  const torso = new THREE.Group();
  hips.add(torso);
  const torsoParts = [
    coloured(box(0.36 * b, 0.18, 0.22, 0, 0.02, 0), look.pants),
    coloured(box(0.42 * b, 0.5 * s, 0.24, 0, 0.32 * s, 0), look.shirt),
    coloured(box(0.12, 0.08, 0.12, 0, 0.6 * s, 0), look.skin),
    coloured(box(0.22, 0.25, 0.24, 0, 0.75 * s, 0.01), look.skin),
  ];
  if (look.hairStyle !== 2) torsoParts.push(coloured(box(0.24, look.hairStyle === 3 ? 0.08 : 0.1, 0.26, 0, 0.86 * s + 0.02, -0.01), look.hairStyle === 3 ? look.shirt : look.hair));
  if (look.hairStyle === 1) torsoParts.push(coloured(box(0.24, 0.22, 0.06, 0, 0.74 * s, -0.12), look.hair));
  if (look.hairStyle === 3) torsoParts.push(coloured(box(0.22, 0.03, 0.14, 0, 0.84 * s, 0.17), look.shirt));
  if (isPlayer) {
    torsoParts.push(coloured(box(0.2, 0.05, 0.03, 0, 0.78 * s, 0.13), 0x111111)); // shades
    torsoParts.push(coloured(box(0.44 * b, 0.06, 0.25, 0, 0.12 * s, 0), 0x6d4c41)); // belt
  }
  const torsoMesh = new THREE.Mesh(merge(torsoParts), humanMat!);
  torsoMesh.castShadow = true;
  torso.add(torsoMesh);
  const limb = (parent: THREE.Object3D, x: number, y: number, parts: THREE.BufferGeometry[]) => {
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    const m = new THREE.Mesh(merge(parts), humanMat!);
    m.castShadow = true;
    g.add(m);
    parent.add(g);
    return g;
  };
  const aw = 0.11, al = 0.3 * s;
  const armL = limb(torso, 0.27 * b, 0.55 * s, [coloured(box(aw, al, aw, 0, -al / 2, 0), look.shirt)]);
  const armR = limb(torso, -0.27 * b, 0.55 * s, [coloured(box(aw, al, aw, 0, -al / 2, 0), look.shirt)]);
  const foreL = limb(armL, 0, -al, [coloured(box(aw * 0.9, al, aw * 0.9, 0, -al / 2, 0), look.skin)]);
  const foreR = limb(armR, 0, -al, [coloured(box(aw * 0.9, al, aw * 0.9, 0, -al / 2, 0), look.skin)]);
  const ll = 0.46 * s, lw = 0.15;
  const legL = limb(hips, 0.1 * b, 0, [coloured(box(lw, ll, lw, 0, -ll / 2, 0), look.pants)]);
  const legR = limb(hips, -0.1 * b, 0, [coloured(box(lw, ll, lw, 0, -ll / 2, 0), look.pants)]);
  const shinL = limb(legL, 0, -ll, [coloured(box(lw * 0.9, ll, lw * 0.9, 0, -ll / 2, 0), look.pants), coloured(box(0.13, 0.08, 0.26, 0, -ll + 0.02, 0.05), look.shoes)]);
  const shinR = limb(legR, 0, -ll, [coloured(box(lw * 0.9, ll, lw * 0.9, 0, -ll / 2, 0), look.pants), coloured(box(0.13, 0.08, 0.26, 0, -ll + 0.02, 0.05), look.shoes)]);
  let umbrella: THREE.Group | undefined;
  if (look.umbrella !== undefined && !isPlayer) {
    umbrella = new THREE.Group();
    const canopy = new THREE.Mesh(coloured(new THREE.ConeGeometry(0.62, 0.32, 8).translate(0, 0.62, 0), look.umbrella), humanMat!);
    const pole = new THREE.Mesh(coloured(new THREE.CylinderGeometry(0.015, 0.015, 0.8, 4).translate(0, 0.25, 0), 0x333333), humanMat!);
    umbrella.add(canopy, pole);
    umbrella.position.set(0, -al * 0.9, 0.05);
    foreR.add(umbrella);
    umbrella.visible = false;
  }
  return { root, hips, torso, armL, armR, foreL, foreR, legL, legR, shinL, shinR, umbrella, fall: 0 };
}

/** Procedural animation with blending between idle, walk, run, sprint, jump and fall poses. */
export function animateHuman(r: HumanRig, h: Human, dt: number, raining: boolean): void {
  const sp = h.animSpeed;
  const walk = Math.min(1, sp / 1.4);
  const run = Math.max(0, Math.min(1, (sp - 2.2) / 2.2));
  const sprint = Math.max(0, Math.min(1, (sp - 5) / 2));
  const ph = h.phase;
  const swing = Math.sin(ph);
  const legAmp = 0.42 * walk + 0.38 * run + 0.15 * sprint;
  const armAmp = 0.3 * walk + 0.5 * run + 0.2 * sprint;
  const t = performance.now() / 1000;
  const breathe = Math.sin(t * 2.2 + h.id) * 0.015 * (1 - walk);
  r.legL.rotation.x = swing * legAmp;
  r.legR.rotation.x = -swing * legAmp;
  r.shinL.rotation.x = Math.max(0, -Math.sin(ph - 0.9)) * (0.5 * walk + 0.9 * run);
  r.shinR.rotation.x = Math.max(0, Math.sin(ph - 0.9)) * (0.5 * walk + 0.9 * run);
  r.armL.rotation.x = -swing * armAmp;
  r.armR.rotation.x = swing * armAmp;
  r.armL.rotation.z = 0.08 + breathe;
  r.armR.rotation.z = -0.08 - breathe;
  r.foreL.rotation.x = -(0.15 + 0.9 * run + 0.3 * sprint);
  r.foreR.rotation.x = -(0.15 + 0.9 * run + 0.3 * sprint);
  r.torso.rotation.x = 0.05 * walk + 0.12 * run + 0.12 * sprint;
  r.torso.rotation.y = swing * 0.08 * (walk + run);
  r.hips.position.y = r.hips.position.y * 0 + (0.95 * h.look.height) / 1.8 + Math.abs(Math.cos(ph)) * 0.05 * (walk + run) + breathe;
  if (h.pose === "jump") {
    r.legL.rotation.x = -0.9;
    r.legR.rotation.x = 0.1;
    r.shinL.rotation.x = 1.4;
    r.shinR.rotation.x = 0.6;
    r.armL.rotation.x = -2.4;
    r.armR.rotation.x = -2.0;
  }
  if (h.fleeing > 0 && h.pose === "move") {
    r.armL.rotation.x = -2.6 + Math.sin(ph * 2) * 0.3;
    r.armR.rotation.x = -2.6 - Math.sin(ph * 2) * 0.3;
  }
  // fall / get up blend
  const targetFall = h.pose === "knocked" ? 1 : 0;
  r.fall += (targetFall - r.fall) * Math.min(1, (h.pose === "knocked" ? 9 : 3) * dt);
  if (r.fall > 0.01) {
    r.root.rotation.x = -r.fall * Math.PI * 0.48;
    r.root.position.y += r.fall * 0.15;
    r.armL.rotation.z = 0.08 + r.fall * 1.2;
    r.armR.rotation.z = -0.08 - r.fall * 1.2;
  } else r.root.rotation.x = 0;
  if (r.umbrella) {
    const show = raining && h.fleeing <= 0 && h.pose !== "knocked";
    r.umbrella.visible = show;
    if (show) {
      r.armR.rotation.x = -1.2;
      r.foreR.rotation.x = -1.1;
    }
  }
}
