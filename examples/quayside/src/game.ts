/**
 * Quayside: an open-world game set in the real Elizabeth Quay, Perth. The simulation is
 * sim/world.ts; this file renders it (render/scene.ts), runs the camera and the HUD, and
 * implements the SpreadsheetGame contract so the studio can also show it as cells.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { CustomSheet, GameCommand, GameContext, HudState, SheetRow, SpreadsheetGame, TouchButton } from "../../../engines/core/game";
import type { InputState, KeyBinding } from "../../../engines/core/input";
import type { VariableRegistry } from "../../../engines/core/variables";
import { buildHuman, animateHuman, buildVehicle, HumanRig, setHumanStyle, setVehicleStyle, VehicleRig } from "../../gridlock-city/src/render/models";
import type { Human } from "../../gridlock-city/src/sim/human";
import type { Vehicle } from "../../gridlock-city/src/sim/vehicle";
import { KEYS, RULES, VARIABLES } from "./config";
import { G, LM, Raster } from "./map";
import { QuaysideScene, loadRasterBrowser } from "./render/scene";
import { buildFerry, buildPoliceBoat } from "./render/landmarks";
import { Boat, World } from "./sim/world";

export interface QuaysideOptions {
  shadows?: boolean;
  bloom?: boolean;
  ao?: boolean;
  pixelRatio?: number;
  groundUrl?: string;
}

const MINI_COL: Record<number, string> = {
  [G.URBAN]: "#3a3d42", [G.WATER]: "#1d4d66", [G.GRASS]: "#3f6b3a", [G.WOOD]: "#355a33", [G.SAND]: "#8f8460",
  [G.ROAD]: "#8a8d93", [G.ROAD_MAJOR]: "#b7b9bd", [G.PATH]: "#56595e", [G.PLAZA]: "#4a4d52", [G.PIER]: "#7a6248",
  [G.RAIL]: "#55504a", [G.BUILDING]: "#24262a", [G.BRIDGE]: "#b7b9bd", [G.FOOTBRIDGE]: "#56595e",
};

export class QuaysideGame implements SpreadsheetGame {
  readonly id = "quayside";
  readonly title = "Quayside";
  readonly tagline = "Steal the ferry. The real Elizabeth Quay, Perth, in a spreadsheet.";
  readonly fixedStep = 1 / 60;
  readonly variables = VARIABLES;
  readonly rules = RULES;
  readonly keyBindings: KeyBinding = KEYS;
  readonly touchButtons: TouchButton[] = [
    { action: "enter", label: "F" },
    { action: "hijack", label: "G" },
    { action: "handbrake", label: "⎵" },
    { action: "sprint", label: "⇧" },
  ];
  readonly controls: [string, string][] = [
    ["W A S D / arrows", "Walk, drive, steer the ferry"],
    ["Shift", "Run"],
    ["F / Enter", "Get in or out of a car, board or leave the ferry"],
    ["G", "Steal the ferry"],
    ["Space", "Handbrake"],
    ["Mouse drag, Q / E", "Turn the camera"],
    ["R", "Restart"],
  ];
  readonly commands: GameCommand[] = [
    { id: "time-morning", label: "Time: morning" },
    { id: "time-sunset", label: "Time: golden hour" },
    { id: "time-night", label: "Time: night" },
    { id: "goto-ferry", label: "Go to the Elizabeth Quay ferry" },
    { id: "goto-mends", label: "Go to Mends Street, South Perth" },
    { id: "cinematic", label: "Cinematic camera" },
  ];
  readonly customSheets: CustomSheet[] = [
    {
      name: "FERRIES",
      columns: ["Ferry", "State", "Heading to", "Speed (kn)", "Hull"],
      rows: (): SheetRow[] =>
        (this.world?.ferries ?? []).map((f, i) => ({
          cells: [`Ferry ${i + 1}`, f.driver === "player" ? "STOLEN" : f.driver === "none" ? "Adrift" : f.state === "docked" ? "At the jetty" : "Sailing", f.atEQ ? "Elizabeth Quay" : "Mends Street", Math.round(Math.abs(f.speed) / 0.5144), `${Math.max(0, Math.round(f.health / 10))}%`],
          style: f.driver === "player" ? "failed" : f.state === "docked" ? "active" : undefined,
        })),
    },
    {
      name: "MISSIONS",
      columns: ["Mission", "How to start", "Status"],
      rows: (): SheetRow[] => [
        { cells: ["The Ten-Minute Crossing", "Board the ferry at Elizabeth Quay (F)", this.world?.mission?.id === "crossing" ? (this.world.mission.done ? "Done" : "In progress") : "Available"] },
        { cells: ["Swan River Heist", "Steal the ferry (G) and dock it at Mends Street", this.world?.mission?.id === "heist" ? (this.world.mission.done ? "Done" : "In progress") : "Available"] },
      ],
    },
  ];

  world!: World;
  scene!: QuaysideScene;
  private reg!: VariableRegistry;
  private input!: InputState;
  private mount!: HTMLElement;
  private canvasEl!: HTMLCanvasElement;
  private hudEl!: HTMLDivElement;
  private mini!: HTMLCanvasElement;
  private miniSrc!: HTMLCanvasElement;
  private carRigs = new Map<Vehicle, VehicleRig>();
  private humanRigs = new Map<Human, HumanRig>();
  private boatRigs = new Map<Boat, THREE.Group>();
  private playerRig!: HumanRig;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private dragYaw = 0;
  private dragPitch = 0;
  cinematic = false;
  private cellTarget: THREE.WebGLRenderTarget | null = null;
  private cellComposer: EffectComposer | null = null;
  private cellBuf = new Uint8Array(0);
  private lastT = 0;
  private hudVisible = true;

  constructor(private opts: QuaysideOptions = {}) {
    setHumanStyle("smooth");
    setVehicleStyle("smooth");
  }

  async init(ctx: GameContext): Promise<void> {
    this.reg = ctx.registry;
    this.input = ctx.input;
    this.mount = ctx.mount;
    const raster = await loadRasterBrowser(this.opts.groundUrl ?? "quayside/ground.png");
    this.world = new World(raster, this.reg, ctx.random);
    this.canvasEl = document.createElement("canvas");
    this.canvasEl.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;outline:none";
    this.mount.appendChild(this.canvasEl);
    this.scene = new QuaysideScene(raster, this.canvasEl, {
      shadows: this.opts.shadows ?? true,
      bloom: this.opts.bloom ?? true,
      ao: this.opts.ao ?? false,
      pixelRatio: this.opts.pixelRatio ?? Math.min(devicePixelRatio || 1, 1.5),
    });
    this.playerRig = buildHuman(this.world.player.look, true);
    this.scene.scene.add(this.playerRig.root);
    this.buildHud(raster);
    const resize = () => {
      const w = this.mount.clientWidth || 1280, h = this.mount.clientHeight || 720;
      this.scene.setSize(w, h);
    };
    new ResizeObserver(resize).observe(this.mount);
    resize();
    // camera drag
    let drag: { x: number; y: number } | null = null;
    this.canvasEl.addEventListener("pointerdown", (e) => (drag = { x: e.clientX, y: e.clientY }));
    addEventListener("pointerup", () => (drag = null));
    addEventListener("pointermove", (e: PointerEvent) => {
      if (!drag) return;
      this.dragYaw -= (e.clientX - drag.x) * 0.006;
      this.dragPitch = Math.max(-0.4, Math.min(0.6, this.dragPitch + (e.clientY - drag.y) * 0.004));
      drag = { x: e.clientX, y: e.clientY };
    });
    const [fx, fz] = this.world.focus();
    this.camLook.set(fx, 1.5, fz);
    this.camPos.set(fx - Math.sin(this.world.camYaw) * 8, 4, fz - Math.cos(this.world.camYaw) * 8);
  }

  // ------------------------------------------------------------------------------- HUD
  private buildHud(r: Raster): void {
    const hud = document.createElement("div");
    hud.className = "qs-hud";
    hud.innerHTML = `
      <style>
        .qs-hud{position:absolute;inset:0;pointer-events:none;font-family:Inter,"Segoe UI",Roboto,Arial,sans-serif;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6)}
        .qs-top{position:absolute;right:22px;top:18px;text-align:right}
        .qs-cash{font-size:30px;font-weight:800;letter-spacing:.5px;color:#9be7a0}
        .qs-time{font-size:13px;opacity:.85;margin-top:2px}
        .qs-heat{display:flex;gap:4px;justify-content:flex-end;margin-top:6px}
        .qs-heat i{width:22px;height:6px;border-radius:3px;background:rgba(255,255,255,.18)}
        .qs-heat i.on{background:#ff5a4f;box-shadow:0 0 8px #ff5a4f}
        .qs-where{position:absolute;left:22px;bottom:208px;font-size:13px;font-weight:600;letter-spacing:.3px;opacity:.9}
        .qs-mini{position:absolute;left:18px;bottom:18px;width:180px;height:180px;border-radius:50%;box-shadow:0 0 0 3px rgba(0,0,0,.35),0 6px 20px rgba(0,0,0,.4)}
        .qs-obj{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);background:rgba(10,14,18,.55);padding:9px 16px;border-radius:10px;font-size:15px;max-width:60%;text-align:center;backdrop-filter:blur(4px)}
        .qs-obj b{color:#ffd166;margin-right:8px}
        .qs-hint{position:absolute;left:22px;top:18px;background:rgba(10,14,18,.55);padding:8px 12px;border-radius:8px;font-size:14px;backdrop-filter:blur(4px)}
        .qs-hint:empty{display:none}
        .qs-banner{position:absolute;left:0;right:0;top:36%;text-align:center;font-size:54px;font-weight:900;letter-spacing:2px;color:#ffd166;text-shadow:0 3px 12px rgba(0,0,0,.7);opacity:0;transition:opacity .3s}
        .qs-speed{position:absolute;right:26px;bottom:24px;font-size:42px;font-weight:800;text-align:right}
        .qs-speed small{display:block;font-size:12px;font-weight:600;opacity:.7;letter-spacing:1px}
      </style>
      <div class="qs-top"><div class="qs-cash"></div><div class="qs-time"></div><div class="qs-heat"><i></i><i></i><i></i><i></i><i></i></div></div>
      <div class="qs-hint"></div>
      <div class="qs-where"></div>
      <canvas class="qs-mini" width="360" height="360"></canvas>
      <div class="qs-obj"></div>
      <div class="qs-banner"></div>
      <div class="qs-speed"></div>`;
    this.mount.appendChild(hud);
    this.hudEl = hud;
    this.mini = hud.querySelector(".qs-mini") as HTMLCanvasElement;
    // minimap source: 1 px per 2 m
    const src = document.createElement("canvas");
    src.width = Math.ceil(r.w / 2);
    src.height = Math.ceil(r.h / 2);
    const c = src.getContext("2d")!;
    const img = c.createImageData(src.width, src.height);
    const rgb = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const pal: Record<number, number[]> = {};
    for (const k of Object.keys(MINI_COL)) pal[+k] = rgb(MINI_COL[+k]);
    for (let y = 0; y < src.height; y++)
      for (let x = 0; x < src.width; x++) {
        const p = pal[r.cell(x * 2, y * 2)] ?? pal[0], o = (y * src.width + x) * 4;
        img.data[o] = p[0];
        img.data[o + 1] = p[1];
        img.data[o + 2] = p[2];
        img.data[o + 3] = 255;
      }
    c.putImageData(img, 0, 0);
    this.miniSrc = src;
  }

  setHudVisible(v: boolean): void {
    this.hudVisible = v;
    if (this.hudEl) this.hudEl.style.display = v ? "" : "none";
  }

  private updateHud(): void {
    if (!this.hudVisible) return;
    const w = this.world, reg = this.reg;
    const q = (s: string) => this.hudEl.querySelector(s) as HTMLElement;
    q(".qs-cash").textContent = `$${Math.floor(reg.num("player.cash")).toLocaleString("en-AU")}`;
    const hr = reg.num("world.time"), hh = Math.floor(hr), mm = Math.floor((hr % 1) * 60);
    q(".qs-time").textContent = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}  ·  Perth`;
    const heat = reg.num("player.heat");
    this.hudEl.querySelectorAll(".qs-heat i").forEach((el, i) => el.classList.toggle("on", i < Math.ceil(heat - 0.01)));
    q(".qs-hint").textContent = w.hint;
    q(".qs-where").textContent = reg.str("player.where");
    const m = w.mission;
    q(".qs-obj").innerHTML = m && !m.done ? `<b>${m.title}</b>${m.objective}` : "<b>Free roam</b>Board the ferry at the Elizabeth Quay jetty, or steal it";
    const b = q(".qs-banner");
    b.textContent = w.bannerT > 0 ? w.banner : "";
    b.style.opacity = w.bannerT > 0 ? "1" : "0";
    const sp = w.mode === "car" && w.car ? Math.hypot(w.car.vx, w.car.vz) * 3.6 : w.mode === "helm" && w.boat ? Math.abs(w.boat.speed) / 0.5144 : -1;
    q(".qs-speed").innerHTML = sp >= 0 ? `${Math.round(sp)}<small>${w.mode === "car" ? "KM/H" : "KNOTS"}</small>` : "";
    this.drawMinimap();
  }

  private drawMinimap(): void {
    const c = this.mini.getContext("2d")!, S = this.mini.width, w = this.world, r = w.raster;
    const [fx, fz] = w.focus();
    const scale = 1.3; // minimap px per source px (2 m)
    c.save();
    c.clearRect(0, 0, S, S);
    c.beginPath();
    c.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = "#1d4d66";
    c.fillRect(0, 0, S, S);
    c.translate(S / 2, S / 2);
    c.rotate(Math.PI + this.camYawNow());
    const sx = (fx - r.x0) / 2, sy = (r.y1 + fz) / 2;
    c.scale(scale, scale);
    c.imageSmoothingEnabled = true;
    c.drawImage(this.miniSrc, -sx, -sy);
    const dot = (x: number, z: number, col: string, rad: number) => {
      c.fillStyle = col;
      c.beginPath();
      c.arc((x - r.x0) / 2 - sx, (r.y1 + z) / 2 - sy, rad, 0, Math.PI * 2);
      c.fill();
    };
    for (const f of w.ferries) dot(f.x, f.z, "#ffffff", 5);
    for (const p of w.police) dot(p.x, p.z, (Math.floor(w.t * 4) % 2 ? "#ff4040" : "#4080ff"), 4);
    for (const t of w.cars) if (t.police) dot(t.v.x, t.v.z, (Math.floor(w.t * 4) % 2 ? "#ff4040" : "#4080ff"), 3.5);
    if (w.mission?.id === "heist" && !w.mission.done) dot(LM.mendsFerry.x, -LM.mendsFerry.y, "#ffd166", 7);
    else dot(LM.eqFerry.x, -LM.eqFerry.y, "#ffd166", 5);
    c.restore();
    // player arrow (always up)
    c.save();
    c.translate(S / 2, S / 2);
    c.fillStyle = "#fff";
    c.strokeStyle = "rgba(0,0,0,.6)";
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(0, -13);
    c.lineTo(9, 10);
    c.lineTo(0, 5);
    c.lineTo(-9, 10);
    c.closePath();
    c.stroke();
    c.fill();
    c.restore();
  }

  /** Put the camera straight at its resting place (teleports, screenshots). */
  snapCamera(): void {
    for (let i = 0; i < 40; i++) this.updateCamera(0.1);
  }

  private camYawNow(): number {
    return this.world.camYaw + this.dragYaw;
  }

  // ------------------------------------------------------------------------------- loop
  canvas(): HTMLCanvasElement {
    return this.canvasEl;
  }

  step(dt: number): void {
    if (this.input.held("camLeft")) this.dragYaw += dt * 1.6;
    if (this.input.held("camRight")) this.dragYaw -= dt * 1.6;
    if (this.world.mode !== "foot") this.dragYaw *= Math.exp(-dt * 0.8);
    this.world.step(dt, this.input);
    if (this.world.mode === "foot") {
      // on foot the camera yaw is the view direction the player walks along
      this.world.camYaw += this.dragYaw;
      this.dragYaw = 0;
    }
  }

  private sync(dt: number): void {
    const w = this.world, sc = this.scene.scene;
    const [fx, fz] = w.focus();
    // cars
    const cars = new Set<Vehicle>([...w.cars.map((c) => c.v), ...w.parked, ...(w.car ? [w.car] : [])]);
    for (const [v, rig] of this.carRigs)
      if (!cars.has(v)) {
        sc.remove(rig.root);
        this.carRigs.delete(v);
      }
    for (const v of cars) {
      let rig = this.carRigs.get(v);
      if (!rig) {
        rig = buildVehicle(v);
        rig.root.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) o.castShadow = true;
        });
        this.carRigs.set(v, rig);
        sc.add(rig.root);
      }
      rig.root.visible = Math.hypot(v.x - fx, v.z - fz) < 350;
      rig.root.position.set(v.x, v.y, v.z);
      rig.root.rotation.y = v.heading;
      rig.wheels.forEach((wh, i) => {
        if (i < 2) wh.rotation.y = v.steer;
      });
      rig.headMat.emissiveIntensity = this.scene.sky.night > 0.3 ? 2 : 0;
    }
    // people
    const ppl = new Set<Human>(w.people);
    for (const [h, rig] of this.humanRigs)
      if (!ppl.has(h)) {
        sc.remove(rig.root);
        this.humanRigs.delete(h);
      }
    for (const h of ppl) {
      let rig = this.humanRigs.get(h);
      if (!rig) {
        rig = buildHuman(h.look);
        rig.root.traverse((o) => ((o as THREE.Mesh).isMesh ? (o.castShadow = true) : 0));
        this.humanRigs.set(h, rig);
        sc.add(rig.root);
      }
      rig.root.position.set(h.x, h.y, h.z);
      rig.root.rotation.y = h.pose === "knocked" ? h.fallYaw + Math.PI : h.heading;
      animateHuman(rig, h, dt, false);
    }
    const pl = w.player;
    this.playerRig.root.visible = w.mode === "foot";
    this.playerRig.root.position.set(pl.x, pl.y, pl.z);
    this.playerRig.root.rotation.y = pl.pose === "knocked" ? pl.fallYaw + Math.PI : pl.heading;
    animateHuman(this.playerRig, pl, dt, false);
    // boats: bob and roll
    const boats = new Set<Boat>([...w.ferries, ...w.police]);
    for (const [b, g] of this.boatRigs)
      if (!boats.has(b)) {
        sc.remove(g);
        this.boatRigs.delete(b);
      }
    for (const b of boats) {
      let g = this.boatRigs.get(b);
      if (!g) {
        g = b.kind === "ferry" ? buildFerry() : buildPoliceBoat();
        // models are built along +x; the sim's forward is +z at heading 0
        const inner = new THREE.Group();
        inner.add(g);
        g.rotation.y = -Math.PI / 2;
        g = inner;
        this.boatRigs.set(b, g);
        sc.add(g);
      }
      const t = w.t;
      g.position.set(b.x, -0.25 + Math.sin(t * 1.3 + b.x) * 0.08, b.z);
      g.rotation.set(Math.sin(t * 0.9 + b.z) * 0.012 + b.speed * 0.002, b.heading, -b.angVel * Math.abs(b.speed) * 0.02);
      g.rotation.order = "YXZ";
      const bar = g.getObjectByName("lightbar") as THREE.Mesh | undefined;
      if (bar) ((bar.material as THREE.MeshStandardMaterial).emissive as THREE.Color).setHex(Math.floor(t * 5) % 2 ? 0xff2020 : 0x2060ff);
    }
  }

  private updateCamera(dt: number): void {
    const w = this.world, cam = this.scene.camera;
    const [fx, fz] = w.focus();
    let dist = 6.5, height = 2.6, lookH = 1.6;
    if (w.mode === "car") [dist, height, lookH] = [8, 3.0, 1.3];
    if (w.mode === "helm") [dist, height, lookH] = [24, 8, 4];
    if (w.mode === "passenger") [dist, height, lookH] = [22, 7.5, 4];
    if (this.cinematic) {
      this.dragYaw += dt * 0.12;
      [dist, height] = [dist * 1.6, height * 2.2];
    }
    const yaw = this.camYawNow();
    height += this.dragPitch * dist;
    const baseY = w.mode === "foot" ? w.player.y : 0;
    const look = new THREE.Vector3(fx, baseY + lookH, fz);
    // pull the camera in front of buildings between it and the player
    let d = dist;
    for (let s = 1.5; s <= dist; s += 0.75) {
      const x = fx - Math.sin(yaw) * s, z = fz - Math.cos(yaw) * s;
      if (w.raster.at(x, z) === G.BUILDING) {
        d = Math.max(w.mode === "foot" ? 2 : 4, s - 1);
        break;
      }
    }
    // pulled in: rise a little so the view looks down over the player instead of into their back
    const want = new THREE.Vector3(fx - Math.sin(yaw) * d, baseY + height + (dist - d) * 0.35 + 0.4, fz - Math.cos(yaw) * d);
    const k = 1 - Math.exp(-dt * (w.mode === "foot" ? 10 : 5));
    this.camPos.lerp(want, k);
    this.camLook.lerp(look, 1 - Math.exp(-dt * 14));
    cam.position.copy(this.camPos);
    cam.lookAt(this.camLook);
  }

  renderDirect(): void {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, this.lastT ? now - this.lastT : 0.016);
    this.lastT = now;
    this.sync(dt);
    this.updateCamera(dt);
    this.scene.hour = this.reg.num("world.time");
    this.scene.update(dt, this.camLook);
    this.scene.render();
    this.updateHud();
  }

  renderCells(width: number, height: number, out: Uint8Array): void {
    const W = width * 2, H = height * 2;
    const r = this.scene.renderer;
    if (!this.cellTarget || this.cellTarget.width !== W || this.cellTarget.height !== H) {
      this.cellTarget?.dispose();
      this.cellTarget = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
      this.cellComposer = new EffectComposer(r, this.cellTarget.clone());
      this.cellComposer.renderToScreen = false;
      this.cellComposer.setPixelRatio(1);
      this.cellComposer.setSize(W, H);
      this.cellComposer.addPass(new RenderPass(this.scene.scene, this.scene.camera));
      this.cellComposer.addPass(new OutputPass());
      this.cellBuf = new Uint8Array(W * H * 4);
    }
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, this.lastT ? now - this.lastT : 0.016);
    this.lastT = now;
    this.sync(dt);
    this.updateCamera(dt);
    this.scene.hour = this.reg.num("world.time");
    this.scene.update(dt, this.camLook);
    const cam = this.scene.camera, aspect = cam.aspect;
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
    this.cellComposer!.render();
    r.readRenderTargetPixels(this.cellComposer!.readBuffer, 0, 0, W, H, this.cellBuf);
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    const src = this.cellBuf;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const o = ((height - 1 - y) * width + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const s0 = ((y * 2) * W + x * 2) * 4 + ch, s1 = s0 + 4, s2 = s0 + W * 4, s3 = s2 + 4;
          out[o + ch] = (src[s0] + src[s1] + src[s2] + src[s3]) >> 2;
        }
        out[o + 3] = 255;
      }
  }

  hud(): HudState {
    const w = this.world, reg = this.reg;
    return {
      stats: [
        ["CASH", `$${Math.floor(reg.num("player.cash")).toLocaleString("en-AU")}`],
        ["HEAT", String(Math.ceil(reg.num("player.heat") - 0.01))],
        ["WHERE", reg.str("player.where")],
        ["DOING", reg.str("player.mode")],
      ],
      objective: w.mission && !w.mission.done ? `${w.mission.title}: ${w.mission.objective}` : "Board the ferry at Elizabeth Quay, or steal it",
      banner: w.bannerT > 0 ? w.banner : undefined,
      hint: w.hint || undefined,
      meter: Math.ceil(reg.num("player.heat") - 0.01),
    };
  }

  runCommand(id: string): void {
    const w = this.world;
    if (id === "time-morning") this.reg.edit("world.time", 8.5);
    else if (id === "time-sunset") this.reg.edit("world.time", 17.6);
    else if (id === "time-night") this.reg.edit("world.time", 20.6);
    else if (id === "cinematic") this.cinematic = !this.cinematic;
    else if (id === "goto-ferry" || id === "goto-mends") {
      const eq = id === "goto-ferry";
      const f = w.ferries.find((x) => x.state === "docked" && x.atEQ === eq) ?? w.ferries[0];
      const [x, z] = w.nearestFree(f.x, f.z, "walk");
      if (w.mode !== "foot") return;
      Object.assign(w.player, { x, z, y: w.groundAt(x, z) });
      w.camYaw = Math.atan2(f.x - x, f.z - z);
    }
  }

  entityCount(): number {
    return this.world ? this.world.cars.length + this.world.people.length + this.world.ferries.length + this.world.police.length + 1 : 0;
  }

  dispose(): void {
    this.scene?.renderer.dispose();
    this.canvasEl?.remove();
    this.hudEl?.remove();
  }
}
