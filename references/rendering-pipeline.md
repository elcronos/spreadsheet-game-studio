# Rendering pipeline and backends

```
renderCells(w,h) → RGBA (w×h×4, top-down)
  → Quantizer   15-bit LUT (lazy), fixed 64/256 or adaptive median-cut palette,
                slot-stable rebuilds, temporal hysteresis, optional Bayer dither
  → diffFrames  changed cells → row runs (merge gap 4) + dirty bounds;
                cells whose palette slot moved are included
  → backends    submitFrame(frame, diff) → false = dropped (backpressure)
```

## Measured (see `evals/results/`)

- Node, synthetic frames: quantise + diff + encode < 2 ms p95 at 320×180;
  ~6 ms p95 at 640×360 (`npm run bench:pipeline`).
- Adaptive palette (192) with hysteresis: MSE ≈ 11 vs ≈ 550 for fixed64, and
  hysteresis cuts changed cells from ~66% to ~24% on noisy moving frames.
- Lazy LUT: in-browser quantise time fell from 3.1 ms to 0.4 ms per frame at
  160×90 (the eager LUT rebuilt 32,768 entries on every palette rebuild).
- Browser grid present (cell store update + canvas blit): ≈ 1 ms at 160×90,
  ≈ 2-3 ms at 480×270, whether the frame is differential or full - the
  browser grid gains nothing from diffs. Diffs matter for out-of-process sinks:
  LibreOffice Calc applies a localised 160×90 diff in 5.9 ms vs 13.2 ms for a
  full frame (headless, no repaint).
- In the browser the dominant cost is the 3D scene render + readback for the
  cell frame (TELEMETRY "Cell render + GPU readback" includes both), not the
  spreadsheet. On the CPU-rasterised test machine that was 47 ms at 160×90.
- Adaptive palettes: a slot is re-emitted when it has moved more than √12 from
  the colour its cells were last written with, which bounds any sink's drift to
  a squared RGB error ≤ 48 (unit-tested). The browser store repaints exactly.

## Backend contract (`engines/core/renderer.ts`)

`init`, `resize`, `submitFrame` (non-blocking), `syncState`, `stats`,
`shutdown`, plus capabilities. Out-of-process backends keep at most one frame
in flight and drop the rest (ADR-005); the simulation never waits.

## Browser grid (`renderers/sheet-canvas`)

- `CellStore`: `indices` (one byte per cell), palette, and a 1-pixel-per-cell
  bitmap of fills updated from dirty runs (`putImageData` on dirty bounds).
- `GridView`: canvas virtual grid. Draws only visible cells; the GAME range is
  drawn by scaling the cell bitmap with smoothing off (or `fillRect` per run of
  equal cells, `drawMode: "rects"`). Gridlines are drawn per cell boundary when
  cells are ≥ 3 px. Selection, name box, formula bar and status bar read the
  same store.
- Modes: 3D (game canvas, cell production stops), Sheet, Gridlines, Sim editor.

## Native (`renderers/excel`)

SGF1 over WebSocket to `python -m sgs_bridge`; sinks for Excel (COM, xlwings),
LibreOffice Calc (UNO), mock and snapshot. Strategy `values-cf` writes palette
indices with bulk array assignment over row bands and lets per-index
conditional formats paint the fills. Calc numbers are measured; Excel numbers
are not (`references/excel-backend.md`).
