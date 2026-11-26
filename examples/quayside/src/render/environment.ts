/**
 * Ground, river, sky, sun and the post-processing grade.
 * The ground is one plane textured from the real ground-class raster (roads, paths,
 * grass, sand, timber decks); procedural detail is added in the shader so it holds up
 * close to the camera. The river is a separate reflective plane with animated normals,
 * lit by the same sky environment as the glass towers.
 */
import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { CITY, G, Raster } from "../map";

// ---------------------------------------------------------------------------- ground
const CLASS_RGB: Record<number, [number, number, number, number]> = {
  // r, g, b, material id for the shader (0 paving, 1 asphalt, 2 grass, 3 sand, 4 timber, 5 path)
  [G.URBAN]: [146, 142, 134, 0],
  [G.WATER]: [40, 70, 80, 0],
  [G.GRASS]: [92, 128, 58, 2],
  [G.WOOD]: [70, 98, 50, 2],
  [G.SAND]: [214, 196, 154, 3],
  [G.ROAD]: [70, 71, 74, 1],
  [G.ROAD_MAJOR]: [60, 61, 64, 1],
  [G.PATH]: [150, 140, 124, 5],
  [G.PLAZA]: [124, 120, 116, 0],
  [G.PIER]: [120, 92, 66, 4],
  [G.RAIL]: [92, 86, 80, 1],
  [G.BUILDING]: [120, 118, 114, 0],
  [G.BRIDGE]: [96, 96, 98, 1],
  [G.FOOTBRIDGE]: [40, 70, 80, 0],
};

