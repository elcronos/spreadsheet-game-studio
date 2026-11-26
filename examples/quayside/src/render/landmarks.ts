/**
 * Elizabeth Quay's landmarks, modelled from the real positions in the map data and the
 * published dimensions: the dual-arch pedestrian bridge (arches about 22 m high, main span
 * about 45 m), Spanda (six nested carbon-fibre arcs, the largest nine storeys), the Bell
 * Tower (glass spire with copper sails), timber jetties, street trees, and the boats.
 */
import * as THREE from "three";
import { CITY, LM } from "../map";

const W = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);

function std(color: number, rough = 0.5, metal = 0, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}
export const bridgeGlow = std(0xffffff, 0.3, 0.2, { emissive: new THREE.Color(0xd01cff), emissiveIntensity: 0 });
export const spandaGlow = std(0xf4f4f2, 0.25, 0.1, { emissive: new THREE.Color(0xfff2dd), emissiveIntensity: 0 });

/** Path length parameterisation of a polyline. */
function polyAt(pts: THREE.Vector3[], t: number): { p: THREE.Vector3; dir: THREE.Vector3 } {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const L = lens[lens.length - 1], s = t * L;
  let i = 1;
  while (i < pts.length - 1 && lens[i] < s) i++;
  const u = (s - lens[i - 1]) / Math.max(1e-6, lens[i] - lens[i - 1]);
  const p = pts[i - 1].clone().lerp(pts[i], u);
  const dir = pts[i].clone().sub(pts[i - 1]).setY(0).normalize();
  return { p, dir };
}

export function buildBridge(): THREE.Group {
  const g = new THREE.Group();
  g.name = "eq-bridge";
  const raw = LM.eqBridge.pts.map(([x, y]) => W(x, y));
  const deckH = (t: number) => 1.4 + 4.6 * Math.sin(Math.PI * t);
  const N = 60;
  const left: THREE.Vector3[] = [], right: THREE.Vector3[] = [], centre: THREE.Vector3[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const { p, dir } = polyAt(raw, t);
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    p.y = deckH(t);
    centre.push(p);
    left.push(p.clone().addScaledVector(side, 2.3));
    right.push(p.clone().addScaledVector(side, -2.3));
  }
  // deck: top surface + edge beams
  const pos: number[] = [], nor: number[] = [];
  for (let i = 0; i < N; i++) {
    const a = left[i], b = right[i], c = left[i + 1], d = right[i + 1];
    for (const v of [a, b, c, b, d, c]) {
      pos.push(v.x, v.y, v.z);
      nor.push(0, 1, 0);
    }
  }
  const deck = new THREE.BufferGeometry();
  deck.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  deck.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  const deckMesh = new THREE.Mesh(deck, std(0x9b8f80, 0.8));
  deckMesh.material.side = THREE.DoubleSide;
  deckMesh.receiveShadow = deckMesh.castShadow = true;
  g.add(deckMesh);
  for (const edge of [left, right]) {
    const curve = new THREE.CatmullRomCurve3(edge);
    const beam = new THREE.Mesh(new THREE.TubeGeometry(curve, N, 0.32, 6, false), std(0xf2f2f0, 0.35, 0.2));
    beam.castShadow = true;
    g.add(beam);
    // glass balustrade, slightly blue, with a lit handrail at night
    const rail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(edge.map((v) => v.clone().setY(v.y + 1.15))), N, 0.05, 4, false), bridgeGlow);
    g.add(rail);
  }
  // two white steel arches, springing from opposite sides and crossing over the deck
  const arch = (t0: number, s0: number, t1: number, s1: number, apex: number, tApex: number) => {
    const pts: THREE.Vector3[] = [];
    const base = (t: number, s: number) => {
      const { p, dir } = polyAt(raw, t);
      return p.addScaledVector(new THREE.Vector3(-dir.z, 0, dir.x), s).setY(-0.2);
    };
    const A = base(t0, s0), B = base(t1, s1);
    const M = polyAt(raw, tApex).p.setY(apex);
    for (let i = 0; i <= 24; i++) {
      const u = i / 24;
      const q = new THREE.Vector3().lerpVectors(A, B, u);
      const mid = u < 0.5 ? new THREE.Vector3().lerpVectors(A, M, u * 2) : new THREE.Vector3().lerpVectors(M, B, (u - 0.5) * 2);
      q.lerp(mid, 0.35);
      q.y = apex * Math.sin(Math.PI * u) ** 0.85 + (1 - Math.sin(Math.PI * u)) * -0.2;
      pts.push(q);
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.55, 10, false), std(0xf6f6f4, 0.3, 0.25));
    tube.castShadow = true;
    g.add(tube);
    const glow = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.58, 10, false), bridgeGlow);
    glow.visible = false;
    glow.name = "arch-glow";
    g.add(glow);
    // hangers to the deck edges
    const hp: number[] = [];
    for (let i = 3; i <= 21; i += 2) {
      const a = curve.getPoint(i / 24);
      const near = (centre.reduce((bi, c, ci) => (c.distanceToSquared(a) < centre[bi].distanceToSquared(a) ? ci : bi), 0));
      const e = left[near].distanceToSquared(a) < right[near].distanceToSquared(a) ? left[near] : right[near];
      if (a.y > e.y + 1) hp.push(a.x, a.y, a.z, e.x, e.y + 0.3, e.z);
    }
    const hg = new THREE.BufferGeometry();
    hg.setAttribute("position", new THREE.Float32BufferAttribute(hp, 3));
    g.add(new THREE.LineSegments(hg, new THREE.LineBasicMaterial({ color: 0xdedede })));
  };
  arch(0.06, 7, 0.62, -6, 22, 0.36);
  arch(0.4, -6, 0.96, 6, 15, 0.68);
  return g;
}

