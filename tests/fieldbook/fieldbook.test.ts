import { test } from "node:test";
import assert from "node:assert/strict";
import { approachFromBelow, makeHarness, selectTool, sellAtStall, type Harness } from "./harness";
import { createFieldbook } from "../../examples/fieldbook/game";
import { CROPS } from "../../examples/fieldbook/defs";

// Long days so the clock never interferes with scripted walking; no surprise rain.
const CALM = { "farm.rainChance": 0, "farm.dayLength": 900 };

function plot(h: Harness, tx: number, ty: number) {
  const p = h.game.sim.plot(tx, ty);
  assert.ok(p, `plot ${tx},${ty}`);
  return p;
}

function sleepInBed(h: Harness): void {
  h.walkTo(4, 5);
  const day = h.game.sim.day;
  h.press("sleep");
  assert.equal(h.game.sim.day, day + 1, "sleeping advances the day");
}

test("contract: createFieldbook() exposes the SpreadsheetGame surface", async () => {
  const g = createFieldbook();
  assert.equal(g.id, "fieldbook");
  assert.ok(g.variables.some((v) => v.sheet === "FARMER"));
  assert.ok(g.variables.some((v) => v.sheet === "FARM"));
  assert.ok(g.variables.some((v) => v.sheet === "MARKET"));
  assert.ok(g.rules.some((r) => r.name === "Price_Tomato"));
  assert.ok(g.customSheets.some((s) => s.name === "ORDERS"));
  assert.deepEqual(g.commands.map((c) => c.id).sort(), ["new-game", "skip-day"]);
  for (const k of ["KeyW", "ArrowUp", "KeyE", "Space", "KeyQ", "KeyR", "Digit1", "Digit4"]) assert.ok(g.keyBindings[k], k);
  assert.ok(g.touchButtons.length >= 6);
  const h = await makeHarness(3);
  const hud = h.game.hud();
  for (const label of ["DAY", "SEASON", "CASH", "STAMINA", "TOOL"]) assert.ok(hud.stats.some(([l]) => l === label), label);
  assert.throws(() => h.game.canvas(), /DOM/, "canvas() explains it needs a DOM in Node");
  const orders = h.game.customSheets.find((s) => s.name === "ORDERS")!.rows();
  assert.equal(orders.length, 3);
  assert.equal(orders[0].cells[1], "Carrot");
});

test("scripted farmer: till, plant, water, wait days, harvest, sell -> cash increases", async () => {
  const h = await makeHarness(5, CALM);
  const sim = h.game.sim;
  const startCash = h.cash();
  const plots: [number, number][] = [[3, 9], [4, 9]];
  const stamina0 = h.registry.num("farmer.stamina");

  // day 1: till, plant carrots, water
  for (const [tx, ty] of plots) {
    approachFromBelow(h, tx, ty);
    selectTool(h, "HOE");
    h.press("use");
    assert.equal(plot(h, tx, ty).tilled, true, "hoe tills the plot");
    h.press("seed1");
    assert.equal(sim.tool, "SEEDS");
    h.press("use");
    assert.equal(plot(h, tx, ty).crop, "carrot", "seed planted");
    selectTool(h, "CAN");
    h.press("use");
    assert.equal(plot(h, tx, ty).watered, true, "plot watered");
  }
  assert.equal(h.registry.num("farmer.seeds.carrot"), 8);
  assert.ok(h.registry.num("farmer.stamina") < stamina0, "tool use costs stamina");
  assert.equal(h.registry.num("farmer.canWater"), 6);

  // nights: sleep, then water again in the morning until ripe
  let days = 0;
  while (!sim.isRipe(plot(h, 3, 9))) {
    sleepInBed(h);
    days++;
    assert.ok(days <= CROPS.carrot.days, "carrots ripen after their growth days");
    if (sim.isRipe(plot(h, 3, 9))) break;
    for (const [tx, ty] of plots) {
      approachFromBelow(h, tx, ty);
      selectTool(h, "CAN");
      h.press("use");
      assert.equal(plot(h, tx, ty).watered, true);
    }
  }
  assert.equal(days, CROPS.carrot.days);
  assert.equal(sim.stage(plot(h, 4, 9)), 3, "both plots ripe");

  // harvest (any tool works on a ripe crop)
  for (const [tx, ty] of plots) {
    approachFromBelow(h, tx, ty);
    h.press("use");
    assert.equal(plot(h, tx, ty).crop, null);
  }
  assert.equal(h.registry.num("farmer.basket.carrot"), 2);

  // sell at the market stall
  const gained = sellAtStall(h);
  assert.ok(gained > 0, `sale earned ${gained}`);
  assert.equal(h.registry.num("farmer.basket.carrot"), 0);
  assert.ok(h.cash() > startCash, `cash ${startCash} -> ${h.cash()}`);
  assert.match(h.game.hud().banner ?? "", /SOLD 2/);
});

