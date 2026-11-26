/**
 * Fieldbook simulation. Pure logic: no drawing, no DOM. Tunables and the
 * farmer's inventory live in the VariableRegistry (so a spreadsheet edit is
 * the same thing as the game changing a value); prices come from RULES.
 */
import type { InputState } from "../../engines/core/input";
import type { VariableRegistry } from "../../engines/core/variables";
import { ParticleSystem } from "../../engines/raster2d";
import {
  CROPS, CROP_IDS, type CropId, DAY_START_HOUR, type ItemId, PASS_OUT_HOUR, SEASONS, type Season, TOOLS, type Tool,
} from "./defs";
import {
  BED_TILES, COOP_RECT, FIELD_RECT, type FarmMap, PEN_RECT, SPAWN, T, TILE, buildFarm, isFieldTile, isSolidTile, propAtTile,
} from "./map";

export type Dir = "down" | "up" | "left" | "right";
export const DIR_VEC: Record<Dir, [number, number]> = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] };

export interface Plot {
  tilled: boolean;
  watered: boolean;
  crop: CropId | null;
  /** Watered growth-days accumulated. */
  growth: number;
  dry: number;
  withered: boolean;
  harvests: number;
}

export type OrderStatus = "OPEN" | "DONE" | "LATE";
export interface Order {
  id: number;
  item: ItemId;
  qty: number;
  delivered: number;
  due: number;
  reward: number;
  status: OrderStatus;
}

export interface Chicken {
  x: number;
  y: number;
  tx: number;
  ty: number;
  flip: boolean;
  timer: number;
  pecking: boolean;
  anim: number;
}

export interface Floater {
  text: string;
  x: number;
  y: number;
  t: number;
  color: number;
}

export interface Farmer {
  x: number;
  y: number;
  dir: Dir;
  moving: boolean;
  walkT: number;
  tool: number;
  seed: CropId;
  /** Tool animation timer (seconds remaining) and what it shows. */
  actionT: number;
  action: "" | "hoe" | "water" | "plant" | "harvest";
  actionTile: [number, number];
}

export const ITEM_NAME: Record<ItemId, string> = { carrot: "Carrot", tomato: "Tomato", pumpkin: "Pumpkin", cabbage: "Cabbage", egg: "Egg" };
const ITEM_RULE: Record<ItemId, string> = { carrot: "Price_Carrot", tomato: "Price_Tomato", pumpkin: "Price_Pumpkin", cabbage: "Price_Cabbage", egg: "Price_Egg" };
export const ITEMS: ItemId[] = ["carrot", "tomato", "pumpkin", "cabbage", "egg"];

const FEET_HW = 3; // half width of the farmer's collision box
const FEET_H = 3;

export class FarmSim {
  readonly map: FarmMap = buildFarm();
  plots: Plot[] = [];
  farmer!: Farmer;
  chickens: Chicken[] = [];
  eggs: [number, number][] = [];
  orders: Order[] = [];
  particles = new ParticleSystem(300);
  floaters: Floater[] = [];
  banner = { text: "", t: 0 };
  hint = "";
  /** Seconds of sleep fade remaining (visual only). */
  fade = 0;
  /** Bumped when the static ground (tilled/watered soil, season) must be redrawn. */
  groundVersion = 0;
  time = 0;
  private stepCount = 0;
  private nextOrderId = 1;
  /** Total revenue (sales + order rewards) - handy for tests and telemetry. */
  revenue = 0;
  lastSale = { units: 0, cash: 0 };

  constructor(readonly reg: VariableRegistry, readonly rng: () => number) {
    reg.onChange((key) => this.onEdit(key));
    this.reset();
  }

  // ---- registry helpers --------------------------------------------------
  n(key: string): number {
    return this.reg.num(key);
  }
  set(key: string, v: number | string | boolean): void {
    this.reg.setLive(key, v);
  }
  add(key: string, dv: number): void {
    this.set(key, this.n(key) + dv);
  }
  get season(): Season {
    return this.reg.str("farm.season") as Season;
  }
  get raining(): boolean {
    return this.reg.str("farm.weather") === "Rain";
  }
  get hour(): number {
    return this.n("farm.hour");
  }
  get day(): number {
    return this.n("farm.day");
  }
  get tool(): Tool {
    return TOOLS[this.farmer.tool];
  }
  price(item: ItemId): number {
    return this.reg.rule(ITEM_RULE[item]);
  }

