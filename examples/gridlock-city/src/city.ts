/**
 * Meridian Bay - the Coral Point district. Pure layout data (no rendering):
 * road graph, lanes, blocks, lots, sidewalks, crosswalks, colliders, POIs.
 *
 * Axes: +x east (towards the ocean), +z south (towards the bay), metres.
 */
export const AVENUES = [-150, -60, 30, 110, 190] as const; // N-S roads (x)
export const STREETS = [-180, -90, 0, 90, 180] as const; // E-W roads (z)
export const ROAD_W = 14;
export const BLVD_W = 22; // Ocean Boulevard (x = 190) has a palm median
export const SIDEWALK = 4.5;
export const LANE_W = 3.5;
export const COAST_Z = 250; // coastal road
export const SHORE_X = 272; // ocean edge (east)
export const SHORE_Z = 292; // bay edge (south)
export const BOUNDS = { x0: -205, x1: 420, z0: -236, z1: 420 };

export type District = "deco" | "neon" | "downtown" | "residential" | "dockside" | "park" | "commercial" | "marina" | "lot";

export function roadHalfWidthX(x: number): number {
  return x === 190 ? BLVD_W / 2 : ROAD_W / 2;
}

export interface Vec2 {
  x: number;
  z: number;
}

export interface GraphNode {
  id: number;
  x: number;
  z: number;
  /** Signalised intersection. */
  signal: boolean;
  edges: number[];
}

export interface GraphEdge {
  id: number;
  a: number;
  b: number;
  /** Centre-line polyline from a to b (inclusive). */
  pts: Vec2[];
  halfWidth: number;
  /** Lanes per direction. */
  lanes: number;
  length: number;
  name: string;
}

export interface Building {
  x: number; // centre
  z: number;
  w: number; // x size
  d: number; // z size
  h: number;
  style: "deco" | "glass" | "apartment" | "shop" | "warehouse" | "house" | "club" | "hotelTower" | "garage" | "gas" | "office";
  colour: number;
  trim: number;
  /** Which side faces the street: 0 N(-z) 1 E(+x) 2 S(+z) 3 W(-x). */
  face: number;
  sign?: { text: string; colour: number; vertical?: boolean };
  seed: number;
}

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface Block extends Rect {
  district: District;
  i: number;
  j: number;
}

export interface Poi {
  id: string;
  label: string;
  x: number;
  z: number;
  heading?: number;
}

export interface CityLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  blocks: Block[];
  buildings: Building[];
  /** Static solid boxes (buildings, walls, props) for collision. */
  solids: Rect[];
  /** Low obstacles cars collide with but cameras ignore (rails, bollards). */
  barriers: Rect[];
  alleys: Rect[];
  parking: Rect[];
  park: Rect;
  pier: Rect;
  sidewalkLoops: Vec2[][];
  crosswalks: { a: Vec2; b: Vec2; node: number; axis: "ns" | "ew" }[];
  pois: Record<string, Poi>;
  palms: Vec2[];
  trees: Vec2[];
  streetLights: { x: number; z: number; rot: number }[];
}

// ---------------------------------------------------------------- helpers
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DECO = [0xf2b5c8, 0x9fe0d8, 0xfbe3a1, 0xc9b6f0, 0xfac9a0, 0xa6d8f5, 0xf7f0e4];
const RESI = [0xe8d4b0, 0xd9a98a, 0xc4d6b8, 0xe6c3a8, 0xb9c9d9, 0xefe1c6];
const GLASS = [0x5d7a96, 0x47667f, 0x6f8fa8, 0x3d566e, 0x7aa0b8];
const NEON_COLS = [0xff2fa8, 0x22e6ff, 0xffd23f, 0x9d4dff, 0x3dff8c, 0xff5a36];
const DECO_NAMES = ["CORALINE", "THE SANDPIPER", "HOTEL AZUL", "LA PALMA", "STARLITE", "THE BREAKERS", "MARLOWE", "SEAGLASS", "COLONY", "THE PELICAN"];
const NEON_NAMES = ["ARCADE", "CLUB VOLT", "CINEMA", "LOUNGE", "DISCO", "PIZZA", "BAR 88", "TATTOO", "KARAOKE", "DINER"];
const SHOP_NAMES = ["CAFE", "SURF", "MARKET", "BOUTIQUE", "PHARMACY", "TACOS", "BAKERY", "RECORDS", "BIKES", "ICE CREAM"];

