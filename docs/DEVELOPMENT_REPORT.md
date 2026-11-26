# Development report

## What was built

| Deliverable | Where | Status |
|---|---|---|
| Playable game (free roam + 3 missions) | `examples/gridlock-city` | Done. Headless gameplay suite 14/14 |
| Browser version (spreadsheet + 3D modes) | `dist/` (`npm run build`), published as a claude.ai artifact | Done. Browser evals 15/15 after fixes |
| Native spreadsheet integration | `renderers/excel/` (TS backend, Python `sgs_bridge`, VBA), `dist/GridlockCity.xlsx` | Verified against LibreOffice Calc via UNO. **Excel itself unverified.** |
| Reusable skill | `SKILL.md`, `references/`, `templates/`, `scripts/new-game.mjs` | Done; scaffolding tested (`examples/cell-catch`) |
| Second game | `examples/fieldbook` (2D farming/market sim) | Done; 20 tests |
| Automated tests | `npm test` (41), `npm run test:gameplay` (14), `npm run test:bridge` (90 Python + 9 TS) | All passing |
| Benchmarks | `evals/results/*.json`, `renderers/excel/bench/results.json` | Measured; environment recorded |
| Architecture docs | `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` | Done |
| Asset manifest | `assets/MANIFEST.json` | Done; no external assets |
| Screenshots | `evals/screenshots/` | 19 scenes |
| Demo video | `scripts/record-demo.mjs` → `dist/demo.mp4` (44 s, 24 fps) | Reproducible: the clock is advanced per video frame, so the video is smooth even on a slow renderer |

## Process

Agents with separate responsibilities worked in parallel against written contracts:

- I acted as architect, rendering engineer, gameplay engineer and simulation engineer.
- A spreadsheet-engineer agent built the native bridge.
- A generalisation agent built Fieldbook and `raster2d`.
- Two independent critic agents saw only the evidence: a visual critic (screenshots), and a technical critic covering code, claims and licensing.

Evaluation criteria (`evals/criteria.md`) were written before the game code.

## Measured results

### Spreadsheet pipeline (Node, synthetic frames, 2 vCPU Xeon 2.1 GHz)

| Cells | Quantise + diff + encode, p95 | Changed cells (adaptive + hysteresis) |
|---|---|---|
| 160×90 | 0.8 ms | 24% |
| 320×180 | 1.8 ms | 24% |
| 480×270 | 5.6 ms | 24% |

Hysteresis cut changed cells from 66% to 24% on noisy moving frames. Fixed-64 palettes change about 8% of cells but with 50× the colour error.

### Browser (headless Chrome on a CPU rasteriser, llvmpipe; no GPU)

Default preset (bloom and shadows) / low preset (no bloom, no shadows):

| Cells | Sheet FPS | p95 frame time | 3D render + readback | Spreadsheet side (quantise + diff + present) |
|---|---|---|---|---|
| 80×45 | 13.8 / 27.4 | 100 / 50 ms | 69 / 34 ms | 1.7 ms |
| 160×90 | 10.6 / 18.6 | 117 / 83 ms | 92 / 50 ms | 2.4 ms |
| 240×135 | 7.4 / 14.2 | 200 / 100 ms | 136 / 69 ms | 3.2 ms |
| 320×180 | 4.8 / 9.2 | 233 / 133 ms | 234 / 112 ms | 6.3 ms |
| 480×270 | 3.4 / 5.4 | 400 / 250 ms | 347 / 218 ms | 9.9 ms |

(Final run, after all fixes; the machine was also busy, so numbers are a little lower than an earlier run of 11 / 20 FPS at 160×90.)

- Software rendering of the 3D scene dominates frame time. The spreadsheet itself costs a few milliseconds.
- GPU performance was **not measured** (no GPU available here).
- The default is 160×90 based on these numbers.
- Differential updates give no measurable gain for the browser grid: the present step costs about 1-3 ms either way.