  /**
   * New game: restore simulation-owned (live) variables to their defaults and
   * rebuild the world. Tunables edited in the sheet (prices, speeds) are kept.
   */
  reset(): void {
    for (const d of this.reg.defs) if (d.live) this.reg.setLive(d.key, d.default);
    this.set("farmer.canWater", this.n("farmer.canCapacity"));
    this.set("farmer.stamina", this.n("farmer.maxStamina"));
    this.plots = Array.from({ length: FIELD_RECT.w * FIELD_RECT.h }, () => ({ tilled: false, watered: false, crop: null, growth: 0, dry: 0, withered: false, harvests: 0 }));
    // a few pre-tilled rows so the first morning reads as a farm
    for (let x = 0; x < 4; x++) this.plots[x].tilled = true;
    this.farmer = { x: SPAWN.tx * TILE + 4, y: SPAWN.ty * TILE + 6, dir: "down", moving: false, walkT: 0, tool: 0, seed: "carrot", actionT: 0, action: "", actionTile: [0, 0] };
    this.eggs = [];
    this.orders = [];
    this.nextOrderId = 1;
    this.addOrder("carrot", 8, 5, 140);
    this.addOrder("egg", 5, 6, 60);
    this.addOrder("cabbage", 4, 9, 150);
    this.particles.clear();
    this.floaters = [];
    this.revenue = 0;
    this.syncFlock();
    this.syncSeasonNo();
    this.reg.recomputeRules();
    this.showBanner("DAY 1 - SPRING");
    this.groundVersion++;
  }

  plot(tx: number, ty: number): Plot | undefined {
    if (!isFieldTile(tx, ty)) return undefined;
    return this.plots[(ty - FIELD_RECT.y) * FIELD_RECT.w + (tx - FIELD_RECT.x)];
  }
  isRipe(p: Plot): boolean {
    return !!p.crop && !p.withered && p.growth >= CROPS[p.crop].days;
  }
  /** 0 seeded, 1 sprout, 2 young, 3 ripe. */
  stage(p: Plot): number {
    if (!p.crop) return -1;
    if (this.isRipe(p)) return 3;
    return Math.min(2, Math.floor((p.growth / CROPS[p.crop].days) * 3));
  }

  farmerTile(): [number, number] {
    return [Math.floor(this.farmer.x / TILE), Math.floor((this.farmer.y - 1) / TILE)];
  }
  targetTile(): [number, number] {
    const [tx, ty] = this.farmerTile();
    const [dx, dy] = DIR_VEC[this.farmer.dir];
    return [tx + dx, ty + dy];
  }

  showBanner(text: string, t = 2.2): void {
    this.banner = { text, t };
  }
  private float(text: string, x: number, y: number, color: number): void {
    this.floaters.push({ text, x, y, t: 1.2, color });
    if (this.floaters.length > 8) this.floaters.shift();
  }

  // ---- edits from the spreadsheet ------------------------------------------
  private onEdit(key: string): void {
    if (key === "farm.weather" && this.raining) this.rainOnPlots();
    if (key === "farm.season") {
      this.syncSeasonNo();
      this.witherOutOfSeason();
      this.reg.recomputeRules();
    }
    if (key === "farm.chickens") this.syncFlock();
    if (key === "farmer.canCapacity" && this.n("farmer.canWater") > this.n("farmer.canCapacity")) this.set("farmer.canWater", this.n("farmer.canCapacity"));
    this.groundVersion++;
  }

  private syncSeasonNo(): void {
    this.set("farm.seasonNo", SEASONS.indexOf(this.season) + 1);
  }

  private rainOnPlots(): void {
    for (const p of this.plots) if (p.tilled) p.watered = true;
    this.groundVersion++;
  }

