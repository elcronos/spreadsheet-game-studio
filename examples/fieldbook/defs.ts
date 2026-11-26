/**
 * Fieldbook data: crops, editable variables (FARMER / FARM / MARKET sheets),
 * RULES formulas, controls. Everything the spreadsheet can touch lives here.
 */
import type { RuleDef, VariableDef } from "../../engines/core/variables";
import type { KeyBinding } from "../../engines/core/input";
import type { TouchButton } from "../../engines/core/game";

export const SEASONS = ["Spring", "Summer", "Autumn", "Winter"] as const;
export type Season = (typeof SEASONS)[number];

export type CropId = "carrot" | "tomato" | "pumpkin" | "cabbage";
export const CROP_IDS: CropId[] = ["carrot", "tomato", "pumpkin", "cabbage"];

export interface CropDef {
  id: CropId;
  /** Display / formula name fragment, e.g. "Carrot" -> BasePrice_Carrot. */
  name: string;
  /** Watered days to ripen at GrowthSpeed 1. */
  days: number;
  /** Watered days to fruit again after harvest (0 = single harvest). */
  regrow: number;
  seasons: Season[];
  basePrice: number;
  seedCost: number;
  /** Seeds bought per crate interaction. */
  pack: number;
}

export const CROPS: Record<CropId, CropDef> = {
  carrot: { id: "carrot", name: "Carrot", days: 3, regrow: 0, seasons: ["Spring", "Summer", "Autumn"], basePrice: 14, seedCost: 4, pack: 5 },
  tomato: { id: "tomato", name: "Tomato", days: 5, regrow: 2, seasons: ["Summer"], basePrice: 20, seedCost: 9, pack: 3 },
  pumpkin: { id: "pumpkin", name: "Pumpkin", days: 7, regrow: 0, seasons: ["Autumn"], basePrice: 62, seedCost: 15, pack: 2 },
  cabbage: { id: "cabbage", name: "Cabbage", days: 4, regrow: 0, seasons: ["Winter", "Spring"], basePrice: 24, seedCost: 6, pack: 4 },
};

export type ItemId = CropId | "egg";

export const TOOLS = ["HOE", "CAN", "SEEDS"] as const;
export type Tool = (typeof TOOLS)[number];

/** In-game hours: the day starts at 06:00 and you pass out at 02:00 (26:00). */
export const DAY_START_HOUR = 6;
export const PASS_OUT_HOUR = 26;