export function buildSpanda(): THREE.Group {
  const g = new THREE.Group();
  g.name = "spanda";
  const c = W(LM.spanda.x, LM.spanda.y);
  const sizes = [2.6, 5.2, 8.6, 13.0, 19.5, 28.5];
  sizes.forEach((h, i) => {
    const w = h * 0.62;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 32; k++) {
      const a = Math.PI * (k / 32);
      pts.push(new THREE.Vector3(Math.cos(a) * w * 0.5, Math.sin(a) * h, 0));
    }
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.16 + h * 0.012, 8, false), spandaGlow);
    tube.castShadow = true;
    // nested arcs share one foot and fan out towards the river (south)
    tube.position.copy(c).add(new THREE.Vector3(w * 0.5 - 1.0, 0, 0));
    tube.rotation.y = -0.35 + i * 0.13;
    g.add(tube);
  });
  return g;
}

export function buildBellTower(): THREE.Group {
  const g = new THREE.Group();
  g.name = "bell-tower";
  const c = W(LM.bellTower.x, LM.bellTower.y);
  g.position.copy(c);
  const glass = std(0x9fc7cf, 0.05, 0.9, { transparent: true, opacity: 0.85 });
  const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 5.5, 82.5, 6, 1), glass);
  spire.position.y = 41.25;
  spire.castShadow = true;
  g.add(spire);
  const copper = std(0xa86a3d, 0.42, 0.9);
  for (const s of [-1, 1]) {
    const sail = new THREE.Mesh(new THREE.CylinderGeometry(9, 6.5, 44, 24, 1, true, 0, Math.PI * 0.62), copper);
    sail.material.side = THREE.DoubleSide;
    sail.position.y = 22;
    sail.rotation.y = s > 0 ? -0.4 : Math.PI - 0.4;
    sail.castShadow = true;
    g.add(sail);
  }
  const base = new THREE.Mesh(new THREE.CylinderGeometry(10, 11, 6, 6), std(0xbfb5a3, 0.8));
  base.position.y = 3;
  base.receiveShadow = base.castShadow = true;
  g.add(base);
  return g;
}

