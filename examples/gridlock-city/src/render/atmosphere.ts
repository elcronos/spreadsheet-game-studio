/** Sky, sun/moon lighting, fog, ocean, clouds, rain and lightning driven by time of day and weather. */
import * as THREE from "three";
import { SHORE_X, SHORE_Z } from "../city";
import { cloudTexture } from "./textures";

interface Key {
  h: number;
  zenith: number;
  horizon: number;
  sun: number;
  sunI: number;
  hemiSky: number;
  hemiGround: number;
  hemiI: number;
  fog: number;
}

// Hand-tuned palette: cool night, peach dawn, bright tropical noon, amber golden hour, magenta-violet dusk.
const KEYS: Key[] = [
  { h: 0, zenith: 0x05070f, horizon: 0x141a33, sun: 0x8fa6ff, sunI: 0.3, hemiSky: 0x34467e, hemiGround: 0x16141f, hemiI: 0.7, fog: 0x10142a },
  { h: 5, zenith: 0x080b1a, horizon: 0x1d2140, sun: 0x8fa6ff, sunI: 0.28, hemiSky: 0x34467e, hemiGround: 0x16141f, hemiI: 0.68, fog: 0x161a33 },
  { h: 6.2, zenith: 0x3b4a7a, horizon: 0xf2a37a, sun: 0xffb27a, sunI: 0.9, hemiSky: 0x8a90c0, hemiGround: 0x5a4a40, hemiI: 0.55, fog: 0xe2a080 },
  { h: 8, zenith: 0x4a8fd8, horizon: 0xbfe0f0, sun: 0xfff0d8, sunI: 2.2, hemiSky: 0xbfe0ff, hemiGround: 0xa89a80, hemiI: 1.0, fog: 0xc6e2f0 },
  { h: 13, zenith: 0x2f7fe0, horizon: 0xbde6f7, sun: 0xffffff, sunI: 2.3, hemiSky: 0xcfeaff, hemiGround: 0xb8a888, hemiI: 1.15, fog: 0xc8e8f5 },
  { h: 17, zenith: 0x3d79c9, horizon: 0xffd6a0, sun: 0xffd29a, sunI: 2.3, hemiSky: 0xc0d0f0, hemiGround: 0xa88868, hemiI: 0.95, fog: 0xf5cfa0 },
  { h: 18.6, zenith: 0x4b4f9a, horizon: 0xff8a5c, sun: 0xff9a5a, sunI: 1.6, hemiSky: 0xb08ab8, hemiGround: 0x8a6050, hemiI: 0.85, fog: 0xff9a72 },
  { h: 19.6, zenith: 0x2a2660, horizon: 0xd8507a, sun: 0xff6a6a, sunI: 0.55, hemiSky: 0x6a4a90, hemiGround: 0x3a2430, hemiI: 0.5, fog: 0xa04878 },
  { h: 20.8, zenith: 0x0c0d24, horizon: 0x3a2350, sun: 0x9aa8ff, sunI: 0.3, hemiSky: 0x40387a, hemiGround: 0x18131f, hemiI: 0.68, fog: 0x2a1f44 },
  { h: 24, zenith: 0x05070f, horizon: 0x141a33, sun: 0x8fa6ff, sunI: 0.3, hemiSky: 0x34467e, hemiGround: 0x16141f, hemiI: 0.7, fog: 0x10142a },
];

const ca = new THREE.Color(), cb = new THREE.Color();
function lerpHex(a: number, b: number, t: number, out: THREE.Color): THREE.Color {
  ca.setHex(a);
  cb.setHex(b);
  return out.copy(ca).lerp(cb, t);
}

export class Atmosphere {
  readonly sky: THREE.Mesh;
  readonly sun = new THREE.DirectionalLight(0xffffff, 2);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
  readonly ocean: THREE.Mesh;
  readonly clouds: THREE.Mesh;
  readonly rain: THREE.LineSegments;
  private rainPos: Float32Array;
  private skyU: Record<string, THREE.IUniform>;
  private oceanU: Record<string, THREE.IUniform>;
  readonly fog: THREE.Fog;
  sunDir = new THREE.Vector3();
  night = 0;
  lightning = 0;
  private lightningTimer = 3;
  private rainAmount = 0;
  readonly horizonColour = new THREE.Color();