  private witherOutOfSeason(): void {
    for (const p of this.plots) if (p.crop && !p.withered && !CROPS[p.crop].seasons.includes(this.season)) p.withered = true;
  }

  syncFlock(): void {
    const want = Math.round(this.n("farm.chickens"));
    while (this.chickens.length > want) this.chickens.pop();
    while (this.chickens.length < want) {
      const i = this.chickens.length;
      const x = (PEN_RECT.x + (i % 3) + 0.5) * TILE;
      const y = (PEN_RECT.y + 2 + Math.floor(i / 3)) * TILE + 4;
      this.chickens.push({ x, y, tx: x, ty: y, flip: i % 2 === 1, timer: 0.5 + i * 0.3, pecking: false, anim: i * 0.37 });
    }
  }

  // ---- simulation step --------------------------------------------------
  step(dt: number, input: InputState): void {
    this.time += dt;
    const f = this.farmer;
    if (this.banner.t > 0) this.banner.t -= dt;
    if (this.fade > 0) this.fade = Math.max(0, this.fade - dt);
    if (f.actionT > 0) f.actionT = Math.max(0, f.actionT - dt);
    for (const fl of this.floaters) {
      fl.t -= dt;
      fl.y -= 10 * dt;
    }
    this.floaters = this.floaters.filter((fl) => fl.t > 0);

    // tool / seed selection
    for (let i = 0; i < 4; i++)
      if (input.pressed(`seed${i + 1}`)) {
        f.seed = CROP_IDS[i];
        f.tool = TOOLS.indexOf("SEEDS");
      }
    if (input.pressed("seednext")) {
      f.seed = CROP_IDS[(CROP_IDS.indexOf(f.seed) + 1) % CROP_IDS.length];
      f.tool = TOOLS.indexOf("SEEDS");
    }
    if (input.pressed("tool")) f.tool = (f.tool + 1) % TOOLS.length;

    // movement
    let mx = input.combined("left", "right", "moveX");
    let my = input.combined("up", "down", "moveY");
    f.moving = mx !== 0 || my !== 0;
    if (f.moving) {
      if (mx !== 0 && my === 0) f.dir = mx < 0 ? "left" : "right";
      else if (my !== 0 && mx === 0) f.dir = my < 0 ? "up" : "down";
      else if (Math.abs(mx) > Math.abs(my) + 0.2) f.dir = mx < 0 ? "left" : "right";
      else if (Math.abs(my) > Math.abs(mx) + 0.2) f.dir = my < 0 ? "up" : "down";
      const len = Math.hypot(mx, my);
      if (len > 1) {
        mx /= len;
        my /= len;
      }
      const speed = this.n("farmer.walkSpeed") * TILE;
      this.moveFarmer(mx * speed * dt, 0);
      this.moveFarmer(0, my * speed * dt);
      f.walkT += dt;
    } else f.walkT = 0;

    // eggs are picked up by walking over them
    const [ftx, fty] = this.farmerTile();
    const ei = this.eggs.findIndex(([x, y]) => x === ftx && y === fty);
    if (ei >= 0) {
      this.eggs.splice(ei, 1);
      this.add("farmer.basket.egg", 1);
      this.float("+1 EGG", f.x, f.y - 14, 0xfff4dc);
      this.particles.burst({ x: f.x, y: f.y - 4, count: 6, speed: [10, 25], angle: [-Math.PI, 0], life: [0.3, 0.6], colors: [0xfff4dc, 0xf2c94c] }, this.rng);
    }

    if (input.pressed("use")) this.use();
    if (input.pressed("sleep")) {
      if (BED_TILES.some(([x, y]) => x === ftx && y === fty)) this.sleep(false);
      else this.showBanner("GO HOME TO SLEEP (DOORSTEP)");
    }

    // clock
    const dayLen = Math.max(1, this.n("farm.dayLength"));
    const h = this.hour + (dt * (PASS_OUT_HOUR - DAY_START_HOUR)) / dayLen;
    if (h >= PASS_OUT_HOUR) this.sleep(true);
    else this.set("farm.hour", h);

    this.updateChickens(dt);
    this.particles.update(dt);
    this.hint = this.computeHint();
    // setLive() does not recompute rules; refresh twice a second so the RULES sheet tracks Hour etc.
    if (++this.stepCount % 15 === 0) this.reg.recomputeRules();
  }