export function buildCity(): CityLayout {
  const R = rng(20261126);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeAt = new Map<string, number>();
  const addNode = (x: number, z: number, signal: boolean) => {
    const id = nodes.length;
    nodes.push({ id, x, z, signal, edges: [] });
    nodeAt.set(`${x},${z}`, id);
    return id;
  };
  for (const z of STREETS) for (const x of AVENUES) addNode(x, z, true);
  const addEdge = (a: number, b: number, pts: Vec2[], halfWidth: number, lanes: number, name: string) => {
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    const id = edges.length;
    edges.push({ id, a, b, pts, halfWidth, lanes, length, name });
    nodes[a].edges.push(id);
    nodes[b].edges.push(id);
  };
  const N = (x: number, z: number) => nodeAt.get(`${x},${z}`)!;
  const avenueNames = ["Palmetto Avenue", "Mercer Avenue", "Bayfront Avenue", "Collins Way", "Ocean Boulevard"];
  const streetNames = ["Aster Street", "Neon Mile", "Pier Street", "Harbour Street", "Dock Street"];
  for (let ai = 0; ai < AVENUES.length; ai++) {
    const x = AVENUES[ai];
    for (let si = 0; si + 1 < STREETS.length; si++) {
      const z0 = STREETS[si], z1 = STREETS[si + 1];
      addEdge(N(x, z0), N(x, z1), [{ x, z: z0 }, { x, z: z1 }], roadHalfWidthX(x), 2, avenueNames[ai]);
    }
  }
  for (let si = 0; si < STREETS.length; si++) {
    const z = STREETS[si];
    for (let ai = 0; ai + 1 < AVENUES.length; ai++) {
      const x0 = AVENUES[ai], x1 = AVENUES[ai + 1];
      addEdge(N(x0, z), N(x1, z), [{ x: x0, z }, { x: x1, z }], ROAD_W / 2, 2, streetNames[si]);
    }
  }
  // Coastal road: Ocean Blvd south end -> arc -> west along the bay -> arc -> Palmetto Ave.
  const coast: Vec2[] = [{ x: 190, z: 180 }, { x: 190, z: 205 }];
  const arc = (cx: number, cz: number, r: number, a0: number, a1: number, n: number) => {
    for (let i = 1; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      coast.push({ x: cx + r * Math.cos(a), z: cz + r * Math.sin(a) });
    }
  };
  arc(145, 205, 45, 0, Math.PI / 2, 8); // ends at (145, 250)
  coast.push({ x: -105, z: COAST_Z });
  arc(-105, 205, 45, Math.PI / 2, Math.PI, 8); // ends at (-150, 205)
  coast.push({ x: -150, z: 180 });
  addEdge(N(190, 180), N(-150, 180), coast, ROAD_W / 2, 2, "Coastal Road");

  // ---------------------------------------------------------- blocks
  const blocks: Block[] = [];
  const districtOf = (i: number, j: number): District => {
    if (i === 3) return "deco";
    if (i === 2 && j <= 1) return "neon";
    if (i === 2 && j === 2) return "park";
    if (i === 2 && j === 3) return "lot";
    if (i === 1 && j <= 1) return "downtown";
    if (i === 1 && j === 2) return "commercial";
    if (j === 3) return "dockside";
    return "residential";
  };
  for (let i = 0; i + 1 < AVENUES.length; i++)
    for (let j = 0; j + 1 < STREETS.length; j++) {
      const xa = AVENUES[i], xb = AVENUES[i + 1], za = STREETS[j], zb = STREETS[j + 1];
      blocks.push({ x0: xa + roadHalfWidthX(xa), x1: xb - roadHalfWidthX(xb), z0: za + ROAD_W / 2, z1: zb - ROAD_W / 2, district: districtOf(i, j), i, j });
    }
  // edge strips
  blocks.push({ x0: BOUNDS.x0 + 6, x1: 190 - BLVD_W / 2, z0: BOUNDS.z0 + 6, z1: -180 - ROAD_W / 2, district: "downtown", i: -1, j: -1 });
  blocks.push({ x0: BOUNDS.x0 + 6, x1: -150 - ROAD_W / 2, z0: -180 - ROAD_W / 2, z1: 180 + ROAD_W / 2 + 20, district: "residential", i: -1, j: 0 });
  blocks.push({ x0: -150 + ROAD_W / 2, x1: 190 - ROAD_W / 2, z0: 180 + ROAD_W / 2, z1: 0, district: "marina", i: 9, j: 9 }); // z1 fixed below
  const marina = blocks[blocks.length - 1];
  marina.z1 = COAST_Z - ROAD_W / 2; // straight part; arcs trimmed when placing lots

  // ---------------------------------------------------------- lots & buildings
  const buildings: Building[] = [];
  const solids: Rect[] = [];
  const alleys: Rect[] = [];
  const parking: Rect[] = [];
  const palms: Vec2[] = [];
  const trees: Vec2[] = [];
  let seed = 1;
  const addB = (b: Omit<Building, "seed">) => {
    const bb: Building = { ...b, seed: seed++ };
    buildings.push(bb);
    solids.push({ x0: b.x - b.w / 2, x1: b.x + b.w / 2, z0: b.z - b.d / 2, z1: b.z + b.d / 2 });
  };
  const pick = <T,>(a: readonly T[]) => a[Math.floor(R() * a.length)];

  /** Fill one side of a rectangle with buildings fronting outward. */
  const frontage = (r: Rect, side: number, depthMin: number, depthMax: number, maker: (x: number, z: number, w: number, d: number, face: number, idx: number) => void, wMin = 12, wMax = 26, skip?: (a: number, b: number) => boolean) => {
    const along = side === 0 || side === 2;
    const a0 = along ? r.x0 : r.z0, a1 = along ? r.x1 : r.z1;
    let a = a0, idx = 0;
    while (a < a1 - 6) {
      let w = wMin + R() * (wMax - wMin);
      if (a1 - (a + w) < wMin * 0.8) w = a1 - a;
      if (skip && skip(a, a + w)) {
        a += w;
        continue;
      }
      const d = depthMin + R() * (depthMax - depthMin);
      const c = a + w / 2;
      if (side === 0) maker(c, r.z0 + d / 2, w - 0.6, d, 0, idx);
      if (side === 2) maker(c, r.z1 - d / 2, w - 0.6, d, 2, idx);
      if (side === 1) maker(r.x1 - d / 2, c, d, w - 0.6, 1, idx);
      if (side === 3) maker(r.x0 + d / 2, c, d, w - 0.6, 3, idx);
      a += w;
      idx++;
    }
  };
  const inner = (b: Rect, m: number): Rect => ({ x0: b.x0 + m, x1: b.x1 - m, z0: b.z0 + m, z1: b.z1 - m });

  /** Buildings around a rectangle without corner overlaps: N/S sides span full width, E/W sides fill between. */
  const ring = (r: Rect, sides: number[], band: number, maker: (x: number, z: number, w: number, d: number, face: number, idx: number) => void, wMin: number, wMax: number, skip?: (side: number, a0: number, a1: number) => boolean) => {
    const hasN = sides.includes(0), hasS = sides.includes(2);
    for (const sd of sides) {
      const rr: Rect = sd % 2 === 1 ? { ...r, z0: r.z0 + (hasN ? band + 1 : 0), z1: r.z1 - (hasS ? band + 1 : 0) } : r;
      frontage(rr, sd, band * 0.7, band, maker, wMin, wMax, skip ? (a0, a1) => skip(sd, a0, a1) : undefined);
    }
  };
  const pois: Record<string, Poi> = {};

  for (const blk of blocks) {
    const r = inner(blk, SIDEWALK);
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    switch (blk.district) {
      case "deco": {
        // Hotels on the boulevard side, shops on the avenue side, service alley between.
        const ax = r.x0 + (r.x1 - r.x0) * 0.42;
        alleys.push({ x0: ax - 3, x1: ax + 3, z0: blk.z0, z1: blk.z1 });
        const east: Rect = { ...r, x0: ax + 3 };
        const west: Rect = { ...r, x1: ax - 3 };
        frontage(east, 1, 22, east.x1 - east.x0, (x, z, w, d, face, idx) => {
          const tower = blk.j === 1 && idx === 1;
          if (tower) {
            addB({ x, z, w, d, h: 74, style: "hotelTower", colour: 0xf7efe2, trim: 0x2fd6c8, face, sign: { text: "THE MERIDIAN", colour: 0xff3fb4, vertical: true } });
            pois.meridian = { id: "meridian", label: "The Meridian Hotel", x: x + d / 2 + 8, z, heading: Math.PI / 2 };
          } else
            addB({ x, z, w, d, h: 14 + R() * 16, style: "deco", colour: pick(DECO), trim: pick([0xffffff, 0x1fb5a8, 0xf06292, 0xffb74d]), face, sign: { text: pick(DECO_NAMES), colour: pick(NEON_COLS), vertical: R() < 0.5 } });
        }, 16, 26);
        frontage(west, 3, 12, west.x1 - west.x0, (x, z, w, d, face) => addB({ x, z, w, d, h: 7 + R() * 6, style: "shop", colour: pick(DECO), trim: 0xffffff, face, sign: { text: pick(SHOP_NAMES), colour: pick(NEON_COLS) } }), 10, 16);
        break;
      }
      case "neon": {
        const az = cz;
        alleys.push({ x0: blk.x0, x1: blk.x1, z0: az - 3, z1: az + 3 });
        const north: Rect = { ...r, z1: az - 3 }, south: Rect = { ...r, z0: az + 3 };
        const mk = (x: number, z: number, w: number, d: number, face: number) =>
          addB({ x, z, w, d, h: 9 + R() * 12, style: "club", colour: pick([0x2a2640, 0x3a2b4f, 0x24344a, 0x40283a, 0x2d3a3a]), trim: pick(NEON_COLS), face, sign: { text: pick(NEON_NAMES), colour: pick(NEON_COLS), vertical: R() < 0.4 } });
        frontage(north, 0, 14, north.z1 - north.z0, mk, 11, 18);
        frontage(south, 2, 14, south.z1 - south.z0, mk, 11, 18);
        break;
      }
      case "downtown": {
        const strip = blk.i === -1;
        if (!strip && blk.j === 0) {
          // plaza with radio mast + towers on the corners
          pois.mast = { id: "mast", label: "Radio Meridian mast", x: cx, z: cz };
          const q = (r.x1 - r.x0) / 2 - 2;
          for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const)
            addB({ x: cx + sx * (q / 2 + 6), z: cz + sz * (q / 2 + 6), w: q - 10, d: q - 10, h: 40 + R() * 50, style: "glass", colour: pick(GLASS), trim: 0xd8e2ea, face: sz < 0 ? 0 : 2 });
          solids.push({ x0: cx - 2, x1: cx + 2, z0: cz - 2, z1: cz + 2 });
        } else {
          const band = strip ? r.z1 - r.z0 : Math.min(26, (r.x1 - r.x0) / 2 - 2);
          ring(r, strip ? [2] : [0, 1, 2, 3], band, (x, z, w, d, face) => {
            const tall = R() < 0.6;
            addB({ x, z, w, d, h: tall ? 34 + R() * 60 : 16 + R() * 14, style: tall ? "glass" : "office", colour: tall ? pick(GLASS) : pick([0xcfc7bb, 0xb8b0a5, 0xd6cfc4, 0x9fa7ad]), trim: 0xe8eef2, face });
          }, 18, 30);
        }
        break;
      }
      case "residential": {
        const strip = blk.i === -1;
        if (!strip) {
          const az = cz;
          alleys.push({ x0: blk.x0, x1: blk.x1, z0: az - 3, z1: az + 3 });
        }
        const mk = (x: number, z: number, w: number, d: number, face: number) => {
          const apt = R() < 0.55;
          addB({ x, z, w, d, h: apt ? 10 + R() * 10 : 5 + R() * 2.5, style: apt ? "apartment" : "house", colour: pick(RESI), trim: pick([0xffffff, 0x6d4c41, 0x2e7d6b]), face });
          if (!apt && R() < 0.7) palms.push({ x: face % 2 ? (face === 1 ? x + d / 2 + 1.2 : x - d / 2 - 1.2) : x, z: face % 2 ? z : face === 2 ? z + d / 2 + 1.2 : z - d / 2 - 1.2 });
        };
        if (strip) frontage(r, 1, 12, 18, mk, 11, 18);
        else {
          const band = Math.min(16, (cz - 3 - r.z0) - 2);
          ring({ ...r, z1: cz - 3 }, [0, 1, 3], band, mk, 11, 18);
          ring({ ...r, z0: cz + 3 }, [2, 1, 3], band, mk, 11, 18);
        }
        break;
      }
      case "commercial": {
        // strip mall with parking court in the middle
        parking.push(inner(r, 16));
        ring(r, [0, 1, 2, 3], 14, (x, z, w, d, face) => addB({ x, z, w, d, h: 6 + R() * 4, style: "shop", colour: pick([...DECO, ...RESI]), trim: 0xffffff, face, sign: { text: pick(SHOP_NAMES), colour: pick(NEON_COLS) } }), 10, 16, (sd, a0, a1) => (sd === 1 || sd === 3) && a1 > cz - 8 && a0 < cz + 8);
        break;
      }
      case "dockside": {
        if (blk.i === 0) {
          // Porter Logistics depot: warehouse + open yard
          addB({ x: r.x0 + 18, z: cz, w: 32, d: r.z1 - r.z0 - 4, h: 11, style: "warehouse", colour: 0x9a8f80, trim: 0xe0a030, face: 1, sign: { text: "PORTER LOGISTICS", colour: 0xffb000 } });
          parking.push({ x0: r.x0 + 38, x1: r.x1, z0: r.z0, z1: r.z1 });
          pois.depot = { id: "depot", label: "Porter Logistics depot", x: r.x0 + 52, z: cz, heading: Math.PI / 2 };
        } else {
          // garages + body shop
          frontage(r, 0, 16, 22, (x, z, w, d, face) => addB({ x, z, w, d, h: 8 + R() * 3, style: "garage", colour: pick([0x8d8478, 0x7b8a8f, 0xa59a86]), trim: 0xf0c419, face }), 14, 20);
          addB({ x: r.x1 - 15, z: r.z1 - 11, w: 28, d: 20, h: 8, style: "garage", colour: 0x6e7f86, trim: 0x2fd6c8, face: 2, sign: { text: "BODY SHOP", colour: 0x22e6ff } });
          pois.garage = { id: "garage", label: "Bayside Body Shop", x: r.x1 - 15, z: r.z1 + SIDEWALK + 4, heading: 0 };
          parking.push({ x0: r.x0 + 4, x1: r.x1 - 34, z0: r.z0 + 26, z1: r.z1 });
        }
        break;
      }
      case "park": {
        pois.park = { id: "park", label: "Bayfront Park", x: cx, z: cz };
        for (let k = 0; k < 26; k++) {
          const x = r.x0 + 4 + R() * (r.x1 - r.x0 - 8), z = r.z0 + 4 + R() * (r.z1 - r.z0 - 8);
          if (Math.hypot(x - cx, z - cz) < 12 || Math.abs(x - cx) < 3 || Math.abs(z - cz) < 3) continue;
          (R() < 0.5 ? palms : trees).push({ x, z });
        }
        solids.push({ x0: cx - 4, x1: cx + 4, z0: cz - 4, z1: cz + 4 }); // fountain
        break;
      }
      case "lot": {
        parking.push({ x0: r.x0, x1: r.x1 - 30, z0: r.z0, z1: r.z1 });
        addB({ x: r.x1 - 12, z: r.z1 - 10, w: 20, d: 14, h: 5, style: "gas", colour: 0xf4f1ea, trim: 0xe53935, face: 2, sign: { text: "BAYGAS", colour: 0xff3b30 } });
        pois.gas = { id: "gas", label: "BayGas station", x: r.x1 - 12, z: r.z0 + 16 };
        solids.push({ x0: r.x1 - 18, x1: r.x1 - 16, z0: r.z0 + 12, z1: r.z0 + 20 }, { x0: r.x1 - 8, x1: r.x1 - 6, z0: r.z0 + 12, z1: r.z0 + 20 });
        break;
      }
      case "marina": {
        const mr: Rect = { x0: r.x0 + 40, x1: r.x1 - 40, z0: r.z0, z1: r.z1 };
        frontage(mr, 2, 14, 22, (x, z, w, d, face) => addB({ x, z, w, d, h: 6 + R() * 6, style: R() < 0.5 ? "warehouse" : "shop", colour: pick([0xb0a290, 0x8fa3a8, 0xc7b79a, 0xd4c3a3]), trim: 0x2fd6c8, face, sign: R() < 0.4 ? { text: pick(["BAIT & TACKLE", "FISH MARKET", "BOATYARD", "CHANDLERY"]), colour: pick(NEON_COLS) } : undefined }), 14, 24);
        frontage(mr, 0, 12, 16, (x, z, w, d, face) => addB({ x, z, w, d, h: 6 + R() * 4, style: "warehouse", colour: pick([0xa59a86, 0x8d8478]), trim: 0xf0c419, face }), 16, 26);
        break;
      }
    }
  }
  // Hospital / police station POIs (respawn points), race start, showroom
  pois.hospital = { id: "hospital", label: "Mercy Bay Hospital", x: -60 - 9.2, z: -45, heading: Math.PI };
  pois.policeStation = { id: "policeStation", label: "Coral Point Police", x: 30 + 12, z: 135, heading: 0 };
  pois.raceStart = { id: "raceStart", label: "Neon Mile Sprint", x: 70, z: -90 - 9.2, heading: -Math.PI / 2 };
  pois.showroom = { id: "showroom", label: "Velocity Motors", x: -60 - 9.2, z: 45, heading: Math.PI };
  pois.spawn = { id: "spawn", label: "Pier Street", x: 196 + 12, z: 8, heading: -Math.PI / 2 };
  pois.hideout = { id: "hideout", label: "Hideout lock-up", x: -105, z: 195 + 30, heading: 0 };
  pois.market = { id: "market", label: "Palmetto Market", x: -105, z: -90 + 4.5, heading: 0 };

  // Palm median on Ocean Boulevard and palms along the beach and coastal road
  for (let z = -175; z <= 175; z += 14) if (Math.abs(z % 90) > 12 && Math.abs(z % 90) < 78) palms.push({ x: 190, z });
  for (let z = -170; z <= 240; z += 18) palms.push({ x: 205 + 3 * Math.sin(z), z });
  for (let x = -120; x <= 140; x += 22) palms.push({ x, z: COAST_Z + 12 });
  // Ocean side sea wall barriers and pier
  const pier: Rect = { x0: 201, x1: SHORE_X + 92, z0: -7, z1: 7 };
  const barriers: Rect[] = [];
  barriers.push({ x0: SHORE_X, x1: SHORE_X + 2, z0: BOUNDS.z0, z1: pier.z0 });
  barriers.push({ x0: SHORE_X, x1: SHORE_X + 2, z0: pier.z1, z1: SHORE_Z });
  barriers.push({ x0: BOUNDS.x0, x1: SHORE_X + 2, z0: SHORE_Z, z1: SHORE_Z + 2 });
  barriers.push({ x0: SHORE_X, x1: pier.x1, z0: pier.z0 - 1, z1: pier.z0 }, { x0: SHORE_X, x1: pier.x1, z0: pier.z1, z1: pier.z1 + 1 }, { x0: pier.x1, x1: pier.x1 + 1, z0: pier.z0, z1: pier.z1 });
  // world boundary walls
  barriers.push({ x0: BOUNDS.x0 - 2, x1: BOUNDS.x0, z0: BOUNDS.z0, z1: BOUNDS.z1 }, { x0: BOUNDS.x0, x1: BOUNDS.x1, z0: BOUNDS.z0 - 2, z1: BOUNDS.z0 });
  // lifeguard towers on the beach
  for (const z of [-120, -40, 60, 150]) solids.push({ x0: 238, x1: 242, z0: z - 2, z1: z + 2 });
  pois.lighthouse = { id: "lighthouse", label: "Coral Point Light", x: 252, z: 272 };
  solids.push({ x0: 247, x1: 257, z0: 267, z1: 277 });
  pois.wheel = { id: "wheel", label: "Pier Wheel", x: SHORE_X + 70, z: 0 };

  // Sidewalk loops (pedestrian paths), 2.2 m in from the kerb.
  const sidewalkLoops: Vec2[][] = [];
  for (const b of blocks) {
    if (b.i < 0 || b.i > 8) continue;
    const m = 2.2;
    sidewalkLoops.push([
      { x: b.x0 + m, z: b.z0 + m },
      { x: b.x1 - m, z: b.z0 + m },
      { x: b.x1 - m, z: b.z1 - m },
      { x: b.x0 + m, z: b.z1 - m },
    ]);
  }
  // beachfront promenade
  sidewalkLoops.push([{ x: 214, z: -175 }, { x: 214, z: 230 }, { x: 228, z: 230 }, { x: 228, z: -175 }]);

  const crosswalks: CityLayout["crosswalks"] = [];
  for (const n of nodes) {
    const hw = roadHalfWidthX(n.x), hs = ROAD_W / 2;
    // N and S arms cross the avenue (east-west walk), E and W arms cross the street.
    crosswalks.push({ a: { x: n.x - hw - 2.2, z: n.z - hs - 1.5 }, b: { x: n.x + hw + 2.2, z: n.z - hs - 1.5 }, node: n.id, axis: "ew" });
    crosswalks.push({ a: { x: n.x - hw - 2.2, z: n.z + hs + 1.5 }, b: { x: n.x + hw + 2.2, z: n.z + hs + 1.5 }, node: n.id, axis: "ew" });
    crosswalks.push({ a: { x: n.x - hw - 1.5, z: n.z - hs - 2.2 }, b: { x: n.x - hw - 1.5, z: n.z + hs + 2.2 }, node: n.id, axis: "ns" });
    crosswalks.push({ a: { x: n.x + hw + 1.5, z: n.z - hs - 2.2 }, b: { x: n.x + hw + 1.5, z: n.z + hs + 2.2 }, node: n.id, axis: "ns" });
  }

  const streetLights: CityLayout["streetLights"] = [];
  for (const e of edges) {
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b = e.pts[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;
      for (let s = 16; s < len - 12; s += 30) {
        const px = a.x + dx * s, pz = a.z + dz * s;
        const off = e.halfWidth + 0.8;
        streetLights.push({ x: px - dz * off, z: pz + dx * off, rot: Math.atan2(dx, dz) });
        if (e.halfWidth > 8) streetLights.push({ x: px + dz * off, z: pz - dx * off, rot: Math.atan2(-dx, -dz) });
      }
    }
  }
  const parkBlock = blocks.find((b) => b.district === "park")!;
  return { nodes, edges, blocks, buildings, solids, barriers, alleys, parking, park: inner(parkBlock, SIDEWALK), pier, sidewalkLoops, crosswalks, pois, palms, trees, streetLights };
}

