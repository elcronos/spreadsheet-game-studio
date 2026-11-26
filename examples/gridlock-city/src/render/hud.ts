/** Conventional-view HUD: stats, alert stars, objective, banner, hint, speedometer, radar minimap. */
import type { World } from "../sim/world";
import type { CityLayout } from "../city";

const CSS = `
.gc-hud{position:absolute;inset:0;pointer-events:none;font-family:"Trebuchet MS","Segoe UI",sans-serif;color:#fff;text-shadow:0 2px 0 rgba(0,0,0,.55),0 0 8px rgba(0,0,0,.35);user-select:none}
.gc-tr{position:absolute;top:14px;right:18px;text-align:right;background:rgba(14,16,40,.45);padding:8px 12px;border-radius:10px;border:1px solid rgba(34,230,255,.35)}
.gc-cash{font:700 24px/1 "Trebuchet MS","Segoe UI",sans-serif;color:#9dffc4;letter-spacing:.5px}
.gc-stars{display:flex;gap:4px;justify-content:flex-end;align-items:center;margin-top:6px}
.gc-heatlbl{font:700 11px/1 "Trebuchet MS",sans-serif;letter-spacing:1px;margin-right:4px;color:#e9f6ff}
.gc-stars i{width:16px;height:10px;transform:skewX(-20deg);background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.5)}
.gc-stars i.on{background:linear-gradient(90deg,#ff3b6b,#ff9a3b);border-color:#ffd0d0}
.gc-stars.flash i.on{animation:gcf .5s steps(2) infinite}
@keyframes gcf{50%{background:#3b7bff}}
.gc-bar{width:150px;height:9px;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.35);margin:6px 0 0 auto}
.gc-bar i{display:block;height:100%;background:linear-gradient(90deg,#ff4d6d,#ff8fa3)}
.gc-bar.st i{background:linear-gradient(90deg,#2fd6c8,#9ff5ee)}
.gc-obj{position:absolute;top:14px;left:16px;font-size:16px;max-width:55%;text-align:left;background:rgba(10,12,30,.35);padding:4px 12px;border-radius:3px}
.gc-ban{position:absolute;top:30%;left:0;right:0;text-align:center;font:italic 800 46px/1 "Trebuchet MS","Segoe UI",sans-serif;letter-spacing:6px;color:#22e6ff;text-shadow:0 0 18px rgba(255,63,180,.9),3px 3px 0 #ff3fb4;transition:opacity .25s}
.gc-ban small{display:block;font:600 18px "Trebuchet MS",sans-serif;letter-spacing:0;color:#fff;-webkit-text-stroke:0;margin-top:10px}
.gc-hint{position:absolute;bottom:22px;left:50%;transform:translateX(-50%);font-size:15px;background:rgba(0,0,0,.4);padding:3px 10px;border-radius:3px}
.gc-speed{position:absolute;right:20px;bottom:18px;font:italic 700 34px/1 "Trebuchet MS","Segoe UI",sans-serif;color:#22e6ff}
.gc-speed small{font-size:14px;color:#fff}
.gc-map{position:absolute;left:16px;top:56px;width:150px;height:150px;border-radius:14px;border:2px solid rgba(34,230,255,.7);box-shadow:0 0 0 2px rgba(0,0,0,.35);overflow:hidden;background:#1b2a3a}
.gc-clock{font-size:14px;margin-top:4px;color:#e9f6ff}
@media (max-width:700px){.gc-map{width:96px;height:96px;top:48px}.gc-ban{font-size:34px}.gc-cash{font-size:20px}.gc-obj{font-size:13px;max-width:80%}}
`;