async function revenueFor(tune: Record<string, number | string>, carrots = 5, rule?: [string, string]): Promise<{ gained: number; h: Harness }> {
  const h = await makeHarness(9, { ...CALM, ...tune });
  if (rule) {
    const r = h.registry.setRuleFormula(rule[0], rule[1]);
    assert.equal(r.ok, true, r.error);
  }
  assert.equal(h.registry.edit("farmer.basket.carrot", carrots).ok, true);
  return { gained: sellAtStall(h), h };
}

test("MARKET: editing a base price changes sale revenue", async () => {
  const base = await revenueFor({});
  const doubled = await revenueFor({ "market.base.carrot": 28 });
  assert.ok(base.gained > 0);
  assert.ok(doubled.gained > base.gained * 1.8, `${base.gained} -> ${doubled.gained}`);
  // selling depresses demand: later units are cheaper than the first
  assert.ok(base.gained < 5 * 14, "demand multiplier lowers the price of later units");
  assert.ok(base.h.registry.rule("Demand_Carrot") < 1);
  // and demand recovers overnight via DemandRecovery
  const d0 = base.h.registry.rule("Demand_Carrot");
  base.h.game.runCommand("skip-day");
  assert.ok(base.h.registry.rule("Demand_Carrot") > d0);
});

test("RULES: editing a price formula changes the price paid", async () => {
  const { gained, h } = await revenueFor({}, 5, ["Price_Carrot", "=BasePrice_Carrot * 3"]);
  assert.equal(h.registry.rule("Price_Carrot"), 42);
  assert.equal(gained, 5 * 42, "formula ignores demand, so every unit pays 42");
  // season bonus is a formula too: selling carrots in winter pays the off-season premium
  const w = await revenueFor({ "farm.season": "Winter" }, 1);
  const s = await revenueFor({}, 1);
  assert.equal(w.gained, Math.round(14 * 1.5));
  assert.equal(s.gained, 14);
});

test("RULES: invalid formulas are rejected and the game keeps running", async () => {
  const h = await makeHarness(2, CALM);
  const before = h.registry.rule("Price_Carrot");
  for (const bad of ["=BasePrice_Carrot *", "=Foo * 2", "=window.alert(1)", "=Price_Carrot + 1", "=" + "(".repeat(50) + "1" + ")".repeat(50)]) {
    const r = h.registry.setRuleFormula("Price_Carrot", bad);
    assert.equal(r.ok, false, `rejected: ${bad}`);
    assert.ok(r.error && r.error.length > 0);
    assert.equal(h.registry.rule("Price_Carrot"), before);
  }
  // runtime error (#DIV/0! in spring when SeasonNo-1 = 0) keeps the last good value
  assert.equal(h.registry.setRuleFormula("Price_Carrot", "=BasePrice_Carrot / (SeasonNo - 1)").ok, true);
  assert.equal(h.registry.rule("Price_Carrot"), before);
  assert.match(h.registry.snapshot().rules.find((r) => r.name === "Price_Carrot")!.error!, /DIV/);
  // invalid variable edits are rejected too
  assert.equal(h.registry.edit("market.base.carrot", "lots").ok, false);
  assert.equal(h.registry.edit("farm.season", "Monsoon").ok, false);
  h.step(120);
  h.registry.edit("farmer.basket.carrot", 2);
  assert.equal(sellAtStall(h), 2 * before, "sales still use the last good price");
});

async function daysToHarvest(speed: number): Promise<number> {
  const h = await makeHarness(4, { "farm.rainChance": 1, "farm.dayLength": 900, "farm.growthSpeed": speed });
  h.registry.edit("farm.weather", "Rain"); // waters every tilled plot right now
  approachFromBelow(h, 3, 8); // (3,8) starts tilled
  h.press("seed1");
  h.press("use");
  const p = plot(h, 3, 8);
  assert.equal(p.crop, "carrot");
  assert.equal(p.watered, true);
  let days = 0;
  while (!h.game.sim.isRipe(p) && days < 20) {
    h.game.runCommand("skip-day");
    days++;
    h.step(5);
  }
  return days;
}

test("FARM: growth speed multiplier changes days to harvest", async () => {
  assert.equal(await daysToHarvest(1), 3);
  assert.equal(await daysToHarvest(3), 1);
  assert.equal(await daysToHarvest(0.5), 6);
});

