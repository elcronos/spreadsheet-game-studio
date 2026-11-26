---
name: spreadsheet-game-studio
description: Build playable games whose picture and controls live in spreadsheet cells (one cell per pixel), with editable simulation variables and formula-driven rules, for a browser grid, native Excel or LibreOffice via a local bridge, and Google Sheets. Use when asked to make a game in a spreadsheet, render 2D or 3D scenes into cells, or expose game state as editable worksheets.
---

# Spreadsheet Game Studio

One simulation, many presentations. A game implements `SpreadsheetGame`
(`engines/core/game.ts`). `StudioHost` steps it at a fixed rate, asks it for a cell
resolution RGBA frame, quantises and diffs that frame once (`renderers/framebuffer/`), and
sends palette-indexed dirty runs to every active backend. Variables and rules are declared
once and become worksheets everywhere.

```
game.step() ──► renderCells(w,h) ──► FramePipeline (quantise, diff) ──► backends
   ▲                                                                    ├─ conventional view (game canvas)
   └──── StatePatch / InputEvent ◄───────────────────────────────────── ├─ browser grid (renderers/sheet-canvas)
                                                                        ├─ native Excel / Calc (renderers/excel)
                                                                        └─ Google Sheets (renderers/gsheets, see the google-sheets-port skill)
```

Repo: <https://github.com/elcronos/spreadsheet-game-studio>. Work from its root.

## When to use

* "Make a game that runs in a spreadsheet / Excel / Google Sheets", "render this scene as
  cells", "let players tune the game from a worksheet".
* Adding a genre or a backend to the studio.
* Not for ordinary spreadsheet automation, and not for pasting a video or image into a
  workbook. That is not cell rendering and must not be presented as such.

## Genres: what is built and tested

| Genre | Status | Engine | Example |
|---|---|---|---|
| Third person 3D driving / open world | Built, tested | three.js scene, `renderCells` readback | `examples/gridlock-city` |
| Top down 2D sim / farming / management | Built, tested, also on Google Sheets | `engines/raster2d` (software, DOM-free) | `examples/fieldbook` |
| Minimal arcade (template) | Built, tested, also on Google Sheets | raster2d | `examples/cell-catch` |
| Racing | Partly (Gridlock City's race mission) | three.js | |
| Platformer, RPG, strategy, voxel, first person | Not built. The contracts allow them; no example or tests yet | | |

Never claim a genre works until it has an example under `examples/` with tests.

## Workflow

1. **Agree the target first.** Ask (or infer) where it will be played: browser, desktop
   Excel, Google Sheets on a computer, or phones. Phones mean the Google Sheets turn edition,
   which rules out WebGL and real time. This decides the engine, so settle it before coding.
2. **Start from the template.** Read `engines/core/game.ts`, `engines/core/variables.ts`,
   `engines/core/renderer.ts`, then `node scripts/new-game.mjs <id>` (copies
   `templates/minimal-game`, which already has `turn` support).
3. **Pick an engine** (`references/engines.md`):
   * 2D, pixel art, tile maps, must run headless or in Google Sheets: `engines/raster2d`.
     Draw at the cell resolution you will show (160x90 is a good default); never rely on
     downscaling, it muddies colours.
   * 3D: three.js into a small render target at 2x the cell size, box filtered down
     (`examples/gridlock-city/src/game.ts`). Keep the simulation in plain TS with no three.js
     imports so it tests headless.
4. **Declare variables and rules** (`references/spreadsheet-mechanics.md`). Every tunable is a
   `VariableDef` on a named sheet with min, max, unit and a formula name. Every rule is an
   Excel compatible formula over those names. Read `registry.num` / `registry.rule` each step
   so edits apply at once; call `registry.recomputeRules()` at a cadence when rules depend on
   values the game changes.
5. **Make it cheap to repaint.** Out of process sheets pay per changed cell. Keep the view
   still where you can (a dead zone camera), quantise slow global changes such as daylight,
   and keep palettes stable. This is what makes Excel, Calc and Google Sheets usable.
6. **Original assets only** (`references/assets-and-originality.md`): procedural textures,
   code built models, raster2d sprite strings, all listed in `assets/MANIFEST.json`. Inspired
   by a genre is fine; copying a franchise's names, map, logo, HUD or characters is not. When a
   critic says something looks like a known game, change it.
7. **Choose backends** (`references/rendering-pipeline.md`):
   * Browser grid: `SheetApp` in `renderers/sheet-canvas/shell.ts`.
   * Excel / Calc: `ExcelBridgeBackend` + `python -m sgs_bridge` (`references/excel-backend.md`),
     fixed 64 colour palette so conditional formats never change.
   * Google Sheets: `scripts/gsheets-port.mjs` (`references/google-sheets.md`, and the
     `google-sheets-port` skill for install and sharing).
8. **Wire the app**: add a hash route in `examples/app/main.ts`, `npm run build`,
   `npm run serve`.
9. **Test and evaluate** (`references/evaluation.md`): unit tests for rules and sim, headless
   gameplay with scripted players, `evals/browser-evals.mjs` for authenticity (cell store =
   pipeline frame = drawn pixels), editing and performance, `npm run test:gsheets` for the
   Google Sheets editions. Send captured screenshots to a critic agent with
   `evals/criteria.md`; do not accept "looks good" from the agent that built it.
10. **Measure, then report.** `npm run bench:pipeline`, `node evals/browser-evals.mjs`,
    `python3 scripts/excel/bench_sinks.py`, and the Apps Script Executions log for Google
    Sheets. Never quote a frame rate or tap time you did not measure, and say what produced it
    (GPU or CPU rasteriser, which spreadsheet app).
11. **Package**: `npm run build` gives `dist/index.html` + `dist/app.js`, a static site. Hosted
    pages cannot open WebSockets to localhost, so the Excel bridge needs the local build.

## Rules that keep it honest

* Every displayed game pixel is a cell with an address and a value. Inspection (name box,
  formula bar) reads the same store the grid draws from.
* In spreadsheet modes the WebGL canvas is hidden; `evals/browser-evals.mjs` S3 checks it.
* Invalid values and formulas are rejected with a message and put back; a runtime formula
  error keeps the last good value. An edit never crashes the simulation.
* Native Excel performance is unverified unless `renderers/excel/native_test.py` ran on Excel.
* Google Sheets tap times come from the Executions log of a real sheet, never from the fake.

## Lessons from building the examples

* Players notice colour first. Downscaled art, visible gridlines and phone dark mode all
  wash a picture out; fix the first two in code and tell players about the third.
* A follow camera and smooth lighting make every frame different; they are the main cost in
  any out of process sheet.
* Deterministic tests need a seeded RNG passed everywhere, including collision code.
* Scripted gameplay evals find bugs unit tests miss (cars running red lights, deadlocks,
  missions that can't be finished). Give every mission a success and a failure test.
* Visual critics catch resemblance to real franchises early; ask them about it explicitly.

## Files

* `engines/core/` contracts, host, variables, formula engine, input · `engines/raster2d/` 2D raster
* `renderers/framebuffer/` quantiser, diff, protocol · `renderers/sheet-canvas/` browser sheet ·
  `renderers/excel/` bridge, Python, VBA · `renderers/gsheets/` Google Sheets (sidebar + `turn/`)
* `scripts/` build, serve, benchmarks, workbook builder, `new-game.mjs`, `gsheets-port.mjs`
* `skills/google-sheets-port/` companion skill · `references/` guides (load only what you need) ·
  `evals/` criteria, browser evals, results · `tests/` unit, gameplay, bridge and Google Sheets tests