  private moveFarmer(dx: number, dy: number): void {
    const f = this.farmer;
    const nx = f.x + dx;
    const ny = f.y + dy;
    if (!this.boxBlocked(nx, ny)) {
      f.x = nx;
      f.y = ny;
    }
  }

  /** Feet box [x-3, x+3) × [y-3, y) against solid tiles. */
  boxBlocked(x: number, y: number): boolean {
    const x0 = Math.floor((x - FEET_HW) / TILE);
    const x1 = Math.floor((x + FEET_HW - 0.001) / TILE);
    const y0 = Math.floor((y - FEET_H) / TILE);
    const y1 = Math.floor((y - 0.001) / TILE);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (isSolidTile(this.map, tx, ty)) return true;
    return false;
  }

  private spend(): boolean {
    const cost = this.n("farmer.toolStamina");
    if (this.n("farmer.stamina") < cost) {
      this.showBanner("TOO TIRED - GO TO BED (R)");
      return false;
    }
    this.add("farmer.stamina", -cost);
    return true;
  }

  private act(kind: Farmer["action"], tx: number, ty: number): void {
    this.farmer.action = kind;
    this.farmer.actionT = 0.3;
    this.farmer.actionTile = [tx, ty];
  }

  /** What E would do right now (drives hud().hint and the in-frame prompt). */
  computeHint(): string {
    const [tx, ty] = this.targetTile();
    const prop = propAtTile(this.map, tx, ty);
    if (prop?.kind === "stall") return this.basketCount() ? `E SELL ${this.basketCount()}` : "STALL: BRING PRODUCE";
    if (prop?.kind === "crate") return `E BUY ${CROPS[this.farmer.seed].pack} ${ITEM_NAME[this.farmer.seed].toUpperCase()} $${this.n(`market.seed.${this.farmer.seed}`) * CROPS[this.farmer.seed].pack}`;
    if (prop?.kind === "shed") return this.n("farmer.canLevel") >= 6 ? "CAN FULLY UPGRADED" : `E UPGRADE CAN $${this.reg.rule("UpgradeCost_Can")}`;
    if (prop?.kind === "well" || this.map.tiles.get(tx, ty) === T.WATER) return "E REFILL CAN";
    if (prop?.kind === "board") return this.deliverable() ? `E DELIVER ${this.deliverable()}` : "E READ ORDERS";
    const [ftx, fty] = this.farmerTile();
    if (BED_TILES.some(([x, y]) => x === ftx && y === fty)) return "R SLEEP";
    const p = this.plot(tx, ty);
    if (p) {
      if (this.isRipe(p)) return "E HARVEST";
      if (p.withered) return "E CLEAR";
      if (this.tool === "HOE" && !p.tilled) return "E TILL";
      if (this.tool === "CAN" && p.tilled && !p.watered) return "E WATER";
      if (this.tool === "SEEDS" && p.tilled && !p.crop) return `E PLANT ${ITEM_NAME[this.farmer.seed].toUpperCase()}`;
    }
    return "";
  }

