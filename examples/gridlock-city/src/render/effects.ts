/** Pooled GPU particles (smoke, sparks, fire, debris, splashes) and mission markers. */
import * as THREE from "three";

class ParticlePool {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grow: Float32Array;
  private drag: Float32Array;
  private grav: Float32Array;
  private next = 0;
  constructor(scene: THREE.Scene, private n: number, additive: boolean) {
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.grow = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.grav = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    g.setAttribute("size", new THREE.BufferAttribute(this.size, 1));
    g.setAttribute("alpha", new THREE.BufferAttribute(this.alpha, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uScale: { value: 600 } },
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; varying vec3 vC; varying float vA; uniform float uScale;
        void main(){ vC = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * uScale / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vC; varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard; float a = smoothstep(0.5, 0.0, r) * vA; gl_FragColor = vec4(vC, a); }`,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  setScale(s: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = s;
  }
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, colour: number, size: number, life: number, grow = 0, drag = 0.5, grav = 0): void {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col[i * 3] = ((colour >> 16) & 255) / 255;
    this.col[i * 3 + 1] = ((colour >> 8) & 255) / 255;
    this.col[i * 3 + 2] = (colour & 255) / 255;
    this.size[i] = size;
    this.life[i] = this.maxLife[i] = life;
    this.grow[i] = grow;
    this.drag[i] = drag;
    this.grav[i] = grav;
  }
  update(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.05 && this.grav[i] > 0) {
        this.pos[i * 3 + 1] = 0.05;
        this.vel[i * 3 + 1] *= -0.3;
      }
      this.size[i] += this.grow[i] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.min(1, t * 2) * (t > 0.9 ? (1 - t) * 10 : 1);
    }
    const g = this.points.geometry;
    for (const a of ["position", "color", "size", "alpha"]) (g.getAttribute(a) as THREE.BufferAttribute).needsUpdate = true;
  }
}

export class Effects {
  readonly smoke: ParticlePool;
  readonly glow: ParticlePool;
  readonly flash: THREE.PointLight;
  private flashT = 0;
  readonly markers = new THREE.Group();
  private beamGeo = new THREE.CylinderGeometry(1, 1, 60, 16, 1, true).translate(0, 30, 0);
  private ringGeo = new THREE.TorusGeometry(1, 0.08, 6, 32).rotateX(Math.PI / 2);
  private pool: THREE.Mesh[] = [];
  private ringPool: THREE.Mesh[] = [];
  constructor(scene: THREE.Scene) {
    this.smoke = new ParticlePool(scene, 1400, false);
    this.glow = new ParticlePool(scene, 1400, true);
    this.flash = new THREE.PointLight(0xffa040, 0, 60, 1.6);
    scene.add(this.flash, this.markers);
  }
  setViewportHeight(h: number): void {
    this.smoke.setScale(h * 0.9);
    this.glow.setScale(h * 0.9);
  }
  sparks(x: number, y: number, z: number, n: number, speed = 6): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, u = Math.random();
      this.glow.emit(x, y, z, Math.cos(a) * speed * u, 2 + Math.random() * speed * 0.6, Math.sin(a) * speed * u, Math.random() < 0.5 ? 0xffd27a : 0xff8a30, 0.12 + Math.random() * 0.1, 0.4 + Math.random() * 0.4, 0, 1, 14);
    }
  }
  puff(x: number, y: number, z: number, colour: number, size: number, life: number, rise = 1.2): void {
    this.smoke.emit(x + (Math.random() - 0.5) * 0.4, y, z + (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.6, rise, (Math.random() - 0.5) * 0.6, colour, size, life, size * 1.2, 0.6);
  }
  fire(x: number, y: number, z: number): void {
    this.glow.emit(x + (Math.random() - 0.5) * 0.8, y, z + (Math.random() - 0.5) * 0.8, 0, 2 + Math.random() * 2, 0, Math.random() < 0.5 ? 0xff7a1a : 0xffc040, 0.7 + Math.random() * 0.5, 0.5, -0.6, 0.5);
  }
  explosion(x: number, z: number): void {
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * 1.2, s = 4 + Math.random() * 9;
      this.glow.emit(x, 1, z, Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s + 2, Math.sin(a) * Math.cos(e) * s, i % 3 ? 0xff8c2a : 0xffe08a, 1.2 + Math.random(), 0.7 + Math.random() * 0.5, -0.8, 2.5);
    }
    for (let i = 0; i < 30; i++) this.puff(x, 1.5, z, 0x2a2a2a, 2.5, 3 + Math.random() * 2, 3);
    this.sparks(x, 1, z, 40, 12);
    this.flash.position.set(x, 4, z);
    this.flashT = 1;
  }
  splashPed(x: number, z: number): void {
    for (let i = 0; i < 10; i++) this.puff(x, 0.4, z, 0xd9cfc0, 0.6, 0.8, 0.8);
  }
  update(dt: number): void {
    this.smoke.update(dt);
    this.glow.update(dt);
    this.flashT *= Math.exp(-dt * 5);
    this.flash.intensity = this.flashT * 4000;
  }

  /** Mission beams and checkpoint rings. */
  setMarkers(list: { x: number; z: number; r: number; colour: number; kind: string }[], t: number, night: number): void {
    let bi = 0, ri = 0;
    for (const m of list) {
      let beam = this.pool[bi];
      if (!beam) {
        beam = new THREE.Mesh(this.beamGeo, new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
        this.pool.push(beam);
        this.markers.add(beam);
      }
      bi++;
      beam.visible = true;
      const r = m.r || 1.2;
      beam.position.set(m.x, 0, m.z);
      beam.scale.set(m.kind === "start" ? 1.6 : r * 0.9, m.kind === "start" ? 1 : 0.25, m.kind === "start" ? 1.6 : r * 0.9);
      const mat = beam.material as THREE.MeshBasicMaterial;
      mat.color.setHex(m.colour);
      mat.opacity = (0.28 + 0.12 * Math.sin(t * 4)) * (0.8 + night * 0.6);
      if (m.kind !== "start") {
        let ring = this.ringPool[ri];
        if (!ring) {
          ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ toneMapped: false }));
          this.ringPool.push(ring);
          this.markers.add(ring);
        }
        ri++;
        ring.visible = true;
        ring.position.set(m.x, 0.3 + 0.15 * Math.sin(t * 3), m.z);
        ring.scale.setScalar(r || 1.5);
        (ring.material as THREE.MeshBasicMaterial).color.setHex(m.colour);
      }
    }
    for (let i = bi; i < this.pool.length; i++) this.pool[i].visible = false;
    for (let i = ri; i < this.ringPool.length; i++) this.ringPool[i].visible = false;
  }
}