export function buildPiers(): THREE.Group {
  const g = new THREE.Group();
  g.name = "piers";
  const timber = std(0x8a6a4c, 0.75);
  const top = 0.75;
  for (const ring of CITY.piers) {
    const shape = new THREE.Shape(ring.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.45, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // shape (x, y) -> world (x, -z); extrusion goes up
    const mesh = new THREE.Mesh(geo, timber);
    mesh.position.y = top - 0.45;
    mesh.receiveShadow = mesh.castShadow = true;
    g.add(mesh);
  }
  // narrow pier walkways (lines in OSM) as 3 m boards
  const pos: number[] = [];
  for (const path of CITY.pierPaths)
    for (let i = 1; i < path.length; i++) {
      const [ax, ay] = path[i - 1], [bx, by] = path[i];
      const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1, sx = (-dy / l) * 1.5, sy = (dx / l) * 1.5;
      const q = [W(ax + sx, ay + sy, top), W(ax - sx, ay - sy, top), W(bx + sx, by + sy, top), W(bx - sx, by - sy, top)];
      for (const v of [q[0], q[2], q[1], q[1], q[2], q[3]]) pos.push(v.x, v.y, v.z);
    }
  if (pos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, timber);
    m.material.side = THREE.DoubleSide;
    m.receiveShadow = true;
    g.add(m);
  }
  // piles and black bollards along deck edges
  const pileGeo = new THREE.CylinderGeometry(0.22, 0.22, 4, 6);
  const pts: THREE.Vector3[] = [];
  for (const ring of CITY.piers)
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1], [bx, by] = ring[i], l = Math.hypot(bx - ax, by - ay);
      for (let s = 0; s < l; s += 5) pts.push(W(ax + ((bx - ax) * s) / l, ay + ((by - ay) * s) / l, top - 2));
    }
  const piles = new THREE.InstancedMesh(pileGeo, std(0x3a3632, 0.9), pts.length);
  const m4 = new THREE.Matrix4();
  pts.forEach((p, i) => piles.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z)));
  g.add(piles);
  return g;
}

export function buildTrees(): THREE.Group {
  const g = new THREE.Group();
  g.name = "trees";
  const n = CITY.trees.length;
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.3, 4, 6);
  trunkGeo.translate(0, 2, 0);
  const canopy = new THREE.IcosahedronGeometry(1, 3);
  // lumpy canopy: jitter vertices once
  const pa = canopy.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pa.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pa, i);
    const k = 0.86 + 0.16 * Math.sin(v.x * 7.3 + v.y * 5.1) * Math.cos(v.z * 6.7 - v.y * 2.3) + 0.08 * Math.sin(v.x * 17.0 + v.z * 13.0);
    pa.setXYZ(i, v.x * k * 1.15, v.y * k * 0.85, v.z * k * 1.15);
  }
  canopy.computeVertexNormals();
  const trunks = new THREE.InstancedMesh(trunkGeo, std(0x6b5644, 0.9), n);
  const leaves = new THREE.InstancedMesh(canopy, std(0xffffff, 0.8), n * 4);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  let li = 0;
  CITY.trees.forEach(([x, y], i) => {
    const r = Math.abs(Math.sin(x * 12.9898 + y * 78.233)) * 43758.5453 % 1;
    const sc = 0.75 + r * 0.8;
    m.compose(p.set(x, 0, -y), q.identity(), s.set(sc, sc, sc));
    trunks.setMatrixAt(i, m);
    for (let k = 0; k < 4; k++) {
      const a = r * 6.28 + k * 1.9;
      const off = k === 0 ? [0, 4.7, 0] : [Math.cos(a) * 1.5, 4.4 + k * 0.5, Math.sin(a) * 1.5];
      const cs = sc * (k === 0 ? 2.4 : 1.6 + 0.2 * k);
      m.compose(p.set(x + off[0] * sc, off[1] * sc, -y + off[2] * sc), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r * 6.28), s.set(cs, cs, cs));
      leaves.setMatrixAt(li, m);
      col.setHSL(0.22 + r * 0.08 + k * 0.006, 0.38 + r * 0.15, 0.17 + r * 0.07 + k * 0.012);
      leaves.setColorAt(li++, col);
    }
  });
  leaves.count = li;
  trunks.castShadow = leaves.castShadow = true;
  leaves.receiveShadow = true;
  g.add(trunks, leaves);
  return g;
}

