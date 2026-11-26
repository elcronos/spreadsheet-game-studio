import type { RuleDef, VariableDef } from "../../../engines/core/variables";

export type VehicleKind = "sports" | "sedan" | "taxi" | "police" | "van";
export const VEHICLE_KINDS: VehicleKind[] = ["sports", "sedan", "taxi", "police", "van"];

export interface Handling {
  maxSpeed: number; // m/s
  accel: number; // m/s^2
  brake: number; // m/s^2
  steer: number; // max steer angle rad
  traction: number; // lateral grip 0..2
  health: number;
  mass: number; // kg
}

export const HANDLING: Record<VehicleKind, Handling & { label: string; prefix: string }> = {
  sports: { label: "Sports car (Coral GT)", prefix: "Sports", maxSpeed: 52, accel: 14, brake: 26, steer: 0.55, traction: 1.25, health: 700, mass: 1250 },
  sedan: { label: "Sedan (Bayline)", prefix: "Sedan", maxSpeed: 38, accel: 8.5, brake: 20, steer: 0.6, traction: 1.0, health: 900, mass: 1500 },
  taxi: { label: "Taxi (Gull Cab)", prefix: "Taxi", maxSpeed: 40, accel: 9, brake: 21, steer: 0.62, traction: 1.05, health: 950, mass: 1550 },
  police: { label: "Police cruiser (Interceptor)", prefix: "Police", maxSpeed: 47, accel: 12, brake: 25, steer: 0.58, traction: 1.15, health: 1300, mass: 1750 },
  van: { label: "Delivery van (Porter)", prefix: "Van", maxSpeed: 30, accel: 6, brake: 15, steer: 0.5, traction: 0.85, health: 1600, mass: 2600 },
};

const vehicleVars: VariableDef[] = [];
for (const k of VEHICLE_KINDS) {
  const h = HANDLING[k];
  const p = h.prefix;
  vehicleVars.push(
    { key: `veh.${k}.maxSpeed`, sheet: "VEHICLES", label: `${h.label}: max speed`, name: `${p}MaxSpeed`, type: "number", default: Math.round(h.maxSpeed * 3.6), min: 10, max: 400, unit: "km/h", description: "Top speed on flat road" },
    { key: `veh.${k}.accel`, sheet: "VEHICLES", label: `${h.label}: acceleration`, name: `${p}Accel`, type: "number", default: h.accel, min: 1, max: 60, unit: "m/s²", description: "Engine force divided by mass" },
    { key: `veh.${k}.brake`, sheet: "VEHICLES", label: `${h.label}: braking`, name: `${p}Brake`, type: "number", default: h.brake, min: 2, max: 80, unit: "m/s²", description: "Deceleration at full brake" },
    { key: `veh.${k}.steer`, sheet: "VEHICLES", label: `${h.label}: steering`, name: `${p}Steer`, type: "number", default: 1, min: 0.2, max: 3, unit: "×", description: "Steering sensitivity multiplier" },
    { key: `veh.${k}.traction`, sheet: "VEHICLES", label: `${h.label}: traction`, name: `${p}Traction`, type: "number", default: h.traction, min: 0.2, max: 3, unit: "×", description: "Lateral grip; lower drifts more" },
    { key: `veh.${k}.health`, sheet: "VEHICLES", label: `${h.label}: health`, name: `${p}Health`, type: "int", default: h.health, min: 50, max: 10000, unit: "hp", description: "Damage capacity for newly spawned vehicles" },
    { key: `veh.${k}.mass`, sheet: "VEHICLES", label: `${h.label}: mass`, name: `${p}Mass`, type: "int", default: h.mass, min: 300, max: 20000, unit: "kg", description: "Affects collisions and inertia" },
  );
}
vehicleVars.push({ key: "veh.current.health", sheet: "VEHICLES", label: "Current vehicle: health", name: "CurrentVehicleHealth", type: "number", default: 0, min: 0, max: 10000, unit: "hp", live: true, description: "Health of the vehicle you are driving (edit to repair)" });

