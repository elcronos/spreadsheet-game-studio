/**
 * Gridlock City - SpreadsheetGame implementation: three.js presentation of the
 * World simulation, chase camera, HUD, and cell-resolution rendering.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { CustomSheet, GameCommand, GameContext, HudState, SpreadsheetGame, TouchButton } from "../../../engines/core/game";
import type { KeyBinding } from "../../../engines/core/input";
import { VARIABLES, RULES } from "./config";
import { World } from "./sim/world";
import type { Vehicle } from "./sim/vehicle";
import type { Human } from "./sim/human";
import { buildCityVisuals, CityVisuals } from "./render/cityMesh";
import { Atmosphere } from "./render/atmosphere";
import { Effects } from "./render/effects";
import { buildVehicle, applyDents, buildHuman, animateHuman, VehicleRig, HumanRig } from "./render/models";
import { Hud } from "./render/hud";
import { MISSIONS } from "./sim/missions";
import { RoadDriver, legFrom } from "./sim/nav";
import { nearestEdgePoint } from "./city";
import type { MissionId } from "./sim/missions";

export interface GridlockOptions {
  bloom?: boolean;
  shadows?: boolean;
  pixelRatio?: number;
  /** Supersampling factor for cell rendering (1 = none). */
  cellSupersample?: number;
}

export class GridlockCity implements SpreadsheetGame {
  readonly id = "gridlock-city";
  readonly title = "Gridlock City";
  readonly tagline = "Meridian Bay, rendered one cell at a time";
  readonly fixedStep = 1 / 60;
  readonly variables = VARIABLES;
  readonly rules = RULES;
  readonly keyBindings: KeyBinding = {
    KeyW: "up", ArrowUp: "up", KeyS: "down", ArrowDown: "down", KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right",
    ShiftLeft: "sprint", ShiftRight: "sprint", Space: "handbrake", KeyF: "enter", Enter: "enter", KeyH: "horn", KeyR: "restart",
    KeyC: "lookback", KeyQ: "camLeft", KeyE: "camRight", KeyV: "walk",
  };
  readonly touchButtons: TouchButton[] = [
    { action: "enter", label: "F" },
    { action: "handbrake", label: "⎵" },
    { action: "sprint", label: "⇧" },
    { action: "horn", label: "H" },
  ];
  readonly controls: [string, string][] = [
    ["W A S D / arrows", "Move · drive"],
    ["Shift", "Sprint (uses stamina)"],
    ["V (hold)", "Walk"],
    ["Space", "Jump · handbrake / drift"],
    ["F / Enter", "Enter, exit or jack a vehicle"],
    ["Mouse drag · Q / E", "Rotate camera"],
    ["C", "Look back"],
    ["H", "Horn"],
    ["R", "Retry a failed mission"],
  ];
  readonly commands: GameCommand[] = [
    { id: "mission-delivery", label: "Start: Hot Delivery" },
    { id: "mission-race", label: "Start: Neon Mile Sprint" },
    { id: "mission-escape", label: "Start: Heatwave" },
    { id: "mission-restart", label: "Restart mission" },
    { id: "mission-abort", label: "Abort mission" },
    { id: "spawn-sports", label: "Spawn sports car" },
    { id: "cinematic", label: "Cinematic camera" },
    { id: "autodrive", label: "Autodrive (attract mode)" },
    { id: "time-sunset", label: "Sunset" },
    { id: "time-night", label: "Night" },
    { id: "time-noon", label: "Noon" },
    { id: "repair", label: "Repair vehicle" },
  ];
  readonly customSheets: CustomSheet[];

