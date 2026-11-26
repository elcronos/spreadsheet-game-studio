/**
 * Quayside variables and formula rules: each becomes an editable cell on its worksheet
 * (PLAYER, VEHICLES, FERRY, POLICE, WORLD) and the game reads them every step.
 */
import type { RuleDef, VariableDef } from "../../../engines/core/variables";
import { HANDLING, VEHICLE_KINDS } from "../../gridlock-city/src/config";

const vehicleVars: VariableDef[] = [];
const LABEL: Record<string, string> = { sports: "Sports car", sedan: "Sedan", taxi: "Taxi", police: "Police car", van: "Van" };
for (const k of VEHICLE_KINDS) {
  const h = HANDLING[k], p = h.prefix;
  vehicleVars.push(
    { key: `veh.${k}.maxSpeed`, sheet: "VEHICLES", label: `${LABEL[k]}: max speed`, name: `${p}MaxSpeed`, type: "number", default: Math.round(h.maxSpeed * 3.6), min: 10, max: 400, unit: "km/h" },
    { key: `veh.${k}.accel`, sheet: "VEHICLES", label: `${LABEL[k]}: acceleration`, name: `${p}Accel`, type: "number", default: h.accel, min: 1, max: 60, unit: "m/s²" },
    { key: `veh.${k}.brake`, sheet: "VEHICLES", label: `${LABEL[k]}: braking`, name: `${p}Brake`, type: "number", default: h.brake, min: 2, max: 80, unit: "m/s²" },
    { key: `veh.${k}.steer`, sheet: "VEHICLES", label: `${LABEL[k]}: steering`, name: `${p}Steer`, type: "number", default: 1, min: 0.2, max: 3, unit: "×" },
    { key: `veh.${k}.traction`, sheet: "VEHICLES", label: `${LABEL[k]}: traction`, name: `${p}Traction`, type: "number", default: h.traction, min: 0.2, max: 3, unit: "×" },
    { key: `veh.${k}.health`, sheet: "VEHICLES", label: `${LABEL[k]}: health`, name: `${p}Health`, type: "int", default: h.health, min: 50, max: 10000, unit: "hp" },
    { key: `veh.${k}.mass`, sheet: "VEHICLES", label: `${LABEL[k]}: mass`, name: `${p}Mass`, type: "int", default: h.mass, min: 300, max: 20000, unit: "kg" },
  );
}

export const VARIABLES: VariableDef[] = [
  { key: "player.cash", sheet: "PLAYER", label: "Cash", name: "Cash", type: "int", default: 300, min: 0, max: 99999999, unit: "$", live: true },
  { key: "player.health", sheet: "PLAYER", label: "Health", name: "Health", type: "number", default: 100, min: 0, max: 500, unit: "hp", live: true, description: "Reaches 0: you wake up at the hospital" },
  { key: "player.heat", sheet: "PLAYER", label: "Heat", name: "Heat", type: "number", default: 0, min: 0, max: 5, unit: "level", live: true, description: "Police attention. Edit to start or end a chase" },
  { key: "player.speed", sheet: "PLAYER", label: "Running speed", name: "RunSpeed", type: "number", default: 1, min: 0.2, max: 4, unit: "×" },
  { key: "player.where", sheet: "PLAYER", label: "Where you are", type: "text", default: "Elizabeth Quay", live: true, readOnly: true },
  { key: "player.mode", sheet: "PLAYER", label: "Doing", type: "text", default: "on foot", live: true, readOnly: true },
  { key: "player.invincible", sheet: "PLAYER", label: "Invincible", type: "bool", default: false },
  ...vehicleVars,
  { key: "ferry.speed", sheet: "FERRY", label: "Cruising speed", name: "FerrySpeed", type: "number", default: 20, min: 2, max: 40, unit: "knots", description: "The real crossing takes about 8 to 10 minutes; the game runs faster" },
  { key: "ferry.dwell", sheet: "FERRY", label: "Time at the jetty", name: "FerryDwell", type: "number", default: 25, min: 5, max: 300, unit: "s" },
  { key: "ferry.fare", sheet: "FERRY", label: "Fare", name: "FerryFare", type: "number", default: 3.4, min: 0, max: 100, unit: "$" },
  { key: "ferry.helmSpeed", sheet: "FERRY", label: "Top speed when you steal it", name: "StolenFerrySpeed", type: "number", default: 22, min: 4, max: 60, unit: "knots" },
  { key: "police.response", sheet: "POLICE", label: "Response intensity", name: "PoliceResponse", type: "number", default: 1, min: 0, max: 5, unit: "×" },
  { key: "police.boatSpeed", sheet: "POLICE", label: "Police boat speed", name: "PoliceBoatSpeed", type: "number", default: 26, min: 4, max: 70, unit: "knots" },
  { key: "police.carSpeedMul", sheet: "POLICE", label: "Police car speed", name: "PoliceCarSpeed", type: "number", default: 1, min: 0.2, max: 3, unit: "×" },
  { key: "police.coolDown", sheet: "POLICE", label: "Seconds out of sight to lose a level", name: "CoolDown", type: "number", default: 18, min: 1, max: 120, unit: "s" },
  { key: "world.time", sheet: "WORLD", label: "Time of day", name: "TimeOfDay", type: "number", default: 17.4, min: 0, max: 24, unit: "h", live: true },
  { key: "world.timeScale", sheet: "WORLD", label: "Clock speed", name: "ClockSpeed", type: "number", default: 1, min: 0, max: 120, unit: "min per s", description: "Game minutes per real second" },
  { key: "world.traffic", sheet: "WORLD", label: "Traffic density", name: "TrafficDensity", type: "number", default: 1, min: 0, max: 4, unit: "×" },
  { key: "world.people", sheet: "WORLD", label: "People on the promenade", name: "PeopleDensity", type: "number", default: 1, min: 0, max: 4, unit: "×" },
  { key: "world.reward", sheet: "WORLD", label: "Heist base reward", name: "BaseReward", type: "number", default: 2500, min: 0, max: 1000000, unit: "$" },
];

export const RULES: RuleDef[] = [
  { name: "PoliceBoats", formula: "=MIN(4, ROUND(Heat*PoliceResponse*0.8, 0))", min: 0, max: 8, description: "River police boats chasing a stolen boat" },
  { name: "PoliceCars", formula: "=MIN(6, ROUND(Heat*PoliceResponse, 0))", min: 0, max: 12, description: "Police cars chasing you on land" },
  { name: "TrafficCars", formula: "=ROUND(26*TrafficDensity, 0)", min: 0, max: 120, description: "Cars driving the real streets" },
  { name: "People", formula: "=ROUND(30*PeopleDensity, 0)", min: 0, max: 150, description: "People walking around the quay" },
  { name: "HeistReward", formula: "=ROUND(BaseReward*(1+Heat*0.25), -1)", min: 0, max: 10000000, description: "Paid when you dock the stolen ferry at Mends Street" },
];

export const KEYS = {
  KeyW: "up", ArrowUp: "up", KeyS: "down", ArrowDown: "down", KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right",
  ShiftLeft: "sprint", ShiftRight: "sprint", Space: "handbrake", KeyF: "enter", Enter: "enter", KeyG: "hijack", KeyH: "horn",
  KeyQ: "camLeft", KeyE: "camRight", KeyC: "lookback", KeyR: "restart",
};