  constructor(private scene: THREE.Scene) {
    this.skyU = {
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color() },
      uNight: { value: 0 },
      uCloud: { value: 0 },
      uFlash: { value: 0 },
    };
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1400, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: this.skyU,
        vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w * 0.99999; }`,
        fragmentShader: `
          uniform vec3 uZenith, uHorizon, uSunDir, uSunCol; uniform float uNight, uCloud, uFlash; varying vec3 vDir;
          float hash(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
          void main(){
            vec3 d = normalize(vDir);
            float h = max(d.y, -0.1);
            vec3 col = mix(uHorizon, uZenith, pow(clamp(h,0.0,1.0), 0.55));
            float s = max(dot(d, normalize(uSunDir)), 0.0);
            // sun disc + glow (or moon at night)
            col += uSunCol * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.45 + pow(s, 3.0) * 0.12) * (1.0 - uCloud*0.7);
            // stars
            if (uNight > 0.0 && d.y > 0.05) {
              vec3 g = floor(d * 180.0);
              float st = step(0.9965, hash(g));
              col += vec3(st) * uNight * (0.6 + 0.4*sin(hash(g+3.0)*40.0)) * (1.0-uCloud);
            }
            col = mix(col, vec3(dot(col, vec3(0.33))) * 0.85, uCloud * 0.6);
            col += vec3(0.75,0.8,1.0) * uFlash;
            gl_FragColor = vec4(col, 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    );
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    scene.add(this.sky);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -75;
    sc.right = sc.top = 75;
    sc.near = 1;
    sc.far = 400;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target, this.hemi);

    this.fog = new THREE.Fog(0xffffff, 120, 700);
    scene.fog = this.fog;

    // ocean
    this.oceanU = {
      uTime: { value: 0 },
      uSky: { value: new THREE.Color() },
      uDeep: { value: new THREE.Color(0x0b4f74) },
      uShallow: { value: new THREE.Color(0x2fc4c8) },
      uSunDir: { value: new THREE.Vector3() },
      uSunCol: { value: new THREE.Color() },
      uShore: { value: new THREE.Vector2(SHORE_X, SHORE_Z) },
      uNight: { value: 0 },
      uRough: { value: 0 },
      ...THREE.UniformsLib.fog,
    };
    const oceanGeo = new THREE.PlaneGeometry(2600, 2600, 180, 180).rotateX(-Math.PI / 2);
    this.ocean = new THREE.Mesh(
      oceanGeo,
      new THREE.ShaderMaterial({
        uniforms: this.oceanU,
        fog: true,
        vertexShader: `
          uniform float uTime, uRough; uniform vec2 uShore; varying vec3 vWorld; varying vec3 vN;
          #include <fog_pars_vertex>
          void main(){
            vec3 p = (modelMatrix * vec4(position,1.0)).xyz;
            float a = 1.0 + uRough*1.5;
            float w1 = sin(p.x*0.045 + uTime*0.9)*0.35*a, w2 = sin(p.z*0.06 - uTime*1.1 + p.x*0.02)*0.25*a, w3 = sin((p.x+p.z)*0.11 + uTime*1.7)*0.08*a;
            // waves only over open water; under the land the sheet is pushed well below the ground
            float shoreD = max(p.x - uShore.x, p.z - uShore.y);
            float k = smoothstep(0.0, 25.0, shoreD);
            p.y += (w1 + w2 + w3) * k - (1.0 - step(0.0, shoreD)) * 3.0;
            float dx = cos(p.x*0.045 + uTime*0.9)*0.045*0.35*a + cos((p.x+p.z)*0.11+uTime*1.7)*0.11*0.08*a + cos(p.z*0.06 - uTime*1.1 + p.x*0.02)*0.02*0.25*a;
            float dz = cos(p.z*0.06 - uTime*1.1 + p.x*0.02)*0.06*0.25*a + cos((p.x+p.z)*0.11+uTime*1.7)*0.11*0.08*a;
            vN = normalize(vec3(-dx*6.0, 1.0, -dz*6.0));
            vWorld = p;
            vec4 mvPosition = viewMatrix * vec4(p,1.0);
            gl_Position = projectionMatrix * mvPosition;
            #include <fog_vertex>
          }`,
        fragmentShader: `
          uniform vec3 uSky, uDeep, uShallow, uSunDir, uSunCol; uniform vec2 uShore; uniform float uTime, uNight;
          varying vec3 vWorld; varying vec3 vN;
          #include <fog_pars_fragment>
          void main(){
            vec3 V = normalize(cameraPosition - vWorld);
            vec3 N = normalize(vN + vec3(sin(vWorld.x*0.9+uTime*2.0)*0.04, 0.0, cos(vWorld.z*0.8-uTime*1.7)*0.04));
            float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
            float shoreD = min(vWorld.x - uShore.x, vWorld.z - uShore.y);
            float shallow = 1.0 - smoothstep(0.0, 40.0, max(shoreD, 0.0));
            vec3 base = mix(uDeep, uShallow, shallow*0.8) * (1.0 - uNight*0.8);
            vec3 col = mix(base, uSky, 0.25 + fres*0.6);
            vec3 R = reflect(-V, N);
            float spec = pow(max(dot(R, normalize(uSunDir)), 0.0), 220.0);
            float glit = pow(max(dot(R, normalize(uSunDir)), 0.0), 18.0) * 0.25;
            col += uSunCol * (spec * 3.0 + glit);
            float foam = smoothstep(10.0, 0.0, shoreD + sin(vWorld.x*0.3 + vWorld.z*0.2 + uTime*1.5)*2.0) * 0.7;
            col = mix(col, vec3(0.95,0.97,1.0)*(1.0-uNight*0.7), foam);
            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
            #include <fog_fragment>
          }`,
      }),
    );
    this.ocean.position.set(600, -0.55, 600);
    this.ocean.receiveShadow = false;
    scene.add(this.ocean);

    // cloud layer
    const ct = cloudTexture();
    ct.repeat.set(3, 3);
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ map: ct, transparent: true, opacity: 0.35, depthWrite: false, fog: false }));
    this.clouds.position.y = 260;
    scene.add(this.clouds);

    // rain streaks around the camera
    const N = 2200;
    this.rainPos = new Float32Array(N * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.rainPos, 3));
    this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xaabbd0, transparent: true, opacity: 0.45, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    for (let i = 0; i < N; i++) this.resetDrop(i, new THREE.Vector3(), true);
    scene.add(this.rain);
  }

  private resetDrop(i: number, c: THREE.Vector3, any: boolean): void {
    const x = c.x + (Math.random() - 0.5) * 80, z = c.z + (Math.random() - 0.5) * 80;
    const y = any ? c.y + Math.random() * 40 - 10 : c.y + 30 + Math.random() * 10;
    const o = i * 6;
    this.rainPos[o] = x;
    this.rainPos[o + 1] = y;
    this.rainPos[o + 2] = z;
    this.rainPos[o + 3] = x + 0.15;
    this.rainPos[o + 4] = y - 0.9;
    this.rainPos[o + 5] = z + 0.05;
  }

  update(hours: number, weather: string, dt: number, t: number, focus: THREE.Vector3, cam: THREE.Vector3): void {
    // interpolate palette
    let i = 0;
    while (i < KEYS.length - 2 && hours >= KEYS[i + 1].h) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const k = Math.min(1, Math.max(0, (hours - a.h) / (b.h - a.h)));
    const cloud = weather === "Cloudy" ? 0.65 : weather === "Rain" ? 0.85 : weather === "Storm" ? 1 : weather === "Fog" ? 0.5 : 0;
    const zen = lerpHex(a.zenith, b.zenith, k, new THREE.Color());
    const hor = lerpHex(a.horizon, b.horizon, k, new THREE.Color());
    const grey = new THREE.Color(0x7d8794).multiplyScalar(0.4 + 0.6 * (1 - this.night));
    zen.lerp(grey, cloud * 0.8);
    hor.lerp(grey, cloud * 0.75);
    (this.skyU.uZenith.value as THREE.Color).copy(zen);
    (this.skyU.uHorizon.value as THREE.Color).copy(hor);
    this.horizonColour.copy(hor);
    // sun path: rises east (+x, over the ocean), sets west
    const day = (hours - 6) / 13; // 0 at 6h, 1 at 19h
    const ang = day * Math.PI;
    const isDay = hours > 5.6 && hours < 19.8;
    if (isDay) this.sunDir.set(Math.cos(ang), Math.max(0.04, Math.sin(ang)) * 0.9, 0.35).normalize();
    else {
      const m = ((hours + 24 - 19.8) % 24) / 9.8;
      this.sunDir.set(-Math.cos(m * Math.PI) * 0.6, Math.max(0.15, Math.sin(m * Math.PI)) * 0.8, -0.5).normalize();
    }
    (this.skyU.uSunDir.value as THREE.Vector3).copy(this.sunDir);
    const sunCol = lerpHex(a.sun, b.sun, k, new THREE.Color());
    (this.skyU.uSunCol.value as THREE.Color).copy(sunCol).multiplyScalar(isDay ? 1 : 0.35);
    this.night = hours >= 7 && hours <= 18 ? 0 : hours >= 20.5 || hours <= 5 ? 1 : hours < 7 ? 1 - (hours - 5) / 2 : (hours - 18) / 2.5;
    this.skyU.uNight.value = this.night;
    this.skyU.uCloud.value = cloud;
    // lights
    this.sun.color.copy(sunCol);
    this.sun.intensity = (a.sunI + (b.sunI - a.sunI) * k) * (1 - cloud * 0.82) + this.lightning * 4;
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 200);
    this.sun.target.position.copy(focus);
    // snap shadow camera to texels to avoid shimmering
    const texel = 150 / 2048;
    this.sun.target.position.x = Math.round(this.sun.target.position.x / texel) * texel;
    this.sun.target.position.z = Math.round(this.sun.target.position.z / texel) * texel;
    this.sun.position.x = this.sun.target.position.x + this.sunDir.x * 200;
    this.sun.position.z = this.sun.target.position.z + this.sunDir.z * 200;
    lerpHex(a.hemiSky, b.hemiSky, k, this.hemi.color);
    lerpHex(a.hemiGround, b.hemiGround, k, this.hemi.groundColor);
    this.hemi.intensity = (a.hemiI + (b.hemiI - a.hemiI) * k) * (1 - cloud * 0.2) + this.lightning * 2;
    // fog
    lerpHex(a.fog, b.fog, k, this.fog.color);
    this.fog.color.lerp(grey, cloud * 0.6);
    const fogNear = weather === "Fog" ? 8 : weather === "Storm" ? 40 : weather === "Rain" ? 60 : 140;
    const fogFar = weather === "Fog" ? 120 : weather === "Storm" ? 260 : weather === "Rain" ? 380 : 820;
    this.fog.near += (fogNear - this.fog.near) * Math.min(1, dt * 2);
    this.fog.far += (fogFar - this.fog.far) * Math.min(1, dt * 2);
    // ocean
    this.oceanU.uTime.value = t;
    (this.oceanU.uSky.value as THREE.Color).copy(hor);
    (this.oceanU.uSunDir.value as THREE.Vector3).copy(this.sunDir);
    (this.oceanU.uSunCol.value as THREE.Color).copy(sunCol).multiplyScalar(isDay ? 1 - cloud * 0.8 : 0.4);
    this.oceanU.uNight.value = this.night;
    this.oceanU.uRough.value = weather === "Storm" ? 1 : weather === "Rain" ? 0.4 : 0;
    // clouds
    (this.clouds.material as THREE.MeshBasicMaterial).opacity = 0.18 + cloud * 0.55;
    (this.clouds.material as THREE.MeshBasicMaterial).color.copy(hor).lerp(new THREE.Color(0xffffff), 0.5 - this.night * 0.4);
    const map = (this.clouds.material as THREE.MeshBasicMaterial).map!;
    map.offset.x = t * 0.002;
    map.offset.y = t * 0.001;
    this.clouds.position.x = cam.x;
    this.clouds.position.z = cam.z;
    this.sky.position.copy(cam);
    // rain
    const want = weather === "Rain" ? 0.6 : weather === "Storm" ? 1 : 0;
    this.rainAmount += (want - this.rainAmount) * Math.min(1, dt);
    this.rain.visible = this.rainAmount > 0.02;
    if (this.rain.visible) {
      const n = Math.floor((this.rainPos.length / 6) * this.rainAmount);
      this.rain.geometry.setDrawRange(0, n * 2);
      const fall = 26 * dt, wind = weather === "Storm" ? 6 * dt : 1.5 * dt;
      for (let i = 0; i < n; i++) {
        const o = i * 6;
        this.rainPos[o + 1] -= fall;
        this.rainPos[o + 4] -= fall;
        this.rainPos[o] += wind;
        this.rainPos[o + 3] += wind;
        if (this.rainPos[o + 1] < 0 || Math.abs(this.rainPos[o] - cam.x) > 45 || Math.abs(this.rainPos[o + 2] - cam.z) > 45) this.resetDrop(i, cam, false);
      }
      (this.rain.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      (this.rain.material as THREE.LineBasicMaterial).color.setScalar(0.55 + 0.4 * (1 - this.night));
    }
    // lightning
    this.lightning *= Math.exp(-dt * 9);
    if (weather === "Storm") {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightning = 1;
        this.lightningTimer = 4 + Math.random() * 9;
      }
    }
    this.skyU.uFlash.value = this.lightning * 0.6;
  }
}