  use(): void {
    const [tx, ty] = this.targetTile();
    const f = this.farmer;
    const prop = propAtTile(this.map, tx, ty);
    if (prop) {
      switch (prop.kind) {
        case "stall":
          return this.sellAll();
        case "crate":
          return this.buySeeds(f.seed);
        case "shed":
          return this.upgradeCan();
        case "well":
          return this.refill();
        case "board":
          return this.deliverOrders();
        case "house":
        case "mat":
          return this.showBanner("STAND ON THE DOORSTEP, PRESS R");
        case "coop":
          return this.showBanner("HENS LAY IN THE PEN EACH MORNING");
        default:
          break;
      }
    }
    if (this.map.tiles.get(tx, ty) === T.WATER) return this.refill();
    const p = this.plot(tx, ty);
    if (!p) {
      if (this.tool === "HOE") this.showBanner("TILL INSIDE THE FENCED FIELD");
      return;
    }
    const cx = tx * TILE + 4;
    const cy = ty * TILE + 4;
    if (this.isRipe(p)) {
      const crop = p.crop!;
      this.add(`farmer.basket.${crop}`, 1);
      p.harvests++;
      if (CROPS[crop].regrow > 0) p.growth = CROPS[crop].days - CROPS[crop].regrow;
      else {
        p.crop = null;
        p.growth = 0;
      }
      this.act("harvest", tx, ty);
      this.float(`+1 ${ITEM_NAME[crop].toUpperCase()}`, cx, cy - 8, 0xfff4dc);
      this.particles.burst({ x: cx, y: cy, count: 10, speed: [15, 40], angle: [-Math.PI, 0], life: [0.3, 0.7], colors: [0xfff4a0, 0xffffff, 0x9be36a], gravity: 60 }, this.rng);
      this.groundVersion++;
      return;
    }
    if (p.withered) {
      if (!this.spend()) return;
      p.crop = null;
      p.withered = false;
      p.growth = 0;
      this.act("hoe", tx, ty);
      this.dirt(cx, cy);
      this.groundVersion++;
      return;
    }
    switch (this.tool) {
      case "HOE":
        if (p.tilled) return this.showBanner(p.crop ? "IT'S GROWING" : "ALREADY TILLED", 1.2);
        if (!this.spend()) return;
        p.tilled = true;
        p.watered = this.raining;
        this.act("hoe", tx, ty);
        this.dirt(cx, cy);
        this.groundVersion++;
        return;
      case "CAN":
        if (!p.tilled) return this.showBanner("TILL THE SOIL FIRST", 1.2);
        if (p.watered) return this.showBanner("ALREADY WATERED", 1.2);
        if (this.n("farmer.canWater") <= 0) return this.showBanner("CAN EMPTY - REFILL AT WELL");
        if (!this.spend()) return;
        p.watered = true;
        this.add("farmer.canWater", -1);
        this.act("water", tx, ty);
        this.particles.burst({ x: cx, y: cy - 2, count: 10, speed: [10, 30], angle: [Math.PI * 0.2, Math.PI * 0.8], life: [0.2, 0.45], colors: [0x8fd3f0, 0xd8f2ff, 0x5aa8d8], gravity: 80 }, this.rng);
        this.groundVersion++;
        return;
      case "SEEDS": {
        const crop = f.seed;
        if (!p.tilled) return this.showBanner("TILL THE SOIL FIRST", 1.2);
        if (p.crop) return this.showBanner("PLOT IS OCCUPIED", 1.2);
        if (this.n(`farmer.seeds.${crop}`) <= 0) return this.showBanner(`NO ${ITEM_NAME[crop].toUpperCase()} SEEDS - BUY AT CRATE`);
        if (!CROPS[crop].seasons.includes(this.season)) return this.showBanner(`${ITEM_NAME[crop].toUpperCase()} WON'T GROW IN ${this.season.toUpperCase()}`);
        if (!this.spend()) return;
        p.crop = crop;
        p.growth = 0;
        p.dry = 0;
        p.harvests = 0;
        this.add(`farmer.seeds.${crop}`, -1);
        this.act("plant", tx, ty);
        this.dirt(cx, cy);
        this.groundVersion++;
        return;
      }
    }
  }

  private dirt(x: number, y: number): void {
    this.particles.burst({ x, y, count: 8, speed: [12, 30], angle: [-Math.PI * 0.95, -Math.PI * 0.05], life: [0.25, 0.5], colors: [0x8a5a3a, 0x6e4530, 0xb07a4e], gravity: 120, floorOffset: 3 }, this.rng);
  }

  basketCount(): number {
    return ITEMS.reduce((s, i) => s + this.n(`farmer.basket.${i}`), 0);
  }