  world!: World;
  private ctx!: GameContext;
  private renderer!: THREE.WebGLRenderer;
  scene!: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  private atmo!: Atmosphere;
  visuals!: CityVisuals;
  private fx!: Effects;
  private hudView!: Hud;
  private composer: EffectComposer | null = null;
  private cellComposer: EffectComposer | null = null;
  private cellTarget: THREE.WebGLRenderTarget | null = null;
  private cellBuf: Uint8Array = new Uint8Array(0);
  private vrigs = new Map<number, VehicleRig>();
  private hrigs = new Map<number, HumanRig>();
  private playerRig!: HumanRig;
  private spot: THREE.SpotLight[] = [];
  private sirenLights: THREE.PointLight[] = [];
  private mount!: HTMLElement;
  private canvasEl!: HTMLCanvasElement;
  // camera state
  camYaw = 0;
  private camPitch = 0.22;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private shake = 0;
  private lookTimer = 0;
  cinematic = false;
  private lastSync = -1;
  private frameNo = 0;
  private lastT = performance.now();
  private hudVisible = true;
  opts: Required<GridlockOptions>;

  constructor(opts: GridlockOptions = {}) {
    this.opts = { bloom: true, shadows: true, pixelRatio: Math.min(globalThis.devicePixelRatio || 1, 1.5), cellSupersample: 2, ...opts };
    this.customSheets = [
      {
        name: "MISSIONS",
        columns: ["Mission", "Type", "Objective", "Progress", "Time left (s)", "Reward ($)", "Status", "Attempts", "Best"],
        rows: () => (this.world ? this.world.missions.rows() : []),
      },
    ];
  }

