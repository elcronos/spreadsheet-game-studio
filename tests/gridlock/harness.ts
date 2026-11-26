import { VariableRegistry } from "../../engines/core/variables";
import { InputState } from "../../engines/core/input";
import { mulberry32 } from "../../engines/core/host";
import { VARIABLES, RULES } from "../../examples/gridlock-city/src/config";
import { World } from "../../examples/gridlock-city/src/sim/world";

export function makeWorld(seed = 7) {
  const reg = new VariableRegistry().define(VARIABLES).defineRules(RULES);
  const input = new InputState();
  const world = new World(reg, mulberry32(seed));
  const step = (secs: number, each?: (t: number) => void) => {
    const n = Math.round(secs * 60);
    for (let i = 0; i < n; i++) {
      each?.(i / 60);
      world.step(1 / 60, input);
      input.endFrame();
    }
  };
  const hold = (a: string, down = true) => input.apply({ type: "action", action: a, down });
  const press = (a: string) => { hold(a, true); world.step(1 / 60, input); input.endFrame(); hold(a, false); };
  return { reg, input, world, step, hold, press };
}

import { RoadDriver, nearestNode, legFrom } from "../../examples/gridlock-city/src/sim/nav";
import { nearestEdgePoint } from "../../examples/gridlock-city/src/city";
import type { Vehicle } from "../../examples/gridlock-city/src/sim/vehicle";

/** Autopilot for the player's car: routes over the road graph, then drives straight at the target. */
export function autopilot(world: import("../../examples/gridlock-city/src/sim/world").World, v: Vehicle, target: () => { x: number; z: number } | null, cruise = 18, plan?: import("../../examples/gridlock-city/src/sim/nav").Leg[]) {
  const near = nearestEdgePoint(world.city, v.x, v.z);
  const e = near.edge;
  const fwdA = (world.city.nodes[e.b].x - world.city.nodes[e.a].x) * v.fx + (world.city.nodes[e.b].z - world.city.nodes[e.a].z) * v.fz > 0;
  const leg = legFrom(world.city, e.id, fwdA ? e.a : e.b);
  const d = new RoadDriver(world.city, leg, { cruise, obeySignals: !plan, avoid: true, lane: 0, aggression: plan ? 0.7 : 0.2 }, world.rand);
  d.wps = d.wps.filter((w) => (w.x - v.x) * v.fx + (w.z - v.z) * v.fz > 2);
  let replan = plan ? 1e9 : 0;
  if (plan) {
    d.setPlan(plan);
  }
  const fn = (dt: number) => {
    const t = target();
    if (!t) { v.throttle = 0; return; }
    replan -= dt;
    if (replan <= 0) {
      d.routeTo(nearestNode(world.city, t.x, t.z));
      replan = 3;
    }
    const dist = Math.hypot(t.x - v.x, t.z - v.z);
    const direct = dist < (plan ? 12 : 20) && world.grid.raycast(v.x, v.z, t.x, t.z) >= 1;
    d.opts.cruise = direct ? Math.min(cruise, 3 + dist * 0.4) : cruise;
    d.drive(v, dt, world.t, world.obstaclesNear(v), direct ? t : null);
  };
  return Object.assign(fn, { driver: d });
}