test("FARM/FARMER variables change gameplay", async () => {
  // walk speed: distance covered in one second
  const dist = async (speed: number) => {
    const h = await makeHarness(1, { ...CALM, "farmer.walkSpeed": speed });
    h.walkTo(4, 6);
    const x0 = h.game.sim.farmer.x;
    h.hold("right", 30);
    return h.game.sim.farmer.x - x0;
  };
  const slow = await dist(2), fast = await dist(6);
  assert.ok(fast > slow * 2.5, `${slow} vs ${fast}`);

  // day length: hours advanced in 10 s
  const hours = async (len: number) => {
    const h = await makeHarness(1, { "farm.dayLength": len });
    h.step(300);
    return h.game.sim.hour - 6;
  };
  assert.ok((await hours(60)) > (await hours(600)) * 5);

  // drought tolerance: unwatered crop withers after DroughtDays dry nights
  const h = await makeHarness(1, { ...CALM, "farm.droughtDays": 2 });
  approachFromBelow(h, 3, 8);
  h.press("seed1");
  h.press("use");
  h.game.runCommand("skip-day");
  assert.equal(plot(h, 3, 8).withered, false);
  h.game.runCommand("skip-day");
  assert.equal(plot(h, 3, 8).withered, true);

  // stamina: with ToolStamina above current stamina, tools refuse
  h.registry.edit("farmer.stamina", 1);
  h.registry.edit("farmer.toolStamina", 5);
  approachFromBelow(h, 5, 9);
  selectTool(h, "HOE");
  h.press("use");
  assert.equal(plot(h, 5, 9).tilled, false);
  assert.match(h.game.hud().banner ?? "", /TIRED/);

  // chickens: flock size follows the variable
  h.registry.edit("farm.chickens", 6);
  assert.equal(h.game.sim.chickens.length, 6);

  // season edit: out-of-season crops wither, planting refuses
  h.registry.edit("farmer.stamina", 100);
  h.registry.edit("farmer.toolStamina", 1);
  h.press("use");
  h.registry.edit("farm.season", "Winter");
  h.press("seed1");
  h.press("use");
  assert.equal(plot(h, 5, 9).crop, null);
  assert.match(h.game.hud().banner ?? "", /WINTER/);
});

test("ORDERS: delivering at the board completes an order and pays the reward; shed upgrades the can", async () => {
  const h = await makeHarness(6, CALM);
  const sheet = h.game.customSheets.find((s) => s.name === "ORDERS")!;
  const first = h.game.sim.orders[0];
  assert.equal(first.item, "carrot");
  h.registry.edit("farmer.basket.carrot", first.qty + 2);
  h.walkTo(7, 18);
  h.face("up");
  const cash0 = h.cash();
  h.press("use");
  assert.equal(first.status, "DONE");
  assert.equal(h.cash() - cash0, first.reward);
  assert.equal(h.registry.num("farmer.basket.carrot"), 2, "only what the order needed was taken");
  assert.equal(sheet.rows().filter((r) => r.cells[6] === "OPEN").length, 3, "a new order replaces the finished one");
  assert.equal(sheet.rows().find((r) => r.cells[0] === `#${first.id}`)!.style, "done");

  // an order that misses its due day is marked LATE
  const egg = h.game.sim.orders.find((o) => o.item === "egg" && o.status === "OPEN")!;
  while (h.game.sim.day <= egg.due) h.game.runCommand("skip-day");
  assert.equal(egg.status, "LATE");

  // shed upgrade: cost from the UpgradeCost_Can rule, capacity from UpgradeSize_Can
  h.registry.edit("farmer.cash", 500);
  const cost = h.registry.rule("UpgradeCost_Can");
  const size = h.registry.rule("UpgradeSize_Can");
  const cap0 = h.registry.num("farmer.canCapacity");
  h.walkTo(25, 4);
  h.face("up");
  h.press("use");
  assert.equal(h.registry.num("farmer.canLevel"), 2);
  assert.equal(h.registry.num("farmer.canCapacity"), cap0 + size);
  assert.equal(h.cash(), 500 - cost);
  assert.ok(h.registry.rule("UpgradeCost_Can") > cost, "next upgrade costs more");
});

test("passing out at 2am costs stamina and a doctor's fee", async () => {
  const h = await makeHarness(8, { "farm.dayLength": 20, "farm.rainChance": 0 });
  h.registry.edit("farmer.cash", 100);
  h.step(Math.ceil(21 / h.game.fixedStep));
  assert.equal(h.game.sim.day, 2);
  assert.equal(h.cash(), 90);
  assert.equal(h.registry.num("farmer.stamina"), 50);
});