export const VARIABLES: VariableDef[] = [
  // ---- FARMER ----------------------------------------------------------
  { key: "farmer.cash", sheet: "FARMER", label: "Cash", name: "Cash", type: "number", default: 40, min: 0, max: 999999, unit: "$", live: true, description: "Money in your pocket" },
  { key: "farmer.stamina", sheet: "FARMER", label: "Stamina", name: "Stamina", type: "number", default: 100, min: 0, max: 500, live: true, description: "Spent by every tool use; restored by sleep" },
  { key: "farmer.maxStamina", sheet: "FARMER", label: "Max stamina", name: "MaxStamina", type: "number", default: 100, min: 10, max: 500, description: "Stamina after a full night's sleep" },
  { key: "farmer.toolStamina", sheet: "FARMER", label: "Stamina per tool use", name: "ToolStamina", type: "number", default: 2, min: 0, max: 50, description: "Cost of one hoe / water / plant action" },
  { key: "farmer.walkSpeed", sheet: "FARMER", label: "Walk speed", name: "WalkSpeed", type: "number", default: 4.5, min: 0.5, max: 20, unit: "tiles/s", description: "How fast the farmer walks" },
  { key: "farmer.canCapacity", sheet: "FARMER", label: "Watering can capacity", name: "CanCapacity", type: "int", default: 8, min: 1, max: 200, unit: "uses", live: true, description: "Waterings per refill; upgrades at the shed add more" },
  { key: "farmer.canWater", sheet: "FARMER", label: "Water in can", name: "CanWater", type: "int", default: 8, min: 0, max: 200, live: true, description: "Refill at the well or pond" },
  { key: "farmer.canLevel", sheet: "FARMER", label: "Can upgrade level", name: "CanLevel", type: "int", default: 1, min: 1, max: 6, live: true, description: "Raised by buying upgrades at the shed" },
  { key: "farmer.seeds.carrot", sheet: "FARMER", label: "Carrot seeds", name: "Seeds_Carrot", type: "int", default: 10, min: 0, max: 999, live: true },
  { key: "farmer.seeds.tomato", sheet: "FARMER", label: "Tomato seeds", name: "Seeds_Tomato", type: "int", default: 0, min: 0, max: 999, live: true },
  { key: "farmer.seeds.pumpkin", sheet: "FARMER", label: "Pumpkin seeds", name: "Seeds_Pumpkin", type: "int", default: 0, min: 0, max: 999, live: true },
  { key: "farmer.seeds.cabbage", sheet: "FARMER", label: "Cabbage seeds", name: "Seeds_Cabbage", type: "int", default: 4, min: 0, max: 999, live: true },
  { key: "farmer.basket.carrot", sheet: "FARMER", label: "Carrots in basket", name: "Basket_Carrot", type: "int", default: 0, min: 0, max: 999, live: true },
  { key: "farmer.basket.tomato", sheet: "FARMER", label: "Tomatoes in basket", name: "Basket_Tomato", type: "int", default: 0, min: 0, max: 999, live: true },
  { key: "farmer.basket.pumpkin", sheet: "FARMER", label: "Pumpkins in basket", name: "Basket_Pumpkin", type: "int", default: 0, min: 0, max: 999, live: true },
  { key: "farmer.basket.cabbage", sheet: "FARMER", label: "Cabbages in basket", name: "Basket_Cabbage", type: "int", default: 0, min: 0, max: 999, live: true },
  { key: "farmer.basket.egg", sheet: "FARMER", label: "Eggs in basket", name: "Basket_Egg", type: "int", default: 0, min: 0, max: 999, live: true },

  // ---- FARM ------------------------------------------------------------
  { key: "farm.day", sheet: "FARM", label: "Day", name: "Day", type: "int", default: 1, min: 1, max: 9999, live: true, description: "Current day; order deadlines compare against it" },
  { key: "farm.hour", sheet: "FARM", label: "Time of day", name: "Hour", type: "number", default: 6, min: 6, max: 26, unit: "h", live: true, description: "06:00 to 26:00 (2am, you pass out)" },
  { key: "farm.season", sheet: "FARM", label: "Season", type: "enum", default: "Spring", options: [...SEASONS], live: true, description: "What can be planted; out-of-season crops wither" },
  { key: "farm.seasonNo", sheet: "FARM", label: "Season number", name: "SeasonNo", type: "int", default: 1, min: 1, max: 4, live: true, readOnly: true, description: "1 Spring, 2 Summer, 3 Autumn, 4 Winter (for formulas)" },
  { key: "farm.seasonLength", sheet: "FARM", label: "Season length", name: "SeasonLength", type: "int", default: 7, min: 1, max: 60, unit: "days" },
  { key: "farm.dayLength", sheet: "FARM", label: "Day length", name: "DayLength", type: "number", default: 150, min: 10, max: 3600, unit: "s", description: "Real seconds from 06:00 to 02:00" },
  { key: "farm.growthSpeed", sheet: "FARM", label: "Growth speed", name: "GrowthSpeed", type: "number", default: 1, min: 0.1, max: 10, unit: "x", description: "Growth days gained per watered night" },
  { key: "farm.rainChance", sheet: "FARM", label: "Rain chance", name: "RainChance", type: "number", default: 0.25, min: 0, max: 1, description: "Chance each morning of rain (rain waters every plot)" },
  { key: "farm.weather", sheet: "FARM", label: "Weather", type: "enum", default: "Sunny", options: ["Sunny", "Rain"], live: true, description: "Set to Rain to water every plot now" },
  { key: "farm.droughtDays", sheet: "FARM", label: "Drought tolerance", name: "DroughtDays", type: "int", default: 3, min: 1, max: 30, unit: "days", description: "Dry days before a crop withers" },
  { key: "farm.chickens", sheet: "FARM", label: "Chickens", name: "Chickens", type: "int", default: 3, min: 0, max: 10, description: "Flock size in the coop pen" },
  { key: "farm.eggChance", sheet: "FARM", label: "Egg chance", name: "EggChance", type: "number", default: 0.6, min: 0, max: 1, description: "Chance per chicken per morning of laying" },

  // ---- MARKET ----------------------------------------------------------
  ...(["carrot", "tomato", "pumpkin", "cabbage"] as CropId[]).flatMap((c): VariableDef[] => [
    { key: `market.base.${c}`, sheet: "MARKET", label: `${CROPS[c].name} base price`, name: `BasePrice_${CROPS[c].name}`, type: "number", default: CROPS[c].basePrice, min: 0, max: 10000, unit: "$" },
    { key: `market.seed.${c}`, sheet: "MARKET", label: `${CROPS[c].name} seed cost`, name: `SeedCost_${CROPS[c].name}`, type: "number", default: CROPS[c].seedCost, min: 0, max: 10000, unit: "$" },
  ]),
  { key: "market.base.egg", sheet: "MARKET", label: "Egg base price", name: "BasePrice_Egg", type: "number", default: 8, min: 0, max: 10000, unit: "$" },
  { key: "market.demandDrop", sheet: "MARKET", label: "Demand drop per sale", name: "DemandDrop", type: "number", default: 0.04, min: 0, max: 1, description: "How much each unit sold depresses that crop's demand" },
  { key: "market.demandRecovery", sheet: "MARKET", label: "Demand recovery", name: "DemandRecovery", type: "number", default: 0.4, min: 0, max: 1, unit: "/day", description: "Fraction of recent sales forgotten overnight" },
  { key: "market.offSeasonPremium", sheet: "MARKET", label: "Off-season premium", name: "OffSeasonPremium", type: "number", default: 1.5, min: 0, max: 10, unit: "x", description: "Price multiplier for produce sold out of its growing season" },
  ...(["carrot", "tomato", "pumpkin", "cabbage", "egg"] as ItemId[]).map(
    (c): VariableDef => ({ key: `market.sold.${c}`, sheet: "MARKET", label: `Recent ${c} sales`, name: `Sold_${c === "egg" ? "Egg" : CROPS[c].name}`, type: "number", default: 0, min: 0, max: 9999, live: true, description: "Decays by DemandRecovery each night" }),
  ),
];