export function groundTexture(r: Raster): THREE.DataTexture {
  const d = new Uint8Array(r.w * r.h * 4);
  for (let i = 0; i < r.w * r.h; i++) {
    const c = CLASS_RGB[r.data[i]] ?? CLASS_RGB[0];
    d[i * 4] = c[0];
    d[i * 4 + 1] = c[1];
    d[i * 4 + 2] = c[2];
    d[i * 4 + 3] = c[3] * 40 + (r.data[i] === G.WATER || r.data[i] === G.FOOTBRIDGE ? 0 : 20);
  }
  const t = new THREE.DataTexture(d, r.w, r.h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export const groundNight = { value: 0 };

export function buildGround(r: Raster): THREE.Mesh {
  const b = CITY.bounds;
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const geo = new THREE.PlaneGeometry(w, h, 1, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate((b.x0 + b.x1) / 2, 0, -(b.y0 + b.y1) / 2);
  const tex = groundTexture(r);
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uBounds = { value: new THREE.Vector4(b.x0, b.y1, w, h) };
    sh.uniforms.uNight = groundNight;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vWp;").replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWp = (modelMatrix * vec4(transformed,1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vWp; uniform vec4 uBounds; uniform float uNight; float gLit = 0.0;
         float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
         float gn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
           return mix(mix(gh(i),gh(i+vec2(1,0)),f.x), mix(gh(i+vec2(0,1)),gh(i+vec2(1,1)),f.x), f.y); }`,
      )
      .replace(
        "#include <map_fragment>",
        `vec2 guv = vec2((vWp.x - uBounds.x)/uBounds.z, (uBounds.y + vWp.z)/uBounds.w);
         vec4 gs = texture2D(map, guv);
         if (gs.a < 0.04) discard; // water: the river plane shows through
         float mat = floor((gs.a*255.0 - 20.0)/40.0 + 0.5);
         vec3 base = gs.rgb;
         vec2 p = vWp.xz;
         float n1 = gn(p*0.8), n2 = gn(p*6.0), n3 = gn(p*0.07);
         float rough = 0.9;
         if (mat < 0.5) { // paving: large slabs
           vec2 s = fract(p/vec2(1.2,0.6)); float joint = step(min(s.x, s.y), 0.04);
           base *= (0.88 + 0.16*gh(floor(p/vec2(1.2,0.6)))) * (1.0 - 0.18*joint);
           rough = 0.75;
         } else if (mat < 1.5) { // asphalt
           base *= 0.85 + 0.25*n2*n1 + 0.08*n3; rough = 0.82;
         } else if (mat < 2.5) { // grass
           base *= 0.75 + 0.35*n1 + 0.15*n2; base.g *= 1.0 + 0.1*n3; rough = 0.95;
         } else if (mat < 3.5) { // sand
           base *= 0.9 + 0.15*n2; rough = 0.95;
         } else if (mat < 4.5) { // timber deck boards
           float board = fract(p.x/0.18 + p.y*0.0); base *= 0.8 + 0.25*gh(vec2(floor(p.x/0.18), floor(p.y/2.4))); base *= 1.0 - 0.3*step(board, 0.08); rough = 0.7;
         } else { // footpath
           base *= 0.88 + 0.2*n2; rough = 0.8;
         }
         diffuseColor.rgb *= base;
         // street lights: warm pools along roads and paths at night
         float pool = 0.55 + 0.45*sin(p.x*0.18)*sin(p.y*0.18);
         gLit = uNight * (mat > 0.5 && mat < 1.5 ? 0.10 : mat > 4.5 ? 0.07 : 0.03) * pool;`,
      )
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = rough;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0,0.72,0.42) * gLit;");
  };
  const mesh = new THREE.Mesh(geo, m);
  mesh.receiveShadow = true;
  mesh.name = "ground";
  return mesh;
}

// ---------------------------------------------------------------------------- quay walls
/** Vertical stone walls along every land/water edge (marching squares on the water mask). */
export function buildShoreWalls(r: Raster): THREE.Mesh {
  const pos: number[] = [], nor: number[] = [];
  const res = r.res, x0 = r.x0, y1 = r.y1;
  const wet = (cx: number, cy: number) => { const c = r.cell(cx, cy); return c === G.WATER || c === G.FOOTBRIDGE; };
  const top = 0.02, bottom = -1.4;
  const seg = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number) => {
    const quad = [[ax, top, az], [bx, top, bz], [ax, bottom, az], [bx, top, bz], [bx, bottom, bz], [ax, bottom, az]];
    // winding facing (nx, nz)
    const e1 = [bx - ax, 0, bz - az], e2 = [0, bottom - top, 0];
    const cx = e1[1] * e2[2] - e1[2] * e2[1], cz = e1[0] * e2[1] - e1[1] * e2[0];
    const order = cx * nx + cz * nz >= 0 ? [0, 1, 2, 3, 4, 5] : [0, 2, 1, 3, 5, 4];
    for (const o of order) {
      pos.push(...quad[o]);
      nor.push(nx, 0, nz);
    }
  };
  // corners of cell (cx, cy) in world: x = x0 + cx*res, z = cy*res - y1
  for (let cy = 0; cy < r.h - 1; cy++)
    for (let cx = 0; cx < r.w - 1; cx++) {
      const a = wet(cx, cy), b = wet(cx + 1, cy), c = wet(cx + 1, cy + 1), d = wet(cx, cy + 1);
      const code = (a ? 8 : 0) | (b ? 4 : 0) | (c ? 2 : 0) | (d ? 1 : 0);
      if (code === 0 || code === 15) continue;
      // sample points at cell centres; edge midpoints between centres
      const X = x0 + (cx + 0.5) * res, Z = (cy + 0.5) * res - y1, h = res / 2;
      const top_ = [X + h, Z], right = [X + res, Z + h], bot = [X + h, Z + res], left = [X, Z + h];
      const segs: number[][][] = [];
      switch (code) {
        case 1: case 14: segs.push([left, bot]); break;
        case 2: case 13: segs.push([bot, right]); break;
        case 3: case 12: segs.push([left, right]); break;
        case 4: case 11: segs.push([top_, right]); break;
        case 6: case 9: segs.push([top_, bot]); break;
        case 7: case 8: segs.push([left, top_]); break;
        case 5: segs.push([left, top_], [bot, right]); break;
        case 10: segs.push([top_, right], [left, bot]); break;
      }
      for (const [p, q] of segs) {
        // normal points towards the water side
        const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
        let nx = -(q[1] - p[1]), nz = q[0] - p[0];
        const l = Math.hypot(nx, nz) || 1;
        nx /= l; nz /= l;
        if (!r.isWater(mx + nx * 0.6, mz + nz * 0.6)) { nx = -nx; nz = -nz; }
        seg(p[0], p[1], q[0], q[1], nx, nz);
      }
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x8c8378, roughness: 0.85 }));
  m.receiveShadow = true;
  m.name = "quay-walls";
  return m;
}

// ---------------------------------------------------------------------------- water
export const waterTime = { value: 0 };

export function buildWater(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(14000, 14000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.MeshStandardMaterial({ color: 0x0c2630, roughness: 0.14, metalness: 0.0, envMapIntensity: 0.8 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = waterTime;
    sh.uniforms.uNight = groundNight;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vWp;").replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWp = (modelMatrix * vec4(transformed,1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vWp; uniform float uTime; uniform float uNight;
         float wh(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
         vec2 wave(vec2 p, vec2 d, float f, float a, float s){ float ph = dot(p, d)*f + uTime*s; return d * cos(ph) * a * f; }`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
         vec2 p = vWp.xz;
         vec2 g = wave(p, normalize(vec2(1.0,0.3)), 0.21, 0.06, 1.1) + wave(p, normalize(vec2(-0.4,1.0)), 0.47, 0.04, 1.7)
                + wave(p, normalize(vec2(0.7,-0.8)), 1.13, 0.022, 2.6) + wave(p, normalize(vec2(-1.0,-0.2)), 2.31, 0.012, 3.4)
                + wave(p, normalize(vec2(0.2,1.0)), 4.7, 0.007, 4.4) + wave(p, normalize(vec2(-0.8,0.6)), 8.3, 0.004, 5.9);
         // break up the regularity with slow noise
         float wn = sin(p.x*0.013 + uTime*0.05) * sin(p.y*0.017 - uTime*0.04);
         g *= 0.75 + 0.5*wn;
         float dist = length(vWp - cameraPosition);
         // fade the ripples with distance and with screen-space frequency (no moire)
         float fw = length(fwidth(vWp.xz));
         g *= 1.0 / (1.0 + dist*0.01) * clamp(1.2 - fw*1.5, 0.15, 1.0);
         vec3 nW = normalize(vec3(-g.x, 1.0, -g.y));
         normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
         if (uNight > 0.01) {
           vec3 vD2 = normalize(cameraPosition - vWp);
           vec3 nW2 = normalize((inverse(viewMatrix) * vec4(normal, 0.0)).xyz);
           float fr = pow(1.0 - max(dot(nW2, vD2), 0.0), 3.0);
           // dusk sky and the city's glow mirrored on the surface
           vec3 glow = mix(vec3(0.05,0.06,0.11), vec3(0.22,0.14,0.10), fr) * (0.25 + 0.9*fr);
           // broken streaks of reflected street and window light, stretched toward the viewer
           vec2 cell = floor(vec2(vWp.x*0.22, vWp.z*0.9) + nW2.xz*6.0);
           float glint = step(0.93, wh(cell)) * smoothstep(0.0, 0.6, fr + 0.15) * (0.5 + 0.5*sin(uTime*2.0 + wh(cell)*40.0));
           float d2 = length(vWp - cameraPosition);
           glint *= clamp(1.0 - d2/900.0, 0.0, 1.0);
           totalEmissiveRadiance += uNight * (glow + glint * vec3(1.0, 0.72, 0.38) * 0.55);
         }`,
      );
  };
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.y = -0.45;
  mesh.receiveShadow = true;
  mesh.name = "water";
  return mesh;
}

// ---------------------------------------------------------------------------- sky, sun, env
function nightDome(radius: number): THREE.Mesh {
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, transparent: true, fog: false,
    uniforms: { uNight: { value: 0 } },
    vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w*0.99998; }`,
    fragmentShader: `uniform float uNight; varying vec3 vD;
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
      void main(){
        float y = max(vD.y, 0.0);
        vec3 col = mix(vec3(0.10,0.12,0.20), vec3(0.015,0.025,0.06), pow(y, 0.45));
        col += vec3(0.20,0.12,0.08) * pow(1.0 - y, 8.0); // city glow on the horizon
        vec3 q = floor(vD*420.0); float st = step(0.9975, h(q)) * smoothstep(0.05, 0.4, y);
        col += st * 0.8;
        gl_FragColor = vec4(col, uNight);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), m);
  mesh.renderOrder = -1;
  return mesh;
}

export class SkyRig {
  readonly sky = new Sky();
  readonly dome = nightDome(3800);
  private envDome = nightDome(900);
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xbfd8ff, 0x6b5a48, 0.45);
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envScene = new THREE.Scene();
  private envSky = new Sky();
  sunDir = new THREE.Vector3();
  night = 0;
  private lastEnvHour = -99;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, shadows: boolean) {
    this.sky.scale.setScalar(8000);
    scene.add(this.sky, this.dome, this.sun, this.sun.target, this.hemi);
    this.envSky.scale.setScalar(1000);
    this.envScene.add(this.envSky, this.envDome);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    const s = this.sun.shadow;
    this.sun.castShadow = shadows;
    s.mapSize.set(2048, 2048);
    s.camera.near = 10;
    s.camera.far = 900;
    const ext = 190;
    Object.assign(s.camera, { left: -ext, right: ext, top: ext, bottom: -ext });
    s.bias = -0.0004;
    s.normalBias = 0.6;
    for (const u of [this.sky.material.uniforms, this.envSky.material.uniforms]) {
      u.turbidity.value = 2.6;
      u.rayleigh.value = 1.1;
      u.mieCoefficient.value = 0.0022;
      u.mieDirectionalG.value = 0.8;
    }
  }

  /** hour: 0..24. Perth faces the sun from the north; the sun sets over the Indian Ocean (west). */
  update(hour: number, focus: THREE.Vector3): void {
    const dayT = (hour - 6) / 13.5; // ~06:00 sunrise, 19:30 sunset (summer)
    const elev = Math.sin(Math.PI * Math.min(1, Math.max(0, dayT))) * 68 - (dayT < 0 || dayT > 1 ? 12 * Math.min(1, Math.abs(dayT < 0 ? dayT : dayT - 1) * 6) : 0);
    const az = 90 - 180 * dayT; // east -> north -> west (degrees from north, clockwise)
    const phi = THREE.MathUtils.degToRad(90 - elev), theta = THREE.MathUtils.degToRad(az);
    // world: x east, z south. Direction to sun:
    this.sunDir.set(Math.sin(phi) * Math.sin(theta), Math.cos(phi), -Math.sin(phi) * Math.cos(theta)).normalize();
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    this.envSky.material.uniforms.sunPosition.value.copy(this.sunDir);
    const e = this.sunDir.y;
    this.night = THREE.MathUtils.clamp(1 - (e + 0.08) / 0.18, 0, 1);
    const warm = THREE.MathUtils.clamp(1 - e / 0.35, 0, 1);
    this.sun.color.setRGB(1, 0.92 - 0.25 * warm, 0.82 - 0.45 * warm);
    this.sun.intensity = 3.2 * THREE.MathUtils.clamp(e * 4, 0, 1);
    this.hemi.intensity = 0.3 + 0.25 * (1 - this.night);
    this.hemi.color.setRGB(0.75 - 0.5 * this.night, 0.85 - 0.5 * this.night, 1.0 - 0.3 * this.night);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 450);
    this.sun.target.position.copy(focus);
    // night sky: dim the scattering sky and keep a blue base via the hemisphere light
    this.sky.visible = this.night < 0.99;
    (this.dome.material as THREE.ShaderMaterial).uniforms.uNight.value = this.night;
    (this.envDome.material as THREE.ShaderMaterial).uniforms.uNight.value = this.night;
    this.renderer.toneMappingExposure = 0.36 + 0.22 * this.night;
    if (Math.abs(hour - this.lastEnvHour) > 0.25) {
      this.lastEnvHour = hour;
      this.envRT?.dispose();
      this.envRT = this.pmrem.fromScene(this.envScene, 0, 1, 2000);
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = 0.5 + 0.5 * (1 - this.night);
    }
  }
}

// ---------------------------------------------------------------------------- post
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uNight: { value: 0 }, uVignette: { value: 0.32 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uNight, uVignette; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // warm highlights, teal shadows (modern open-world grade), gentle saturation lift
      float l = dot(c, vec3(0.2126,0.7152,0.0722));
      vec3 shadowTint = mix(vec3(0.96,1.0,1.04), vec3(0.9,0.95,1.1), uNight);
      vec3 highTint = mix(vec3(1.05,1.0,0.93), vec3(1.0,0.96,1.05), uNight);
      c *= mix(shadowTint, highTint, smoothstep(0.05, 0.8, l));
      c = mix(vec3(l), c, 1.12);
      vec2 d = vUv - 0.5; c *= 1.0 - uVignette * dot(d, d) * 1.6;
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export class Post {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly grade: ShaderPass;
  readonly ao: GTAOPass | null;
  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, opts: { bloom: boolean; ao: boolean }) {
    const size = renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.ao = opts.ao ? new GTAOPass(scene, camera, size.x, size.y) : null;
    if (this.ao) {
      this.ao.blendIntensity = 0.8;
      this.composer.addPass(this.ao);
    }
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.32, 0.55, 0.88);
    this.bloom.enabled = opts.bloom;
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }
  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }
}
