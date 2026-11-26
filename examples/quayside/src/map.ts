/**
 * The real Elizabeth Quay map (OpenStreetMap, built by scripts/quayside/build_city.py).
 * Data coordinates: x = metres east, y = metres north. World (three.js / sim): x = east,
 * z = south (z = -y), y = up.
 */
import cityJson from "../data/city.json";

export interface BuildingDef {
  /** Footprint ring (data coords, not closed). */
  p: [number, number][];
  h: number;
  minh: number;
  /** tower | office | low | heritage | residential | pavilion */
  k: string;
  n: string;
  roof: string;
}
export interface RoadDef {
  hw: string;
  name: string;
  lanes: number;
  oneway: boolean;
  bridge: boolean;
  pts: [number, number][];
}
export interface CityData {
  bounds: { x0: number; x1: number; y0: number; y1: number };
  groundRes: number;
  classes: Record<string, string>;
  buildings: BuildingDef[];
  roads: RoadDef[];
  piers: [number, number][][];
  pierPaths: [number, number][][];
  trees: [number, number][];
  landmarks: {
    spanda: { x: number; y: number };
    firstContact: { x: number; y: number };
    eqFerry: { x: number; y: number };
    mendsFerry: { x: number; y: number };
    barrackJetty: { x: number; y: number };
    bellTower: { x: number; y: number; h: number };
    eqBridge: { pts: [number, number][] };
    ferryRoute: { pts: [number, number][] };
  };
}
export const CITY = cityJson as unknown as CityData;

/** Ground classes (ground.png values). */
export const G = { URBAN: 0, WATER: 1, GRASS: 2, WOOD: 3, SAND: 4, ROAD: 5, ROAD_MAJOR: 6, PATH: 7, PLAZA: 8, PIER: 9, RAIL: 10, BUILDING: 11, BRIDGE: 12, FOOTBRIDGE: 13 } as const;

/** The ground class raster (1 m per cell). Decoded from ground.png in the browser or in Node. */
export class Raster {
  constructor(readonly w: number, readonly h: number, readonly data: Uint8Array, readonly x0 = CITY.bounds.x0, readonly y1 = CITY.bounds.y1, readonly res = CITY.groundRes) {}
  /** Class at world (x, z); outside the map counts as water so nothing leaves it. */
  at(x: number, z: number): number {
    const cx = Math.floor((x - this.x0) / this.res), cy = Math.floor((this.y1 + z) / this.res);
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return G.WATER;
    return this.data[cy * this.w + cx];
  }
  cell(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return G.WATER;
    return this.data[cy * this.w + cx];
  }
  /** Open water, including water under bridges (boats can pass). */
  isWater(x: number, z: number): boolean {
    const c = this.at(x, z);
    return c === G.WATER || c === G.FOOTBRIDGE || c === G.BRIDGE;
  }
}

export const dataToWorld = (x: number, y: number): [number, number] => [x, -y];
export const LM = CITY.landmarks;
