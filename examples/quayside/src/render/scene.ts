/**
 * Assembles the Elizabeth Quay scene: real buildings with procedural facades, ground and
 * river, sky and sun, landmarks, trees, jetties. Owns the renderer and post stack.
 */
import * as THREE from "three";
import { CITY, Raster } from "../map";
import { buildingGeometries, facadeMaterial, nightUniform, Kind } from "./facades";
import { buildGround, buildShoreWalls, buildWater, groundNight, Post, SkyRig, waterTime } from "./environment";
import { buildBellTower, buildBridge, buildPiers, buildSpanda, buildTrees, bridgeGlow, ferryNight, spandaGlow } from "./landmarks";

export interface SceneOptions {
  shadows: boolean;
  bloom: boolean;
  ao: boolean;
  pixelRatio: number;
}

export class QuaysideScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.3, 9000);
  readonly sky: SkyRig;
  readonly post: Post;
  readonly bridge: THREE.Group;
  private materials: THREE.MeshStandardMaterial[] = [];
  hour = 17.6;

  constructor(readonly raster: Raster, readonly canvas: HTMLCanvasElement, private opts: SceneOptions) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(opts.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = opts.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.fog = new THREE.FogExp2(0xa9c3d6, 0.00016);
    this.sky = new SkyRig(this.renderer, this.scene, opts.shadows);
    this.scene.add(buildGround(raster));
    this.scene.add(buildWater(), buildShoreWalls(raster));
    const skip = (b: { n: string }) => b.n === "The Bell Tower";
    for (const [kind, geo] of buildingGeometries(CITY.buildings, skip)) {
      const m = facadeMaterial(kind as Kind);
      this.materials.push(m);
      const mesh = new THREE.Mesh(geo, m);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.name = "buildings-" + kind;
      this.scene.add(mesh);
    }
    this.bridge = buildBridge();
    this.scene.add(this.bridge, buildSpanda(), buildBellTower(), buildPiers(), buildTrees());
    this.post = new Post(this.renderer, this.scene, this.camera, { bloom: opts.bloom, ao: opts.ao });
  }

  setSize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h);
  }

  update(dt: number, focus: THREE.Vector3): void {
    waterTime.value += dt;
    this.sky.update(this.hour, focus);
    const n = this.sky.night;
    nightUniform.value = n;
    groundNight.value = n;
    ferryNight.value = n;
    bridgeGlow.emissiveIntensity = 1.1 * n;
    spandaGlow.emissiveIntensity = 0.6 * n;
    this.bridge.traverse((o) => {
      if (o.name === "arch-glow") o.visible = n > 0.3;
    });
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.setRGB(0.55 - 0.47 * n, 0.66 - 0.56 * n, 0.78 - 0.6 * n);
    this.post.grade.uniforms.uNight.value = n;
    // daylight sky is far above 1.0 in linear HDR: only real highlights should bloom
    this.post.bloom.threshold = 3.2 - 2.35 * n;
    this.post.bloom.strength = 0.18 + 0.3 * n;
  }

  render(): void {
    this.post.composer.render();
  }
}

/** Decode ground.png (red channel = class) in the browser. */
export async function loadRasterBrowser(url: string): Promise<Raster> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const out = new Uint8Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
  return new Raster(c.width, c.height, out);
}