const seasonBonus: Record<CropId, string> = {
  carrot: "=IF(SeasonNo=4, OffSeasonPremium, 1)",
  tomato: "=IF(SeasonNo=2, 1, OffSeasonPremium)",
  pumpkin: "=IF(SeasonNo=3, 1, OffSeasonPremium)",
  cabbage: "=IF(OR(SeasonNo=4, SeasonNo=1), 1, OffSeasonPremium)",
};

export const RULES: RuleDef[] = [
  ...CROP_IDS.flatMap((c): RuleDef[] => {
    const N = CROPS[c].name;
    return [
      { name: `Demand_${N}`, formula: `=MAX(0.3, 1 - Sold_${N} * DemandDrop)`, min: 0, max: 5, description: `${N} demand multiplier; falls as you sell, recovers overnight` },
      { name: `SeasonBonus_${N}`, formula: seasonBonus[c], min: 0, max: 10, description: `${N} price bonus when sold out of season` },
      { name: `Price_${N}`, formula: `=ROUND(BasePrice_${N} * Demand_${N} * SeasonBonus_${N}, 0)`, min: 0, max: 100000, description: `Sale price of one ${N.toLowerCase()} right now` },
    ];
  }),
  { name: "Demand_Egg", formula: "=MAX(0.3, 1 - Sold_Egg * DemandDrop)", min: 0, max: 5, description: "Egg demand multiplier" },
  { name: "Price_Egg", formula: "=ROUND(BasePrice_Egg * Demand_Egg * IF(SeasonNo=4, 1.25, 1), 0)", min: 0, max: 100000, description: "Sale price of one egg (eggs are dearer in winter)" },
  { name: "UpgradeCost_Can", formula: "=60 * CanLevel ^ 2", min: 0, max: 1000000, description: "Shed price of the next watering-can upgrade" },
  { name: "UpgradeSize_Can", formula: "=4 + 2 * CanLevel", min: 0, max: 100, description: "Capacity the next can upgrade adds" },
  { name: "SleepRestore", formula: "=MaxStamina * IF(Hour < 24, 1, 0.75)", min: 0, max: 500, description: "Stamina after sleeping (less if you went to bed after midnight)" },
];

export const KEY_BINDINGS: KeyBinding = {
  KeyW: "up", ArrowUp: "up", KeyS: "down", ArrowDown: "down",
  KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right",
  KeyE: "use", Space: "use", KeyQ: "tool", KeyR: "sleep",
  Digit1: "seed1", Digit2: "seed2", Digit3: "seed3", Digit4: "seed4",
};

export const TOUCH_BUTTONS: TouchButton[] = [
  { action: "up", label: "▲" },
  { action: "left", label: "◀" },
  { action: "down", label: "▼" },
  { action: "right", label: "▶" },
  { action: "use", label: "Use" },
  { action: "tool", label: "Tool" },
  { action: "seednext", label: "Seed" },
  { action: "sleep", label: "Sleep" },
];

export const CONTROLS: [string, string][] = [
  ["WASD / Arrows", "Walk"],
  ["E / Space", "Use tool / talk to stall, crate, shed, well"],
  ["Q", "Cycle tool (hoe, can, seeds)"],
  ["1-4", "Select carrot / tomato / pumpkin / cabbage seeds"],
  ["R", "Sleep (on the cottage doorstep)"],
];
