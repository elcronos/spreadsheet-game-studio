/**
 * Frame differencing: which cells changed since the last presented frame.
 *
 * Runs on the same row separated by fewer than `mergeGap` unchanged cells are
 * merged, trading a few redundant cell writes for far fewer write calls  - 
 * the right trade for COM/UNO bridges where per-call overhead dominates.
 */
import type { DirtyRun, FrameDiff } from "../../engines/core/frame";

export function diffFrames(prev: Uint8Array | null, next: Uint8Array, w: number, h: number, mergeGap = 4, forceKey = false, slotDirty: Uint8Array | null = null): FrameDiff {
  if (!prev || prev.length !== next.length || forceKey) {
    const runs: DirtyRun[] = [];
    for (let y = 0; y < h; y++) runs.push({ row: y, x0: 0, length: w });
    return { keyframe: true, changedCells: w * h, runs, bounds: { x0: 0, y0: 0, x1: w, y1: h } };
  }
  const runs: DirtyRun[] = [];
  let changed = 0;
  let bx0 = w, by0 = h, bx1 = 0, by1 = 0;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let x = 0;
    let open: DirtyRun | null = null;
    let lastChange = -1e9;
    while (x < w) {
      const nv = next[base + x];
      if (prev[base + x] !== nv || (slotDirty !== null && slotDirty[nv] === 1)) {
        changed++;
        if (open && x - lastChange <= mergeGap) {
          open.length = x - open.x0 + 1;
        } else {
          open = { row: y, x0: x, length: 1 };
          runs.push(open);
        }
        lastChange = x;
        if (x < bx0) bx0 = x;
        if (x + 1 > bx1) bx1 = x + 1;
        if (y < by0) by0 = y;
        if (y + 1 > by1) by1 = y + 1;
      }
      x++;
    }
  }
  return { keyframe: false, changedCells: changed, runs, bounds: changed ? { x0: bx0, y0: by0, x1: bx1, y1: by1 } : null };
}

/** Number of cells that will actually be written for a diff (includes merged gaps). */
export function writtenCells(d: FrameDiff): number {
  let n = 0;
  for (const r of d.runs) n += r.length;
  return n;
}