export class Hud {
  readonly el: HTMLDivElement;
  private cash: HTMLDivElement;
  private stars: HTMLDivElement;
  private hp: HTMLElement;
  private st: HTMLElement;
  private obj: HTMLDivElement;
  private ban: HTMLDivElement;
  private hint: HTMLDivElement;
  private speed: HTMLDivElement;
  private clock: HTMLDivElement;
  private map: HTMLCanvasElement;
  private mapBase: HTMLCanvasElement;
  constructor(parent: HTMLElement, private city: CityLayout) {
    if (!document.getElementById("gc-hud-css")) {
      const s = document.createElement("style");
      s.id = "gc-hud-css";
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    this.el = document.createElement("div");
    this.el.className = "gc-hud";
    this.el.innerHTML = `<div class="gc-tr"><div class="gc-cash"></div><div class="gc-stars"></div><div class="gc-bar"><i></i></div><div class="gc-bar st"><i></i></div><div class="gc-clock"></div></div>
      <div class="gc-obj"></div><div class="gc-ban"></div><div class="gc-hint"></div><div class="gc-speed"></div><canvas class="gc-map" width="200" height="200"></canvas>`;
    parent.appendChild(this.el);
    const q = (c: string) => this.el.querySelector(c) as HTMLDivElement;
    this.cash = q(".gc-cash");
    this.stars = q(".gc-stars");
    this.hp = this.el.querySelectorAll(".gc-bar i")[0] as HTMLElement;
    this.st = this.el.querySelectorAll(".gc-bar i")[1] as HTMLElement;
    this.obj = q(".gc-obj");
    this.ban = q(".gc-ban");
    this.hint = q(".gc-hint");
    this.speed = q(".gc-speed");
    this.clock = q(".gc-clock");
    this.map = this.el.querySelector(".gc-map") as HTMLCanvasElement;
    this.mapBase = this.drawBase();
  }

  private drawBase(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    const S = 0.6; // px per metre in the base map
    c.width = 700 * S;
    c.height = 760 * S;
    const g = c.getContext("2d")!;
    g.fillStyle = "#1c4e78";
    g.fillRect(0, 0, c.width, c.height);
    const X = (x: number) => (x + 230) * S, Z = (z: number) => (z + 250) * S;
    g.fillStyle = "#d9c38f";
    g.fillRect(X(-230), Z(-250), (272 + 230) * S, (292 + 250) * S);
    g.fillStyle = "#6c7684";
    for (const b of this.city.blocks) g.fillRect(X(b.x0), Z(b.z0), (b.x1 - b.x0) * S, (b.z1 - b.z0) * S);
    g.fillStyle = "#4c9a52";
    const p = this.city.park;
    g.fillRect(X(p.x0), Z(p.z0), (p.x1 - p.x0) * S, (p.z1 - p.z0) * S);
    g.strokeStyle = "#e9edf2";
    g.lineCap = "round";
    for (const e of this.city.edges) {
      g.lineWidth = e.halfWidth * 2 * S;
      g.beginPath();
      e.pts.forEach((pt, i) => (i ? g.lineTo(X(pt.x), Z(pt.z)) : g.moveTo(X(pt.x), Z(pt.z))));
      g.stroke();
    }
    g.fillStyle = "#a07850";
    const pr = this.city.pier;
    g.fillRect(X(pr.x0), Z(pr.z0), (pr.x1 - pr.x0) * S, (pr.z1 - pr.z0) * S);
    return c;
  }

  update(w: World, camYaw: number, visible: boolean): void {
    this.el.style.display = visible ? "" : "none";
    if (!visible) return;
    const reg = w.reg;
    this.cash.textContent = "$" + Math.round(reg.num("player.cash")).toLocaleString("en-US");
    const stars = w.police.stars;
    this.stars.innerHTML = `<span class="gc-heatlbl">HEAT</span>` + Array.from({ length: 5 }, (_, i) => `<i class="${i < stars ? "on" : ""}"></i>`).join("");
    this.stars.classList.toggle("flash", w.police.state === "pursuit");
    this.hp.style.width = Math.max(0, Math.min(100, w.player.health)) + "%";
    this.st.style.width = Math.max(0, w.player.stamina) + "%";
    const h = reg.num("world.time");
    this.clock.textContent = `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")} · ${reg.str("world.weather")}`;
    const run = w.missions.running;
    this.obj.textContent = run ? `${run.objective}${run.timeLeft >= 0 ? `  ·  ${Math.max(0, Math.ceil(run.timeLeft))}s` : ""}${run.progress ? "  ·  " + run.progress : ""}` : "Free roam - find a mission marker";
    if (w.bannerTimer > 0) {
      this.ban.style.opacity = "1";
      this.ban.innerHTML = `${esc(w.banner)}${w.bannerSub ? `<small>${esc(w.bannerSub)}</small>` : ""}`;
    } else this.ban.style.opacity = "0";
    this.hint.textContent = w.hint;
    this.hint.style.display = w.hint ? "" : "none";
    const v = w.playerVehicle;
    this.speed.innerHTML = v ? `${Math.round(Math.abs(v.speed) * 3.6)}<small> km/h</small>` : "";
    this.drawMap(w, camYaw);
  }

  private drawMap(w: World, camYaw: number): void {
    const g = this.map.getContext("2d")!;
    const W = this.map.width;
    const p = w.playerPos();
    const S = 0.6, zoom = 1.6;
    g.save();
    g.clearRect(0, 0, W, W);
    g.translate(W / 2, W / 2);
    g.rotate(camYaw + Math.PI);
    g.scale(zoom, zoom);
    g.drawImage(this.mapBase, -(p.x + 230) * S, -(p.z + 250) * S);
    const P = (x: number, z: number) => [(x - p.x) * S, (z - p.z) * S];
    for (const v of w.vehicles) {
      if (v.kind !== "police" || v.driver !== "ai") continue;
      const [x, z] = P(v.x, v.z);
      g.fillStyle = Math.sin(w.t * 10) > 0 ? "#ff3b30" : "#3b7bff";
      g.fillRect(x - 2.5, z - 2.5, 5, 5);
    }
    for (const m of w.missions.markers) {
      const [x, z] = P(m.x, m.z);
      g.fillStyle = "#" + m.colour.toString(16).padStart(6, "0");
      g.beginPath();
      g.arc(x, z, m.kind === "start" ? 5 : 4, 0, 7);
      g.fill();
      g.strokeStyle = "#000";
      g.lineWidth = 1;
      g.stroke();
    }
    g.restore();
    // target arrow on the rim when off-map
    const tgt = w.missions.target;
    if (tgt) {
      const dx = tgt.x - p.x, dz = tgt.z - p.z;
      const a = Math.atan2(dz, dx) + camYaw + Math.PI;
      const d = Math.hypot(dx, dz) * S * zoom;
      if (d > W / 2 - 8) {
        g.fillStyle = "#ffd23f";
        g.beginPath();
        const r = W / 2 - 10;
        const cx = W / 2 + Math.cos(a) * r, cz = W / 2 + Math.sin(a) * r;
        g.moveTo(cx + Math.cos(a) * 8, cz + Math.sin(a) * 8);
        g.lineTo(cx + Math.cos(a + 2.4) * 7, cz + Math.sin(a + 2.4) * 7);
        g.lineTo(cx + Math.cos(a - 2.4) * 7, cz + Math.sin(a - 2.4) * 7);
        g.fill();
      }
    }
    // player arrow (always points up = camera forward; rotate by heading difference)
    const heading = w.playerVehicle ? w.playerVehicle.heading : w.player.heading;
    g.save();
    g.translate(W / 2, W / 2);
    g.rotate(-(heading - camYaw));
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.moveTo(0, -9);
    g.lineTo(6, 7);
    g.lineTo(0, 3);
    g.lineTo(-6, 7);
    g.fill();
    g.restore();
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
