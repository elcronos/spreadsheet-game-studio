# Choosing an engine

A game only has to fill `renderCells(width, height, out)` with top-down RGBA,
one texel per spreadsheet cell, and step its simulation in `step(dt)`.
How it draws is its own business. Two engines ship with the studio.

## raster2d (2D, DOM-free) - `engines/raster2d/`

Use for pixel art, tile maps, top-down or side-on games, UI-heavy sims, and
anything that must run headless in Node tests.

- Draw at a fixed logical size (160×90 works well: it is the default GAME
  range and scales by exact integers to 320×180 and 480×270).
- `present(surface, w, h, out)` scales to any cell resolution: exact integer
  nearest-neighbour when possible, fractional nearest-neighbour otherwise,
  2×2 averaging below 1×, and letterboxing for other aspect ratios.
- Sprites are arrays of strings with a char→colour map (`sprite.ts`), so art
  lives in code, is diffable and is original by construction.
- `CanvasPresenter` shows the same surface on a canvas for the conventional view.
- Example: `examples/fieldbook` (top-down farming, 7 sprites sheets, lighting, weather).

## three.js (3D) - `examples/gridlock-city/src/`

Use for third-person, driving, first-person, voxel and anything with a camera
in a 3D world.

- Keep the simulation in plain TypeScript (`src/sim/*`) with no three.js
  imports. Rendering code (`src/render/*`) reads sim state each frame. This is
  what makes headless gameplay tests possible.
- `renderCells` renders the same scene with the same camera into a
  `WebGLRenderTarget` at `cellSupersample` × the cell size (default 2), reads
  it back, box-filters down and flips to top-down. The camera aspect is set to
  the cell aspect for that render.
- Post effects (bloom) can run on the cell render too, through an
  `EffectComposer` that renders to a target (`renderToScreen = false`) and is
  read from `composer.readBuffer`.
- `readRenderTargetPixels` stalls the GPU pipeline. Its cost dominates frame
  time at high cell counts on software rasterisers; measure it (TELEMETRY
  "Cell render + GPU readback").
- Low-poly geometry built from code (`render/geo.ts`, `render/models.ts`) and
  canvas-painted textures (`render/textures.ts`) keep assets original and the
  download small (the whole browser build is ~0.8 MB minified).

## Physics

Gridlock City uses a custom arcade model (`sim/vehicle.ts`, ADR-002 in
`docs/DECISIONS.md`): bicycle-model yaw, lateral slip for drifts, ramps with
gravity from the WORLD sheet, circle-set collisions against a static AABB
grid, mass-weighted impulses between vehicles. Consider Rapier only when a
genre needs stacking, joints or ragdolls.

## Picking resolution

Cell count drives cost in every backend. Start at 160×90 (14,400 cells). Use
`RESOLUTION_PRESETS` and let players switch; `StudioHost` can adapt
resolution to a frame budget (`adaptiveResolution`).