  refill(): void {
    const cap = this.n("farmer.canCapacity");
    if (this.n("farmer.canWater") >= cap) return this.showBanner("CAN IS FULL", 1.2);
    this.set("farmer.canWater", cap);
    const [tx, ty] = this.targetTile();
    this.particles.burst({ x: tx * TILE + 4, y: ty * TILE + 4, count: 12, speed: [10, 30], angle: [-Math.PI, 0], life: [0.3, 0.6], colors: [0x8fd3f0, 0xd8f2ff], gravity: 90 }, this.rng);
    this.showBanner(`CAN FILLED ${cap}/${cap}`, 1.4);
  }

  /** Units in the basket that some open order still wants. */
  deliverable(): number {
    let n = 0;
    for (const item of ITEMS) {
      const want = this.orders.filter((o) => o.status === "OPEN" && o.item === item).reduce((s, o) => s + o.qty - o.delivered, 0);
      n += Math.min(want, this.n(`farmer.basket.${item}`));
    }
    return n;
  }

  /** At the order board: hand matching produce to open orders (oldest first); completed orders pay their reward. */
  deliverOrders(): void {
    let delivered = 0;
    let rewards = 0;
    let done = 0;
    for (const o of this.orders) {
      if (o.status !== "OPEN") continue;
      const key = `farmer.basket.${o.item}`;
      const give = Math.min(this.n(key), o.qty - o.delivered);
      if (give <= 0) continue;
      o.delivered += give;
      delivered += give;
      this.add(key, -give);
      if (o.delivered >= o.qty) {
        o.status = "DONE";
        rewards += o.reward;
        done++;
      }
    }
    if (!delivered) {
      const open = this.orders.filter((o) => o.status === "OPEN");
      this.showBanner(open.length ? open.map((o) => `${o.qty - o.delivered} ${ITEM_NAME[o.item].toUpperCase()} D${o.due}`).join("  ") : "NO OPEN ORDERS", 3);
      return;
    }
    const f = this.farmer;
    if (rewards) {
      this.add("farmer.cash", rewards);
      this.revenue += rewards;
      this.showBanner(done > 1 ? `${done} ORDERS DONE! +$${rewards}` : `ORDER DONE! +$${rewards}`, 2.6);
      this.float(`+$${rewards}`, f.x, f.y - 16, 0xf2c94c);
      this.particles.burst({ x: f.x, y: f.y - 12, count: 18, speed: [20, 50], angle: [-Math.PI * 0.9, -Math.PI * 0.1], life: [0.5, 1], colors: [0xf2c94c, 0xffe9a0, 0xd9544a, 0x6fb7d8], gravity: 80, size: [1, 2] }, this.rng);
      this.topUpOrders();
    } else this.showBanner(`DELIVERED ${delivered} - KEEP GOING`, 2.2);
  }

  /** At the stall: sell the whole basket one unit at a time; each sale lowers demand, so the next unit is re-priced by the RULES. */
  sellAll(): void {
    const total = this.basketCount();
    if (!total) return this.showBanner("BASKET EMPTY - HARVEST FIRST");
    let cash = 0;
    let units = 0;
    for (const item of ITEMS) {
      let have = this.n(`farmer.basket.${item}`);
      while (have > 0) {
        cash += this.price(item);
        units++;
        have--;
        this.add(`market.sold.${item}`, 1);
        this.reg.recomputeRules();
      }
      this.set(`farmer.basket.${item}`, 0);
    }
    this.add("farmer.cash", cash);
    this.revenue += cash;
    this.lastSale = { units, cash };
    const f = this.farmer;
    this.showBanner(`SOLD ${units} FOR $${cash}`, 2.2);
    this.float(`+$${cash}`, f.x, f.y - 16, 0xf2c94c);
    this.particles.burst({ x: f.x, y: f.y - 12, count: 14, speed: [20, 45], angle: [-Math.PI * 0.9, -Math.PI * 0.1], life: [0.5, 0.9], colors: [0xf2c94c, 0xffe9a0, 0xc99a2e], gravity: 90, size: [1, 2] }, this.rng);
  }