  async init(ctx: GameContext): Promise<void> {
    this.ctx = ctx;
    this.mount = ctx.mount;
    this.world = new World(ctx.registry, ctx.random);
    this.canvasEl = document.createElement("canvas");
    this.canvasEl.className = "gc-canvas";
    this.canvasEl.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    this.mount.appendChild(this.canvasEl);
    const r = new THREE.WebGLRenderer({ canvas: this.canvasEl, antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: false });
    r.setPixelRatio(this.opts.pixelRatio);
    r.shadowMap.enabled = this.opts.shadows;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 1600);
    this.atmo = new Atmosphere(this.scene);
    this.visuals = buildCityVisuals(this.world.city, this.scene);
    this.fx = new Effects(this.scene);
    this.hudView = new Hud(this.mount, this.world.city);
    this.playerRig = buildHuman(this.world.player.look, true);
    this.scene.add(this.playerRig.root);
    for (let i = 0; i < 2; i++) {
      const s = new THREE.SpotLight(0xfff0d0, 0, 70, 0.5, 0.5, 1.2);
      s.castShadow = false;
      this.scene.add(s, s.target);
      this.spot.push(s);
    }
    for (let i = 0; i < 2; i++) {
      const p = new THREE.PointLight(0xff2020, 0, 16, 1.6);
      this.scene.add(p);
      this.sirenLights.push(p);
    }
    // environment map for reflective paint/glass, from a simple gradient scene
    const pm = new THREE.PMREMGenerator(r);
    const envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(new THREE.SphereGeometry(10, 16, 8), new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true }));
    const g = envSky.geometry;
    const cols: number[] = [];
    const pos = g.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 10;
      const c = new THREE.Color(0x9fc8ee).lerp(new THREE.Color(0x3b3a40), Math.max(0, -y) * 1.5);
      cols.push(c.r, c.g, c.b);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    envScene.add(envSky);
    this.scene.environment = pm.fromScene(envScene, 0.04).texture;
    this.scene.environmentIntensity = 0.6;
    if (this.opts.bloom) {
      this.composer = new EffectComposer(r);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.5, 0.45, 0.9));
      this.composer.addPass(new OutputPass());
    }
    const p = this.world.playerPos();
    this.camYaw = this.world.player.heading;
    this.camPos.set(p.x - Math.sin(this.camYaw) * 6, 3, p.z - Math.cos(this.camYaw) * 6);
    this.camLook.set(p.x, 1.5, p.z);
    this.resize();
    new ResizeObserver(() => this.resize()).observe(this.mount);
    // mouse / touch drag to orbit camera
    let drag: { x: number; y: number } | null = null;
    this.canvasEl.addEventListener("pointerdown", (e) => (drag = { x: e.clientX, y: e.clientY }));
    window.addEventListener("pointerup", () => (drag = null));
    window.addEventListener("pointermove", (e) => {
      if (!drag) return;
      ctx.input.apply({ type: "pointer", dx: e.clientX - drag.x, dy: e.clientY - drag.y });
      drag = { x: e.clientX, y: e.clientY };
    });
  }

  /** Attach the conventional canvas to a different element (e.g. back from a sheet). */
  attachTo(el: HTMLElement): void {
    el.appendChild(this.canvasEl);
    el.appendChild(this.hudView.el);
    this.mount = el;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(el);
  }

  setHudVisible(v: boolean): void {
    this.hudVisible = v;
  }

  private resize(): void {
    const w = Math.max(16, this.mount.clientWidth), h = Math.max(16, this.mount.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(w, h);
    this.fx.setViewportHeight(h * this.opts.pixelRatio);
  }

  canvas(): HTMLCanvasElement {
    return this.canvasEl;
  }

  // ------------------------------------------------------------ simulation
  step(dt: number): void {
    const input = this.ctx.input;
    // camera controls are part of the input step so mouse deltas are never lost
    if (input.lookDX || input.lookDY) {
      this.camYaw -= input.lookDX * 0.006;
      this.camPitch = Math.max(-0.1, Math.min(0.9, this.camPitch + input.lookDY * 0.004));
      this.lookTimer = 2.5;
    }
    if (input.held("camLeft")) {
      this.camYaw += 2 * dt;
      this.lookTimer = 2.5;
    }
    if (input.held("camRight")) {
      this.camYaw -= 2 * dt;
      this.lookTimer = 2.5;
    }
    this.lookTimer -= dt;
    this.world.camYaw = this.camYaw;
    this.world.step(dt, input);
    this.updateCameraTarget(dt);
    // particles from sim events
    for (const e of this.world.events) {
      if (e.type === "impact") {
        this.fx.sparks(e.x, 0.7, e.z, Math.round(6 + e.intensity * 30), 4 + e.intensity * 8);
        if (e.vehicleId === this.world.playerVehicle?.id || this.world.distToPlayer(e) < 8) this.shake = Math.max(this.shake, e.intensity * 0.9);
      } else if (e.type === "explosion") {
        this.fx.explosion(e.x, e.z);
        if (this.world.distToPlayer(e) < 40) this.shake = 1.4;
      } else if (e.type === "pedHit") this.fx.splashPed(e.x, e.z);
      else if (e.type === "checkpoint") this.fx.sparks(e.x, 1.5, e.z, 40, 7);
    }
  }

  private updateCameraTarget(dt: number): void {
    const w = this.world;
    const v = w.playerVehicle;
    const input = this.ctx.input;
    let target: THREE.Vector3, dist: number, height: number, desiredYaw: number | null = null;
    if (v) {
      target = new THREE.Vector3(v.x, v.y + 1.3, v.z);
      const sp = Math.abs(v.speed);
      dist = 7.5 + Math.min(4, sp * 0.08) + (v.kind === "van" ? 1.5 : 0);
      height = 2.6 + (v.kind === "van" ? 1 : 0);
      if (this.lookTimer <= 0) {
        // follow travel direction (handles reversing and drifts)
        const vel = Math.hypot(v.vx, v.vz);
        desiredYaw = vel > 3 && v.speed > 0 ? Math.atan2(v.vx, v.vz) * 0.35 + v.heading * 0.65 : v.heading;
        if (v.speed < -2) desiredYaw = v.heading;
      }
      if (input.held("lookback")) desiredYaw = v.heading + Math.PI;
    } else {
      const p = w.player;
      target = new THREE.Vector3(p.x, p.y + 1.55, p.z);
      dist = 5.2;
      height = 1.9;
      if (this.lookTimer <= 0 && Math.hypot(p.vx, p.vz) > 1.5) desiredYaw = p.heading;
    }
    if (this.cinematic) {
      desiredYaw = this.camYaw + dt * 0.25;
      dist *= 1.35;
    }
    if (desiredYaw !== null) {
      let d = desiredYaw - this.camYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const rate = this.cinematic ? 1 : v ? (input.held("lookback") ? 20 : 3.2) : 2.2;
      this.camYaw += d * Math.min(1, rate * dt);
    }
    const pitch = v ? 0.2 + this.camPitch * 0.3 : this.camPitch;
    let cx = target.x - Math.sin(this.camYaw) * dist * Math.cos(pitch);
    let cz = target.z - Math.cos(this.camYaw) * dist * Math.cos(pitch);
    const cy = target.y + height * 0.3 + Math.sin(pitch) * dist;
    // keep the camera out of buildings
    const f = w.grid.raycast(target.x, target.z, cx, cz);
    if (f < 1) {
      const k = Math.max(0.12, f - 1.2 / Math.max(1, dist));
      cx = target.x + (cx - target.x) * k;
      cz = target.z + (cz - target.z) * k;
    }
    const k = Math.min(1, (v ? 10 : 8) * dt);
    this.camPos.x += (cx - this.camPos.x) * k;
    this.camPos.y += (cy - this.camPos.y) * k;
    this.camPos.z += (cz - this.camPos.z) * k;
    this.camLook.lerp(target, Math.min(1, 14 * dt));
    this.shake *= Math.exp(-dt * 4);
    const fovT = v ? 62 + Math.min(14, Math.abs(v.speed) * 0.3) : 60;
    this.camera.fov += (fovT - this.camera.fov) * Math.min(1, 3 * dt);
  }

  // ------------------------------------------------------------ presentation
  private sync(): void {
    if (this.lastSync === this.frameNo) return;
    this.lastSync = this.frameNo;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    const w = this.world;
    const night = w.nightFactor();
    const weather = w.reg.str("world.weather");
    const raining = weather === "Rain" || weather === "Storm";
    // camera
    const s = this.shake;
    this.camera.position.set(this.camPos.x + (Math.random() - 0.5) * s * 0.3, this.camPos.y + (Math.random() - 0.5) * s * 0.3, this.camPos.z + (Math.random() - 0.5) * s * 0.3);
    this.camera.lookAt(this.camLook);
    this.camera.updateProjectionMatrix();
    const focus = new THREE.Vector3(w.playerPos().x, 0, w.playerPos().z);
    this.atmo.update(w.hours(), weather, dt, w.t, focus, this.camera.position);
    this.visuals.update(w.t, night);
    this.renderer.toneMappingExposure = 1.05 + night * 0.2;
    this.scene.environmentIntensity = 0.6 * (1 - night * 0.7) * (weather === "Clear" ? 1 : 0.7);
    this.visuals.setWetness(weather === "Storm" ? 1 : weather === "Rain" ? 0.7 : 0);
    // vehicles
    const seen = new Set<number>();
    let spotIdx = 0;
    const sirens: Vehicle[] = [];
    for (const v of w.vehicles) {
      seen.add(v.id);
      let rig = this.vrigs.get(v.id);
      if (!rig) {
        rig = buildVehicle(v);
        this.vrigs.set(v.id, rig);
        this.scene.add(rig.root);
      }
      const far = Math.hypot(v.x - this.camera.position.x, v.z - this.camera.position.z) > 260;
      rig.root.visible = !far;
      if (far) continue;
      rig.root.position.set(v.x, v.y, v.z);
      rig.root.rotation.y = v.heading;
      rig.body.rotation.set(v.pitch, 0, -v.roll);
      rig.body.position.y = Math.sin(w.t * 30 + v.id) * 0.004 * Math.min(1, Math.abs(v.speed) / 10);
      for (let i = 0; i < 4; i++) {
        const wh = rig.wheels[i];
        if (i < 2) wh.rotation.y = v.steer;
        (wh.children[0] as THREE.Object3D).rotation.x = v.wheelSpin;
      }
      applyDents(rig, v);
      const lightsOn = night > 0.35 || weather === "Storm" || weather === "Fog";
      rig.headMat.emissiveIntensity = v.destroyed ? 0 : lightsOn ? 3 : 0.25;
      rig.tailMat.emissiveIntensity = v.destroyed ? 0 : v.braking ? 4 : lightsOn ? 1.4 : 0.2;
      rig.cone.visible = lightsOn && !v.destroyed && v.health > 0;
      (rig.cone.material as THREE.MeshBasicMaterial).opacity = 0.5 * night * (weather === "Rain" || weather === "Storm" ? 1.3 : 1);
      if (rig.bar) {
        const ph = Math.floor(w.t * 8) % 2 === 0;
        (rig.bar.red.material as THREE.MeshBasicMaterial).color.setScalar(v.siren ? (ph ? 3 : 0.2) : 0.35).multiply(new THREE.Color(1, 0.1, 0.1));
        (rig.bar.blue.material as THREE.MeshBasicMaterial).color.setScalar(v.siren ? (ph ? 0.2 : 3) : 0.35).multiply(new THREE.Color(0.1, 0.35, 1));
        if (v.siren && !v.destroyed) sirens.push(v);
      }
      if (v.destroyed) {
        if (!v.tag.burnt) {
          v.tag.burnt = true;
          rig.bodyMesh.material = new THREE.MeshStandardMaterial({ color: 0x1d1a18, roughness: 1, flatShading: true });
        }
        if (Math.random() < 0.3 && w.t - (v.tag.wreckTime as number) < 20) this.fx.puff(v.x, 1.4, v.z, 0x222222, 1.5, 3, 2);
      } else {
        const hp = v.health / v.maxHealth;
        const hood = new THREE.Vector3(0, 1.1, v.dims.length * 0.35).applyEuler(rig.root.rotation).add(rig.root.position);
        if (hp < 0.45 && Math.random() < (0.45 - hp) * 1.2) this.fx.puff(hood.x, hood.y, hood.z, hp < 0.2 ? 0x333333 : 0x9a9a9a, 0.6, 1.6);
        if (v.health <= 0 && Math.random() < 0.8) this.fx.fire(hood.x, hood.y, hood.z);
        // tyre smoke while drifting / burnouts
        if ((v.slip > 4.5 || (v.handbrake && Math.abs(v.speed) > 8)) && !v.airborne && Math.random() < 0.7) {
          for (const sgn of [-1, 1]) {
            const p = new THREE.Vector3(sgn * 0.8, 0.3, -v.dims.wheelbase / 2).applyEuler(rig.root.rotation).add(rig.root.position);
            const onSand = v.x > 201 && Math.abs(v.z) > 7;
            this.fx.puff(p.x, p.y, p.z, onSand ? 0xd8c290 : 0xdddddd, 0.7, 1.2, 0.5);
          }
        }
      }
      if (v === w.playerVehicle && lightsOn && spotIdx < 2 && !v.destroyed) {
        for (const sgn of [-0.6, 0.6]) {
          const sp = this.spot[spotIdx++];
          const p = new THREE.Vector3(sgn, 0.8, v.dims.length / 2).applyEuler(rig.root.rotation).add(rig.root.position);
          const t = new THREE.Vector3(sgn * 2, 0, v.dims.length / 2 + 18).applyEuler(rig.root.rotation).add(rig.root.position);
          sp.position.copy(p);
          sp.target.position.copy(t);
          sp.intensity = 40 + 160 * night;
        }
      }
    }
    for (let i = spotIdx; i < 2; i++) this.spot[i].intensity = 0;
    // flashing light on the two nearest sirens
    sirens.sort((a, b) => w.distToPlayer(a) - w.distToPlayer(b));
    for (let i = 0; i < 2; i++) {
      const L = this.sirenLights[i];
      const v = sirens[i];
      if (v && w.distToPlayer(v) < 80) {
        const ph = Math.floor(w.t * 8 + i) % 2 === 0;
        L.color.setHex(ph ? 0xff2020 : 0x2050ff);
        L.intensity = 18 + night * 35;
        L.position.set(v.x, 2.2, v.z);
      } else L.intensity = 0;
    }
    for (const [id, rig] of this.vrigs)
      if (!seen.has(id)) {
        this.scene.remove(rig.root);
        rig.bodyMesh.geometry.dispose();
        this.vrigs.delete(id);
      }
    // people
    const hs = new Set<number>();
    for (const p of w.peds) {
      hs.add(p.id);
      let rig = this.hrigs.get(p.id);
      if (!rig) {
        rig = buildHuman(p.look);
        this.hrigs.set(p.id, rig);
        this.scene.add(rig.root);
      }
      const far = Math.hypot(p.x - this.camera.position.x, p.z - this.camera.position.z) > 150;
      rig.root.visible = !far;
      if (!far) this.placeHuman(rig, p, dt, raining);
    }
    for (const [id, rig] of this.hrigs)
      if (!hs.has(id)) {
        this.scene.remove(rig.root);
        this.hrigs.delete(id);
      }
    const pl = w.player;
    this.playerRig.root.visible = !w.playerVehicle;
    if (!w.playerVehicle) this.placeHuman(this.playerRig, pl, dt, false);
    this.fx.setMarkers(w.missions.markers, w.t, night);
    this.fx.update(dt);
    // rain splashes near camera
    if (raining)
      for (let i = 0; i < (weather === "Storm" ? 4 : 2); i++) {
        // small splashes, kept away from the lens so additive sprites never wash the frame out
        const ang = Math.random() * Math.PI * 2, r = 6 + Math.random() * 22;
        this.fx.glow.emit(this.camera.position.x + Math.cos(ang) * r, 0.08, this.camera.position.z + Math.sin(ang) * r, 0, 0.8, 0, 0x2a3440, 0.05, 0.2);
      }
  }

  private placeHuman(rig: HumanRig, h: Human, dt: number, raining: boolean): void {
    rig.root.position.set(h.x, h.y, h.z);
    rig.root.rotation.y = h.pose === "knocked" ? h.fallYaw + Math.PI : h.heading;
    animateHuman(rig, h, dt, raining);
  }

  private directThisFrame = false;

  renderDirect(): void {
    this.frameNo++;
    this.directThisFrame = true;
    this.sync();
    this.hudView.update(this.world, this.camYaw, this.hudVisible);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /** Render the same scene at cell resolution and read it back (top-down RGBA). */
  renderCells(width: number, height: number, out: Uint8Array): void {
    if (!this.directThisFrame) this.frameNo++;
    this.directThisFrame = false;
    this.sync();
    const ss = Math.max(1, this.opts.cellSupersample);
    const W = width * ss, H = height * ss;
    if (!this.cellTarget || this.cellTarget.width !== W || this.cellTarget.height !== H) {
      this.cellTarget?.dispose();
      this.cellTarget = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
      this.cellBuf = new Uint8Array(W * H * 4);
      if (this.opts.bloom) {
        this.cellComposer = new EffectComposer(this.renderer, this.cellTarget.clone());
        this.cellComposer.renderToScreen = false;
        this.cellComposer.setPixelRatio(1);
        this.cellComposer.setSize(W, H);
        this.cellComposer.addPass(new RenderPass(this.scene, this.camera));
        this.cellComposer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), 0.6, 0.4, 0.8));
        this.cellComposer.addPass(new OutputPass());
      }
    }
    const aspect = this.camera.aspect;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.fx.setViewportHeight(H);
    let rt: THREE.WebGLRenderTarget;
    if (this.cellComposer) {
      this.cellComposer.render();
      rt = this.cellComposer.readBuffer;
    } else {
      this.renderer.setRenderTarget(this.cellTarget);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      rt = this.cellTarget;
    }
    this.renderer.readRenderTargetPixels(rt, 0, 0, W, H, this.cellBuf);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.fx.setViewportHeight(this.mount.clientHeight * this.opts.pixelRatio);
    // box-filter downsample + flip to top-down
    const src = this.cellBuf;
    const inv = 1 / (ss * ss);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0;
        for (let sy = 0; sy < ss; sy++) {
          const row = (H - 1 - (y * ss + sy)) * W;
          for (let sx = 0; sx < ss; sx++) {
            const o = (row + x * ss + sx) * 4;
            r += src[o];
            g += src[o + 1];
            b += src[o + 2];
          }
        }
        const d = (y * width + x) * 4;
        // cell grade: +12% saturation, +8% contrast around mid-grey (fog-heavy low-res frames read better)
        r *= inv; g *= inv; b *= inv;
        const l = 0.3 * r + 0.59 * g + 0.11 * b;
        r = (l + (r - l) * 1.12 - 128) * 1.08 + 128;
        g = (l + (g - l) * 1.12 - 128) * 1.08 + 128;
        b = (l + (b - l) * 1.12 - 128) * 1.08 + 128;
        out[d] = r < 0 ? 0 : r > 255 ? 255 : r;
        out[d + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        out[d + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
        out[d + 3] = 255;
      }
    }
  }

  hud(): HudState {
    const w = this.world;
    const reg = w.reg;
    const v = w.playerVehicle;
    const h = reg.num("world.time");
    const run = w.missions.running;
    return {
      stats: [
        ["CASH", "$" + Math.round(reg.num("player.cash")).toLocaleString("en-US")],
        ["HEALTH", String(Math.round(w.player.health))],
        ["HEAT", "▰".repeat(w.police.stars) + "▱".repeat(5 - w.police.stars)],
        [v ? "SPEED" : "STAMINA", v ? `${Math.round(Math.abs(v.speed) * 3.6)} km/h` : `${Math.round(w.player.stamina)}%`],
        ["TIME", `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`],
        ["WEATHER", reg.str("world.weather")],
      ],
      objective: run ? `${run.objective}${run.timeLeft >= 0 ? ` · ${Math.max(0, Math.ceil(run.timeLeft))}s` : ""}${run.progress ? " · " + run.progress : ""}` : "Free roam - walk or drive into a mission marker",
      banner: w.bannerTimer > 0 ? w.banner + (w.bannerSub ? " - " + w.bannerSub : "") : undefined,
      hint: w.hint || undefined,
      meter: w.police.stars,
    };
  }

  runCommand(id: string): void {
    const w = this.world;
    if (id.startsWith("mission-")) {
      const m = id.slice(8);
      if (m === "restart") w.missions.restart();
      else if (m === "abort") w.missions.abort();
      else if (MISSIONS.some((x) => x.id === m)) {
        if (w.playerVehicle && m !== "race") w.exitVehicle();
        w.missions.start(m as MissionId, true);
      }
    } else if (id === "spawn-sports") {
      const p = w.playerPos();
      const yaw = this.camYaw;
      const v = w.spawnParked("sports", p.x + Math.sin(yaw) * 5 + Math.cos(yaw) * 3, p.z + Math.cos(yaw) * 5 - Math.sin(yaw) * 3, yaw);
      v.tag.despawnOk = true;
    } else if (id === "cinematic") this.cinematic = !this.cinematic;
    else if (id === "autodrive") {
      // attract mode: the player's car cruises the road network on its own (same physics, same AI driver as traffic)
      if (w.autopilot) {
        w.autopilot = null;
        return;
      }
      const v = w.playerVehicle;
      if (!v) return;
      const e = nearestEdgePoint(w.city, v.x, v.z).edge;
      const fwdA = (w.city.nodes[e.b].x - w.city.nodes[e.a].x) * v.fx + (w.city.nodes[e.b].z - w.city.nodes[e.a].z) * v.fz > 0;
      const d = new RoadDriver(w.city, legFrom(w.city, e.id, fwdA ? e.a : e.b), { cruise: 18, obeySignals: false, avoid: true, lane: 0, aggression: 0.6 }, w.rand);
      d.wps = d.wps.filter((p) => (p.x - v.x) * v.fx + (p.z - v.z) * v.fz > 2);
      w.autopilot = (dt) => {
        if (w.playerVehicle !== v) {
          w.autopilot = null;
          return;
        }
        d.opts.cruise = Math.min(34, w.handling(v).maxSpeed * 0.55);
        d.drive(v, dt, w.t, w.obstaclesNear(v), null);
      };
    }
    else if (id === "time-sunset") w.reg.edit("world.time", 18.7);
    else if (id === "time-night") w.reg.edit("world.time", 22);
    else if (id === "time-noon") w.reg.edit("world.time", 12.5);
    else if (id === "repair" && w.playerVehicle) w.reg.edit("veh.current.health", w.playerVehicle.maxHealth);
  }

  entityCount(): number {
    return this.world ? this.world.entityCount() : 0;
  }

  dispose(): void {
    this.renderer?.dispose();
  }
}