### Native bridge (LibreOffice Calc 24.2 headless, values + conditional-format strategy)

| Cells | Full frame | Differential, localised changes |
|---|---|---|
| 80×45 | 6.1 ms | 3.8 ms |
| 160×90 | 13.2 ms (66 FPS) | 5.9 ms (137 FPS) |
| 320×180 | 45.3 ms (19 FPS) | 19.5 ms (45 FPS) |
| 480×270 | 85.1 ms | 34.1 ms |

- The fallback strategy (setting each cell's colour directly) is 3-4× slower.
- Per-cell calls are about 100× slower.
- Diffs matter for out-of-process sinks.
- All numbers are headless; a visible window will be slower.
- Excel numbers are unverified.

### Gameplay

Measured vehicle handling (`tests/gridlock/gameplay.test.ts` G3):

| Vehicle | Top speed | 0-80 km/h |
|---|---|---|
| Sports | 187 km/h | 1.9 s |
| Police | 169 km/h | 2.3 s |
| Taxi | 144 km/h | 3.2 s |
| Sedan | 137 km/h | 3.5 s |
| Van | 108 km/h | 5.6 s |

Mission completion by a physics-driven scripted driver (`evals/results/missions-scripted.json`, 8 seeds, light traffic):

| Mission | Completed |
|---|---|
| Race | 5/8 (1st place in about 54 s) |
| Delivery | 1/8 |
| Escape | 0/8 |

The scripted driver is much weaker than a person. It gets stuck at intersections and crashes into kerb corners. Mission logic is verified separately with deterministic placement tests:
- objectives, rewards and cargo damage;
- fail and restart for all three missions;
- the real police search and star-decay path.

No human playtest was possible in this environment.

## Important failures found and fixed

1. **Quantiser stale palette slots.** The benchmark showed MSE jumping to 300 on palette rebuilds. Indices from a larger old palette were compared against stale RGB. Fixed by invalidating unused slots.
2. **Adaptive palette colour drift** (technical critic, critical). Cells whose index didn't change kept an old colour after a palette rebuild, so the drawn colour drifted up to 12 levels from the inspected value. Fixes:
   - the browser store now repaints every moved slot exactly;
   - the pipeline compares slots with the colour last emitted, bounding sink drift to a squared error ≤ 48 (unit test).
   
   The S1 eval had hidden this by forcing a keyframe. It now checks the steady state at 5 points per cell, and an instrumented `drawImage` proves the grid only ever draws the cell bitmap.
3. **Cars ignored red lights.** Stop-line waypoints were consumed within 4 m, before the stop point. Fixed by using a smaller pop radius for stop lines.
4. **Player autopilot overridden.** Input mapping overwrote scripted controls. Added an explicit `World.autopilot` hook.
5. **Re-plans dropped by the driver.** A* started from the nearest node behind the car, so every plan leg was discarded and the car turned at random. Added `RoadDriver.routeTo()`, which plans from the end of the current leg (police were affected too).
6. **Gridlock deadlocks.** Cars queued nose to nose forever. Added a timed back-off and creep, only when no red light is ahead (the first version made queued cars run reds).
7. **Wall friction framerate-dependent.** 15% per step stopped cars scraping along rails. Made it time-based and proportional to pressure.
8. **Police crimes from being rammed.** Police shunting a stopped player raised the alert to 5 stars. Only the player's own ramming counts now.
9. **Police spawned beside a hidden player.** Spawns now centre on the last sighting while searching.
10. **Mission markers on the road.** Driving down Neon Mile restarted the race. Markers moved onto pavements, and starting requires slowing below 8 m/s.
11. **Storm turned the city white.** Storm waves lifted the ocean sheet above the land. Found while chasing a visual-critic finding. Waves now fade near the shore and the sheet sinks under land.
12. **Rain splashes and headlight volumes washed out frames.** Replaced the cone mesh with a ground light pool. Splashes made smaller and kept away from the lens.
13. **Demo script ended in an arrest.** The first recording let the car sit still while the sheets were edited, so the police arrested the player mid-demo. The demo now pauses the simulation while sheets are edited and drives with the new *Autodrive* command (the same AI driver as traffic).
14. **Technical critic findings, all fixed:**
    - `Math.random` in collisions broke determinism.
    - Extra police units never peeled away.
    - Level-of-detail froze race rivals and engaged cops.
    - A new mission left the old one "ACTIVE".
    - Health edited to 0 did nothing.
    - Number parsing was too lenient (`"5abc"` → 5).
    - GAME-cell edits bypassed the store.
    - Formula semantics differed from Excel: `IF` is now lazy, `ROUND` rounds half away from zero, string-to-number conversion is strict, and NaN or Infinity raise `#NUM!`.
15. **Visual critic findings fixed:**
    - Headlight "domes".
    - Light pools that looked like stains.
    - Speedometer hidden by a UI pill.
    - Black shadows: more ambient fill.
    - Dark player car at night.
    - Overlapping header labels and truncated HUD cells.
    - Storm grade.
    - Washed-out low-resolution frames: added a mild cell grade.
16. **Originality** (technical critic):
    - Removed the `$00000000` cash counter, 5-star meter, WASTED/BUSTED/MISSION PASSED banners and the round bottom-left radar.
    - Replaced them with a heat bar, a top-left square map, and ARRESTED / HOSPITALISED / JOB DONE banners in a different type style.
    - Renamed "Comet GT" (an existing game car name) to "Coral GT", and "KMRB" (a real station call sign) to "Radio Meridian".

## Design decisions

See `docs/DECISIONS.md`:
- one simulation, many backends;
- arcade physics instead of Rapier;
- palette-indexed frames;
- hysteresis and run merging;
- ack-window backpressure;
- canvas virtual grid;
- a safe formula engine with Excel-compatible text.

## Known weaknesses (not fixed)

- **Art (visual critic scores 2-3/5 on several axes):**
  - Facades are flat atlas quads without geometric depth.
  - Characters are box rigs.
  - The sedan and taxi share a silhouette.
  - Day streets are sparse.
  
  Fieldbook's art scored far higher.
- **Scripted-driver completion rates are low** for delivery and escape, as listed above.
- **Driving AI** has no intersection reservation, so turning traffic can collide.
- **Performance on a GPU and native Excel are unmeasured.** `renderers/excel/native_test.py` is ready for a Windows machine.
- **The hosted artifact cannot use the native bridge.** Browsers block WebSockets to localhost from hosted pages, so use the local build.
- **Genres:** only third-person 3D driving/action and top-down 2D sim are built and tested. Other genres are supported by the contracts but have not been built.

## Google Sheets (added Nov 2026)

* **Sidebar edition** (real time, desktop): the game runs in an HtmlService sidebar and paints
  the GAME sheet in dirty rectangles. Tested against an in-memory Apps Script in headless Chrome
  (8/8 checks, including edit and formula sync); not timed on a real sheet.
* **Turn edition** (phones): the game runs inside Apps Script, one move per checkbox tap, with no
  authorisation for players. Installed and played in a real Google Sheet. Measured from the
  Executions log: setup about 15 s, taps 1.7 to 3.1 s.
* **What moved the numbers**: one cell per game pixel (no averaging), hidden gridlines, a dead zone
  camera and half hour lighting steps (a typical tap now repaints a few hundred of 14,400 cells
  instead of most of them), the save in CacheService. The remaining time is Apps Script start up
  and flush.
* **Bugs found only in the real sheet**: rule formulas showed #NAME? in Sheets because rules that
  reference other rules had no named ranges (the game's own values were right); phones in dark
  mode recolour cells; some phones draw ◀ ▶ as emoji. All fixed or documented, with tests.
* **Generic port**: `scripts/gsheets-port.mjs` builds either edition for any game; the template
  game (Cell Catch) ports with no game-specific glue (`tests/gsheets/port.test.ts`).