/** 0 by day, 1 at night: lights the ferry saloons. */
export const ferryNight = { value: 0 };

/** A river ferry in white with a green band (generic livery, no operator branding). Built along +x. */
export function buildFerry(): THREE.Group {
  const g = new THREE.Group();
  g.name = "ferry";
  const white = std(0xf4f5f2, 0.32, 0.05), green = std(0x1d7a45, 0.38), glass = std(0x0e171c, 0.05, 0.7), grey = std(0x9aa0a4, 0.5, 0.4), dark = std(0x2a2f33, 0.6);
  const L = 22, B = 7.2;
  // twin hulls: rounded plan shape with a fine bow, extruded with a bevel
  const hullShape = new THREE.Shape();
  hullShape.moveTo(-L / 2, -0.9);
  hullShape.lineTo(L / 2 - 3.5, -0.9);
  hullShape.quadraticCurveTo(L / 2 + 0.6, -0.6, L / 2 + 0.9, 0);
  hullShape.quadraticCurveTo(L / 2 + 0.6, 0.6, L / 2 - 3.5, 0.9);
  hullShape.lineTo(-L / 2, 0.9);
  hullShape.lineTo(-L / 2, -0.9);
  const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 1.3, bevelEnabled: true, bevelThickness: 0.25, bevelSize: 0.25, bevelSegments: 3, curveSegments: 10 });
  hullGeo.rotateX(-Math.PI / 2);
  for (const sgn of [-1, 1]) {
    const hull = new THREE.Mesh(hullGeo, white);
    hull.position.set(0, -0.55, sgn * 2.55);
    hull.castShadow = true;
    g.add(hull);
  }
  // main deck: rounded rectangle slab with a green sheer band
  const deckShape = new THREE.Shape();
  const r = 1.4;
  deckShape.moveTo(-L / 2 + r, -B / 2);
  deckShape.lineTo(L / 2 - 2.2, -B / 2);
  deckShape.quadraticCurveTo(L / 2 + 0.4, -B / 2 + 0.4, L / 2 + 0.5, 0);
  deckShape.quadraticCurveTo(L / 2 + 0.4, B / 2 - 0.4, L / 2 - 2.2, B / 2);
  deckShape.lineTo(-L / 2 + r, B / 2);
  deckShape.quadraticCurveTo(-L / 2, B / 2, -L / 2, B / 2 - r);
  deckShape.lineTo(-L / 2, -B / 2 + r);
  deckShape.quadraticCurveTo(-L / 2, -B / 2, -L / 2 + r, -B / 2);
  const slab = (depth: number, mat: THREE.Material, y: number, sc = 1) => {
    const geo = new THREE.ExtrudeGeometry(deckShape, { depth, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2, curveSegments: 12 });
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    m.position.y = y;
    m.scale.set(sc, 1, sc);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    return m;
  };
  slab(0.45, green, 0.75, 1.003);
  slab(0.3, white, 1.2);
  // saloon: glazed all round, set back from the bow, with a raked front
  const cab = new THREE.Shape();
  cab.moveTo(-L * 0.42, -B / 2 + 0.45);
  cab.lineTo(L * 0.2, -B / 2 + 0.45);
  cab.quadraticCurveTo(L * 0.3, -B / 2 + 0.6, L * 0.31, 0);
  cab.quadraticCurveTo(L * 0.3, B / 2 - 0.6, L * 0.2, B / 2 - 0.45);
  cab.lineTo(-L * 0.42, B / 2 - 0.45);
  cab.lineTo(-L * 0.42, -B / 2 + 0.45);
  const cabin = (h: number, mat: THREE.Material, y: number, sc: number) => {
    const geo = new THREE.ExtrudeGeometry(cab, { depth: h, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 2, curveSegments: 12 });
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    m.position.y = y;
    m.scale.set(sc, 1, sc);
    m.castShadow = true;
    g.add(m);
  };
  cabin(0.7, white, 1.5, 1);
  const saloon = new THREE.MeshStandardMaterial({ color: 0x0e171c, roughness: 0.05, metalness: 0.7, emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0 });
  saloon.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = ferryNight;
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform float uNight;").replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance = vec3(1.0,0.85,0.62) * uNight * 0.9;");
  };
  cabin(1.3, saloon, 2.2, 1.004);
  cabin(0.35, white, 3.5, 1.01);
  // window mullions
  const mull: number[] = [];
  for (let x = -L * 0.42 + 1.2; x < L * 0.2; x += 1.6)
    for (const z of [-B / 2 + 0.43, B / 2 - 0.43]) mull.push(x, z);
  const mg = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 1.3, 0.06), white, mull.length / 2);
  for (let i = 0; i < mull.length / 2; i++) mg.setMatrixAt(i, new THREE.Matrix4().makeTranslation(mull[i * 2], 2.85, mull[i * 2 + 1]));
  g.add(mg);
  // upper deck rails, wheelhouse with dark wrap-around glass, mast and lights
  const rail = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 4, 40), grey);
  rail.scale.set(L * 0.36, B * 0.46, 1);
  rail.rotation.x = Math.PI / 2;
  rail.position.set(-0.6, 4.6, 0);
  g.add(rail);
  const wh = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.75, 1.6, 20), white);
  wh.scale.set(1.1, 1, 1.25);
  wh.position.set(2.6, 4.65, 0);
  wh.castShadow = true;
  g.add(wh);
  const whg = new THREE.Mesh(new THREE.CylinderGeometry(1.62, 1.66, 0.6, 20, 1, true), glass);
  whg.scale.set(1.1, 1, 1.25);
  whg.position.set(2.6, 4.95, 0);
  g.add(whg);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.4, 6), grey);
  mast.position.set(2.6, 6.6, 0);
  g.add(mast);
  const nav = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), std(0xffffff, 0.3, 0, { emissive: new THREE.Color(0xfff2c0), emissiveIntensity: 2 }));
  nav.position.set(2.6, 7.85, 0);
  g.add(nav);
  for (const [z, c] of [[-B / 2 - 0.05, 0xff2a2a], [B / 2 + 0.05, 0x22ff55]] as [number, number][]) {
    const side = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), std(c, 0.3, 0, { emissive: new THREE.Color(c), emissiveIntensity: 2 }));
    side.position.set(4.2, 3.7, z * 0.62);
    g.add(side);
  }
  // fenders and life rings
  for (let x = -L / 2 + 2; x < L / 2 - 2; x += 3.2)
    for (const z of [-B / 2 - 0.08, B / 2 + 0.08]) {
      const f = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.5, 8), dark);
      f.position.set(x, 1.0, z);
      g.add(f);
    }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.08, 6, 16), std(0xf05a28, 0.5));
  ring.position.set(-L * 0.43, 2.4, 0);
  ring.rotation.y = Math.PI / 2;
  g.add(ring);
  return g;
}

export function buildPoliceBoat(): THREE.Group {
  const g = new THREE.Group();
  g.name = "police-boat";
  const hull = new THREE.Mesh(new THREE.BoxGeometry(8.5, 1.0, 2.8), std(0x1b2a4a, 0.4));
  hull.position.y = 0.35;
  hull.castShadow = true;
  g.add(hull);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(8.55, 0.25, 2.85), std(0xf2f2f2, 0.4));
  stripe.position.y = 0.7;
  g.add(stripe);
  const console_ = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.3, 1.8), std(0xf2f2f2, 0.4));
  console_.position.set(0.2, 1.5, 0);
  g.add(console_);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 1.4), std(0x1e5bff, 0.3, 0, { emissive: new THREE.Color(0x2060ff), emissiveIntensity: 2 }));
  bar.position.set(0.2, 2.3, 0);
  bar.name = "lightbar";
  g.add(bar);
  return g;
}