export const VARIABLES: VariableDef[] = [
  { key: "player.health", sheet: "PLAYER", label: "Health", name: "Health", type: "number", default: 100, min: 0, max: 500, unit: "hp", live: true, description: "Reaches 0 → hospital" },
  { key: "player.cash", sheet: "PLAYER", label: "Cash", name: "Cash", type: "int", default: 250, min: 0, max: 99999999, unit: "$", live: true, description: "Earned from missions" },
  { key: "player.speed", sheet: "PLAYER", label: "Movement speed", name: "PlayerSpeed", type: "number", default: 1, min: 0.2, max: 4, unit: "×", description: "On-foot speed multiplier" },
  { key: "player.x", sheet: "PLAYER", label: "Position X (east)", name: "PosX", type: "number", default: 0, min: -400, max: 420, unit: "m", live: true, description: "Edit to teleport" },
  { key: "player.z", sheet: "PLAYER", label: "Position Z (south)", name: "PosZ", type: "number", default: 0, min: -400, max: 420, unit: "m", live: true, description: "Edit to teleport" },
  { key: "player.alert", sheet: "PLAYER", label: "Alert level", name: "AlertLevel", type: "number", default: 0, min: 0, max: 5, unit: "heat", live: true, description: "Police attention 0-5. Edit to start or end a pursuit" },
  { key: "player.stamina", sheet: "PLAYER", label: "Stamina", name: "Stamina", type: "number", default: 100, min: 0, max: 100, unit: "%", live: true, description: "Drains while sprinting" },
  { key: "player.inVehicle", sheet: "PLAYER", label: "Driving", type: "text", default: "on foot", live: true, readOnly: true, description: "Current vehicle" },
  { key: "player.invincible", sheet: "PLAYER", label: "Invincible", type: "bool", default: false, description: "TRUE ignores damage" },
  ...vehicleVars,
  { key: "world.population", sheet: "WORLD", label: "Traffic density (population)", name: "Population", type: "number", default: 1, min: 0, max: 3, unit: "×", description: "Feeds RULES!TrafficDensity" },
  { key: "world.rushHour", sheet: "WORLD", label: "Rush hour multiplier", name: "RushHourMultiplier", type: "number", default: 1, min: 0, max: 3, unit: "×", description: "Feeds RULES!TrafficDensity" },
  { key: "world.pedDensity", sheet: "WORLD", label: "Pedestrian density", name: "PedestrianDensity", type: "number", default: 1, min: 0, max: 3, unit: "×", description: "Pedestrians around the player" },
  { key: "world.gravity", sheet: "WORLD", label: "Gravity", name: "Gravity", type: "number", default: 9.81, min: 0.5, max: 40, unit: "m/s²", description: "Jumps, ramps and suspension" },
  { key: "world.time", sheet: "WORLD", label: "Time of day", name: "TimeOfDay", type: "number", default: 17.4, min: 0, max: 24, unit: "h", live: true, description: "0-24. Try 18.6 for sunset, 22 for neon" },
  { key: "world.timeScale", sheet: "WORLD", label: "Clock speed", name: "ClockSpeed", type: "number", default: 1, min: 0, max: 60, unit: "game min/s", description: "0 freezes time" },
  { key: "world.weather", sheet: "WORLD", label: "Weather", type: "enum", default: "Clear", options: ["Clear", "Cloudy", "Rain", "Storm", "Fog"], description: "Clear, Cloudy, Rain, Storm, Fog" },
  { key: "world.policeResponse", sheet: "WORLD", label: "Police response intensity", name: "PoliceResponse", type: "number", default: 1, min: 0, max: 4, unit: "×", description: "Feeds RULES!PoliceBudget and aggression" },
  { key: "world.baseBudget", sheet: "WORLD", label: "Police base budget", name: "BaseBudget", type: "number", default: 1.2, min: 0, max: 10, unit: "cars/★", description: "Feeds RULES!PoliceBudget" },
  { key: "world.baseReward", sheet: "WORLD", label: "Mission base reward", name: "BaseReward", type: "number", default: 500, min: 0, max: 100000, unit: "$", description: "Feeds RULES!MissionReward" },
  { key: "world.difficulty", sheet: "WORLD", label: "Difficulty multiplier", name: "DifficultyMultiplier", type: "number", default: 1, min: 0.5, max: 3, unit: "×", description: "Mission timers, rival pace and rewards" },
  { key: "world.spawn.sports", sheet: "WORLD", label: "Spawn weight: sports", name: "SpawnSports", type: "number", default: 1, min: 0, max: 10, description: "Relative traffic mix" },
  { key: "world.spawn.sedan", sheet: "WORLD", label: "Spawn weight: sedan", name: "SpawnSedan", type: "number", default: 4, min: 0, max: 10, description: "Relative traffic mix" },
  { key: "world.spawn.taxi", sheet: "WORLD", label: "Spawn weight: taxi", name: "SpawnTaxi", type: "number", default: 2, min: 0, max: 10, description: "Relative traffic mix" },
  { key: "world.spawn.van", sheet: "WORLD", label: "Spawn weight: van", name: "SpawnVan", type: "number", default: 1.5, min: 0, max: 10, description: "Relative traffic mix" },
  { key: "world.spawn.police", sheet: "WORLD", label: "Spawn weight: police patrol", name: "SpawnPolice", type: "number", default: 0.4, min: 0, max: 10, description: "Patrol cars in normal traffic" },
];

export const RULES: RuleDef[] = [
  { name: "TrafficDensity", formula: "=Population*RushHourMultiplier", min: 0, max: 4, description: "Traffic cars ≈ 26 × this value" },
  { name: "PoliceBudget", formula: "=ROUND(BaseBudget*AlertLevel*PoliceResponse, 0)", min: 0, max: 14, description: "Police cars allowed in a pursuit" },
  { name: "MissionReward", formula: "=BaseReward*DifficultyMultiplier", min: 0, max: 1000000, description: "Base payout; each mission scales it" },
  { name: "EscapeTime", formula: "=6+AlertLevel*2.5", min: 1, max: 120, description: "Seconds out of sight to lose one star" },
  { name: "PedestrianCount", formula: "=ROUND(34*PedestrianDensity, 0)", min: 0, max: 120, description: "Pedestrians kept around the player" },
  { name: "SearchRadius", formula: "=60+AlertLevel*25", min: 10, max: 400, description: "How far police search from the last sighting (m)" },
];
