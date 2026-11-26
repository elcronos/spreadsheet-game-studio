/**
 * The renderer backend contract. Every presentation target (conventional 3D,
 * browser spreadsheet grid, native Excel via bridge, LibreOffice via UNO,
 * a headless recorder…) implements RenderBackend. Games never talk to a
 * backend directly; the Studio host owns the pipeline and fans frames out.
 *
 * The interface is genre-agnostic: it knows about cells, palettes, input
 * actions and named state, never about cars or police.
 */
import type { FrameDiff, IndexedFrame } from "./frame";
import type { StateSnapshot, StatePatch } from "./variables";
import type { InputEvent } from "./input";

export interface BackendCapabilities {
  /** Backend wants IndexedFrames (spreadsheet-like targets). */
  cellFrames: boolean;
  /** Backend can present the GPU canvas directly (conventional 3D). */
  directCanvas: boolean;
  /** Maximum cells per frame the backend has been measured to sustain at >=10 FPS (0 = unknown). */
  measuredCellBudget: number;
  /** Backend can produce input events (keyboard capture, touch, OnKey macros…). */
  input: boolean;
  /** Backend can edit simulation state (spreadsheet cells -> variables). */
  stateEdit: boolean;
}

export interface BackendInit {
  width: number;
  height: number;
  /** Emit input from the backend (e.g. Excel OnKey, touch controls). */
  emitInput: (e: InputEvent) => void;
  /** Emit a state edit from the backend (e.g. user typed into PLAYER!B2). */
  emitState: (patch: StatePatch) => void;
}

export interface BackendStats {
  /** Frames actually presented in the last second. */
  presentedFps: number;
  /** Frames dropped because the backend was still busy (backpressure). */
  droppedFrames: number;
  /** Mean time to present one frame, ms (wall time incl. transport). */
  presentMs: number;
  /** Bytes sent for the last frame, when a transport is involved. */
  lastFrameBytes: number;
  /** Cells written for the last frame. */
  lastChangedCells: number;
  connected: boolean;
}

export interface RenderBackend {
  readonly id: string;
  readonly label: string;
  readonly capabilities: BackendCapabilities;
  init(init: BackendInit): Promise<void>;
  /** Resolution change. Next frame submitted will be a keyframe. */
  resize(width: number, height: number): void;
  /**
   * Offer a frame. Must not block. Return false if the backend is busy and
   * the frame was dropped (the host counts it and keeps simulating).
   */
  submitFrame(frame: IndexedFrame, diff: FrameDiff): boolean;
  /** Push simulation state for display (PLAYER/WORLD/... sheets). */
  syncState(snapshot: StateSnapshot): void;
  stats(): BackendStats;
  shutdown(): Promise<void>;
}

export function emptyStats(): BackendStats {
  return { presentedFps: 0, droppedFrames: 0, presentMs: 0, lastFrameBytes: 0, lastChangedCells: 0, connected: true };
}

/** Rolling FPS counter used by backends and the host. */
export class RateCounter {
  private stamps: number[] = [];
  tick(now = performance.now()): void {
    this.stamps.push(now);
    const cut = now - 1000;
    while (this.stamps.length && this.stamps[0] < cut) this.stamps.shift();
  }
  get rate(): number {
    return this.stamps.length;
  }
}

/** Exponential moving average helper for ms timings. */
export class Ema {
  value = 0;
  private init = false;
  constructor(private alpha = 0.1) {}
  push(v: number): number {
    if (!this.init) {
      this.value = v;
      this.init = true;
    } else this.value += (v - this.value) * this.alpha;
    return this.value;
  }
}