  buySeeds(crop: CropId): void {
    const unit = this.n(`market.seed.${crop}`);
    const cash = this.n("farmer.cash");
    const qty = unit > 0 ? Math.min(CROPS[crop].pack, Math.floor(cash / unit)) : CROPS[crop].pack;
    if (qty <= 0) return this.showBanner(`NEED $${unit} FOR A SEED`);
    this.add("farmer.cash", -qty * unit);
    this.add(`farmer.seeds.${crop}`, qty);
    this.showBanner(`BOUGHT ${qty} ${ITEM_NAME[crop].toUpperCase()} SEEDS -$${qty * unit}`);
  }

  upgradeCan(): void {
    const lvl = this.n("farmer.canLevel");
    if (lvl >= 6) return this.showBanner("CAN FULLY UPGRADED");
    const cost = this.reg.rule("UpgradeCost_Can");
    if (this.n("farmer.cash") < cost) return this.showBanner(`UPGRADE COSTS $${cost}`);
    const size = Math.round(this.reg.rule("UpgradeSize_Can"));
    this.add("farmer.cash", -cost);
    this.set("farmer.canLevel", lvl + 1);
    this.set("farmer.canCapacity", this.n("farmer.canCapacity") + size);
    this.set("farmer.canWater", this.n("farmer.canCapacity"));
    this.reg.recomputeRules();
    this.showBanner(`CAN LV${lvl + 1}: +${size} WATER`, 2.5);
  }

  // ---- nights, seasons, weather, orders ---------------------------------
  sleep(passedOut: boolean): void {
    this.reg.recomputeRules();
    let restore = this.reg.rule("SleepRestore");
    let msg = "";
    if (passedOut) {
      const fee = Math.round(this.n("farmer.cash") * 0.1);
      this.add("farmer.cash", -fee);
      restore = this.n("farmer.maxStamina") * 0.5;
      msg = `PASSED OUT! DOCTOR -$${fee}`;
    }
    const speed = this.n("farm.growthSpeed");
    const drought = this.n("farm.droughtDays");
    for (const p of this.plots) {
      if (p.crop && !p.withered) {
        if (p.watered) {
          p.growth = Math.min(CROPS[p.crop].days, p.growth + speed);
          p.dry = 0;
        } else if (++p.dry >= drought) p.withered = true;
      }
      p.watered = false;
    }
    const day = this.day + 1;
    this.set("farm.day", day);
    const len = Math.max(1, Math.round(this.n("farm.seasonLength")));
    if ((day - 1) % len === 0) {
      this.set("farm.season", SEASONS[(SEASONS.indexOf(this.season) + 1) % 4]);
      this.syncSeasonNo();
      this.witherOutOfSeason();
    }
    const rain = this.rng() < this.n("farm.rainChance");
    this.set("farm.weather", rain ? "Rain" : "Sunny");
    if (rain) this.rainOnPlots();
    this.layEggs();
    const keep = 1 - this.n("market.demandRecovery");
    for (const i of ITEMS) this.set(`market.sold.${i}`, Math.round(this.n(`market.sold.${i}`) * keep * 100) / 100);
    for (const o of this.orders) if (o.status === "OPEN" && o.due < day) o.status = "LATE";
    this.topUpOrders();
    this.set("farmer.stamina", passedOut ? restore : Math.max(this.n("farmer.stamina"), restore));
    this.set("farm.hour", DAY_START_HOUR);
    this.farmer.x = SPAWN.tx * TILE + 4;
    this.farmer.y = SPAWN.ty * TILE + 6;
    this.farmer.dir = "down";
    this.farmer.actionT = 0;
    this.fade = 1.4;
    this.reg.recomputeRules();
    this.showBanner(msg || `DAY ${day} - ${this.season.toUpperCase()}${rain ? (this.season === "Winter" ? " - SNOW" : " - RAIN") : ""}`, 2.6);
    this.groundVersion++;
  }

  private layEggs(): void {
    for (let i = 0; i < this.chickens.length; i++) {
      if (this.rng() >= this.n("farm.eggChance") || this.eggs.length >= 12) continue;
      for (let tries = 0; tries < 8; tries++) {
        const tx = PEN_RECT.x + Math.floor(this.rng() * PEN_RECT.w);
        const ty = PEN_RECT.y + Math.floor(this.rng() * PEN_RECT.h);
        if (isSolidTile(this.map, tx, ty) || this.eggs.some(([x, y]) => x === tx && y === ty)) continue;
        this.eggs.push([tx, ty]);
        break;
      }
    }
  }

