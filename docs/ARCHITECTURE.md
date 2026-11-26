# System architecture

```
                         ┌───────────────────────────────────────────────┐
                         │                 StudioHost                    │
 keyboard/touch/OnKey ──►│ InputState ─► game.step(1/60) × n (fixed)     │
 sheet edits / bridge ──►│ VariableRegistry (variables + rules) ◄──────┐ │
                         │        │                                     │ │
                         │        ▼                                     │ │
                         │ game.renderDirect()   game.renderCells(w,h)  │ │
                         │   (3D view visible)        │ RGBA            │ │
                         │                            ▼                 │ │
                         │                FramePipeline                 │ │
                         │      Quantizer (LUT, palette, hysteresis)    │ │
                         │      diffFrames (runs, bounds, slot moves)   │ │
                         │                            │                 │ │
                         └────────────────────────────┼─────────────────┼─┘
             IndexedFrame + FrameDiff ┌───────────────┼──────────┐      │ StatePatch
                                      ▼               ▼          ▼      │
                          SheetCanvasBackend   ExcelBridgeBackend  (any RenderBackend)
                          CellStore + GridView   SGF1 / WebSocket ──► python -m sgs_bridge
                          (browser worksheet)                          ├─ Excel (COM / xlwings)
                                                                       ├─ LibreOffice Calc (UNO)
                                                                       ├─ mock / snapshot .xlsx
```

## Layers

| Layer | Path | Depends on |
|---|---|---|
| Contracts & host | `engines/core/` | nothing (no DOM in contracts; host uses rAF when started) |
| 2D engine | `engines/raster2d/` | nothing (DOM optional for presentation) |
| Pixel pipeline | `renderers/framebuffer/` | core types |
| Browser spreadsheet | `renderers/sheet-canvas/` | core, framebuffer, excel backend (optional connect) |
| Native bridge | `renderers/excel/` (TS backend + Python package) | core, framebuffer protocol |
| Gridlock City sim | `examples/gridlock-city/src/sim/`, `city.ts`, `config.ts` | core only (headless-testable) |
| Gridlock City presentation | `examples/gridlock-city/src/render/`, `game.ts` | three.js, sim |
| Fieldbook | `examples/fieldbook/` | core, raster2d |
| App | `examples/app/main.ts`, `web/index.html` | everything above |

## Gridlock City simulation

- `city.ts` - hand-designed district: 5 avenues × 5 streets plus a coastal
  loop (25 signalised intersections, 41 road edges), 23 blocks typed by
  district (Ocean Drive deco hotels, Neon Mile clubs, downtown towers,
  Palmetto Row homes, Dockside, Bayfront Park, BayGas lot, marina), alleys,
  parking lots, pier, beach, sidewalk loops and crosswalks for pedestrians,
  POIs and landmarks.
- `sim/world.ts` - entities, spawning/despawning around the player with
  distance LOD (full rate < 110 m, 1/3 rate < 170 m, frozen beyond), spatial
  hashes for vehicles and people, impacts, explosions, busted/wasted, live
  variable sync, spreadsheet edit side-effects (teleport, repair).
- `sim/vehicle.ts` - arcade dynamics, ramps, damage + dents.
- `sim/nav.ts` - signals (24 s cycle with offsets), lane waypoints, turns,
  A*, the shared `RoadDriver` (red lights, following distance, overtaking for
  aggressive drivers, stuck recovery, deadlock breaking).
- `sim/peds.ts` - pavement loops, signalled crossings, flee/dive reactions,
  knock-downs.
- `sim/police.ts` - alert, witnesses, budget from RULES, roles
  (chase / intercept / flank / search), sight range by time and weather,
  search around the last sighting, star decay, busted.
- `sim/missions.ts` - delivery, race (three AI rivals on the same racing
  line), escape; free-roam markers; MISSIONS sheet rows.

## Determinism

`StudioHost` seeds a mulberry32 RNG passed to the game; fixed 60 Hz steps;
headless tests drive `World.step` directly. Every random decision in the
simulation (spawns, AI choices, collision spin) uses that RNG; only particles,
camera shake and rain (presentation) use `Math.random`. The independent
technical critic found a `Math.random` call in vehicle collisions that broke
replay determinism; it now takes the world RNG.
