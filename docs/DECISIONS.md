# Architecture decision records

## ADR-001 One simulation, many backends
Games implement `SpreadsheetGame` (`engines/core/game.ts`). `StudioHost`
steps the simulation at a fixed rate, asks the game for a conventional frame
and/or a cell-resolution RGBA frame, runs the shared `FramePipeline`
(quantise → diff) once, and fans the IndexedFrame out to every
`RenderBackend`. Three.js view, browser grid, Excel bridge and LibreOffice
bridge never contain game logic.

## ADR-002 Custom arcade vehicle physics instead of Rapier
The district is flat with box-shaped buildings. A bicycle-model car with
per-axle grip, handbrake slip and visual suspension gives better driving
feel per line of code than a rigid-body solver, is deterministic for
scripted evals, and avoids a 2 MB WASM download for the browser build.
Collisions use a uniform spatial hash over oriented boxes and circles.
Revisit if the genre needs stacking or ragdolls (Rapier is the candidate).

## ADR-003 Palette-indexed frames
Backends receive one byte per cell plus a ≤256-colour palette. A 15-bit LUT
makes quantisation O(1) per cell. Excel defaults to a fixed 64-colour palette
so conditional-format rules never change; the browser uses an adaptive
median-cut palette with slot-stable rebuilds.

## ADR-004 Temporal hysteresis and run merging
A cell keeps its previous index while the new colour is within a threshold,
cutting changed cells and flicker. Dirty runs within 4 cells merge, trading a
few redundant writes for fewer calls; the right trade when every call crosses
a process boundary (COM/UNO).

## ADR-005 Ack-window backpressure for out-of-process sinks
The game keeps at most one frame in flight per bridge. Frames produced while
the sink is busy are dropped and counted; the simulation never waits.

## ADR-006 Canvas virtual grid for the browser spreadsheet
Up to 172,800 game cells cannot be DOM elements. The grid keeps a cell store
(Uint8Array of palette indices addressed A4…) and draws visible cells from it.
Selection, formula bar and inspection read the same store, so what the user
inspects is exactly what is drawn.

## ADR-007 Formula engine
A hand-written Excel-subset parser (`engines/core/formula.ts`) with a function
whitelist, length and depth limits, no host access, and errors surfaced as
`#DIV/0!`/`#REF!`. Names map to variables and rules, so the same formula
text is valid in an Excel workbook that defines the same names.