  private addOrder(item: ItemId, qty: number, due: number, reward: number): void {
    this.orders.push({ id: this.nextOrderId++, item, qty, delivered: 0, due, reward, status: "OPEN" });
  }

  private topUpOrders(): void {
    let open = this.orders.filter((o) => o.status === "OPEN").length;
    while (open < 3) {
      const growable = CROP_IDS.filter((c) => CROPS[c].seasons.includes(this.season));
      const pool: ItemId[] = [...growable, "egg"];
      const item = pool[Math.floor(this.rng() * pool.length) % pool.length];
      const [lo, hi] = item === "pumpkin" ? [2, 5] : item === "tomato" ? [4, 9] : item === "egg" ? [4, 9] : [5, 12];
      const qty = lo + Math.floor(this.rng() * (hi - lo + 1));
      const grow = item === "egg" ? 1 : CROPS[item].days;
      const due = this.day + grow + 2 + Math.floor(this.rng() * 4);
      const base = this.n(`market.base.${item}`);
      const reward = Math.max(10, Math.round((qty * base * (1.5 + this.rng() * 0.6)) / 5) * 5);
      this.addOrder(item, qty, due, reward);
      open++;
    }
    // keep the sheet readable: the 3 open orders plus the 7 most recent closed ones
    const closed = this.orders.filter((o) => o.status !== "OPEN");
    if (closed.length > 7) {
      const drop = new Set(closed.slice(0, closed.length - 7).map((o) => o.id));
      this.orders = this.orders.filter((o) => !drop.has(o.id));
    }
  }

  // ---- chickens -----------------------------------------------------------
  private updateChickens(dt: number): void {
    const x0 = PEN_RECT.x * TILE + 3, x1 = (PEN_RECT.x + PEN_RECT.w) * TILE - 3;
    const y0 = PEN_RECT.y * TILE + 5, y1 = (PEN_RECT.y + PEN_RECT.h) * TILE - 1;
    for (const c of this.chickens) {
      c.anim += dt;
      c.timer -= dt;
      const dx = c.tx - c.x, dy = c.ty - c.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.5 && !c.pecking) {
        const sp = Math.min(d, 9 * dt);
        c.x += (dx / d) * sp;
        c.y += (dy / d) * sp;
        if (Math.abs(dx) > 0.2) c.flip = dx < 0;
      }
      if (c.timer <= 0) {
        if (this.rng() < 0.45) {
          c.pecking = true;
          c.timer = 0.8 + this.rng() * 1.4;
        } else {
          c.pecking = false;
          for (let k = 0; k < 6; k++) {
            const nx = x0 + this.rng() * (x1 - x0);
            const ny = y0 + this.rng() * (y1 - y0);
            const ntx = Math.floor(nx / TILE), nty = Math.floor((ny - 1) / TILE);
            const inCoop = ntx >= COOP_RECT.x - 0 && nty < COOP_RECT.y + COOP_RECT.h && ntx < COOP_RECT.x + COOP_RECT.w;
            if (inCoop || isSolidTile(this.map, ntx, nty)) continue;
            c.tx = nx;
            c.ty = ny;
            break;
          }
          c.timer = 1 + this.rng() * 2;
        }
      }
    }
  }

  // ---- debug/staging helpers (screenshots, tests) ---------------------------
  teleport(tx: number, ty: number, dir: Dir = "down"): void {
    this.farmer.x = tx * TILE + 4;
    this.farmer.y = ty * TILE + 6;
    this.farmer.dir = dir;
  }
  stagePlot(tx: number, ty: number, crop: CropId | null, growthFrac: number, watered = false, withered = false): void {
    const p = this.plot(tx, ty);
    if (!p) throw new Error(`not a field tile ${tx},${ty}`);
    p.tilled = true;
    p.crop = crop;
    p.watered = watered;
    p.withered = withered;
    p.growth = crop ? CROPS[crop].days * growthFrac : 0;
    this.groundVersion++;
  }
}
