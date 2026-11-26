# Evaluation criteria (written before implementation)

Each criterion has an automated check where possible (`evals/*.mjs`, `tests/*`),
and evidence is written to `evals/results/`. A criterion passes only on
evidence, never on an agent's claim.

## G - Gameplay (automated Playwright scripts drive real input)

| ID | Criterion | Evidence |
|---|---|---|
| G1 | Player walks, runs, sprints; stamina drains while sprinting | position/speed/stamina samples |
| G2 | Player enters and exits a vehicle with F | `player.inVehicle` toggles, vehicle id |
| G3 | Each of 5 vehicle types has distinct measured top speed / 0-60 / turn radius | handling table from scripted test track |
| G4 | Ramming traffic / pedestrians raises alert; police spawn and pursue (distance to player shrinks) | alert level + police count time series |
| G5 | Breaking line of sight leads to search, then alert decays to 0 (escape) | alert time series with `search` state |
| G6 | Mission 1 (delivery), 2 (race), 3 (escape) each completable end to end by scripted driver | mission status `complete`, reward credited |
| G7 | Each mission can fail (timer / destroyed / busted) and restart | status `failed` then `active` after restart |
| G8 | Traffic stops at red lights; pedestrians use pavements and react to cars | counts of stopped-at-red, flee events |

## S - Spreadsheet authenticity

| ID | Criterion | Evidence |
|---|---|---|
| S1 | Browser GAME sheet: cell (x,y) value equals quantised framebuffer pixel (x,y) for 1000 random samples | exact-match rate = 100% |
| S2 | Selecting a game cell shows its address and colour in the formula bar | screenshot + DOM text |
| S3 | No `<img>`/`<video>`/WebGL canvas is visible in spreadsheet mode; the grid canvas is drawn from the cell store | DOM audit |
| S4 | Editing PLAYER/VEHICLES/WORLD cells changes the simulation (e.g. max speed edit changes measured top speed) | before/after measurement |
| S5 | Editing a RULES formula changes behaviour (e.g. PoliceBudget formula changes police count) | before/after counts |
| S6 | Invalid values and unsafe formulas are rejected with a message and do not crash | error text, sim still running |
| S7 | Native bridge writes the expected cell values/fills (mock sink + LibreOffice Calc via UNO); native Excel marked unverified unless run on Excel | cell readback match |

## V - Visual (screenshots reviewed by an independent critic agent)

Scenes: day exploration, night exploration, beachfront driving, police pursuit,
collision, character on foot, spreadsheet at 80x45/160x90/320x180/480x270.
Rubric 1-5: art direction, coherence, density, lighting, texture, animation,
readability at cell resolution, originality, artefacts. Pass = no score < 3
and a mean ≥ 3.5, with every finding specific (location + fix).

## P - Performance (measured, never assumed)

Per renderer and resolution: median FPS, p95 frame time, simulation Hz,
dropped frames, changed vs written cells, bytes per frame, CPU/heap where
measurable. Compare full-frame vs differential updates. Defaults are chosen
from these numbers. Environment (headless SwiftShader vs GPU) is recorded
next to every number.

## L - Licensing / originality

Every asset listed in `assets/MANIFEST.json` with origin and licence; no
third-party game assets; names, map and missions original.