/** Is a point on drivable surface (road, alley, parking, pier, sand)? Used for spawning and AI. */
export function nearestEdgePoint(city: CityLayout, x: number, z: number): { edge: GraphEdge; t: number; dist: number; seg: number } {
  let best = { edge: city.edges[0], t: 0, dist: 1e9, seg: 0 };
  for (const e of city.edges) {
    let acc = 0;
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b = e.pts[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      const len = Math.sqrt(l2);
      let u = ((x - a.x) * dx + (z - a.z) * dz) / l2;
      u = Math.max(0, Math.min(1, u));
      const px = a.x + dx * u, pz = a.z + dz * u;
      const d = Math.hypot(x - px, z - pz);
      if (d < best.dist) best = { edge: e, t: (acc + u * len) / e.length, dist: d, seg: i - 1 };
      acc += len;
    }
  }
  return best;
}

/** Point and tangent at distance s along an edge polyline. */
export function edgePointAt(e: GraphEdge, s: number): { x: number; z: number; dx: number; dz: number } {
  s = Math.max(0, Math.min(e.length, s));
  let acc = 0;
  for (let i = 1; i < e.pts.length; i++) {
    const a = e.pts[i - 1], b = e.pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (acc + len >= s || i === e.pts.length - 1) {
      const u = len > 0 ? (s - acc) / len : 0;
      return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len };
    }
    acc += len;
  }
  const p = e.pts[e.pts.length - 1];
  return { x: p.x, z: p.z, dx: 1, dz: 0 };
}
