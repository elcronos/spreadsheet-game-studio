/**
 * ExcelBridgeBackend: RenderBackend that streams SGF1 frames over WebSocket to
 * the native spreadsheet bridge (renderers/excel/bridge, `python -m sgs_bridge`),
 * which writes them into real worksheet cells (Excel via COM/xlwings,
 * LibreOffice Calc via UNO) and sends user edits and key presses back.
 *
 * Contract: references/protocol.md. Works in browsers (global WebSocket) and in
 * Node (pass `WebSocket` from the `ws` package, or Node 22's global).
 *
 * Correctness under backpressure: the backend keeps a shadow copy of the last
 * frame it actually sent. When frames were dropped (ack window full) or the
 * connection was re-established, it re-diffs the current frame against that
 * shadow (or sends a keyframe), so the bridge never misses changes.
 */
import type { BackendCapabilities, BackendInit, BackendStats, RenderBackend } from "../../engines/core/renderer";
import { Ema, RateCounter } from "../../engines/core/renderer";
import type { DirtyRun, FrameDiff, IndexedFrame } from "../../engines/core/frame";
import type { RuleDef, StateSnapshot, StateValue, VariableDef } from "../../engines/core/variables";
import type { HudState, SheetRow } from "../../engines/core/game";
import { encodeFrame } from "../framebuffer/protocol";
import { diffFrames } from "../framebuffer/diff";
import { fixedPalette256, fixedPalette64 } from "../framebuffer/quantize";

export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8765/sgs";

export interface BridgeManifest {
  game: string;
  title: string;
  variables: VariableDef[];
  rules: RuleDef[];
  sheets?: { name: string; columns: string[] }[];
  controls?: [string, string][];
  paletteMode?: string;
  /** Palette for the hello; defaults from paletteMode (fixed64/fixed256) or the last frame. */
  palette?: ArrayLike<number>;
  /** KeyboardEvent.code -> action, used by the bridge's key capture (protocol extension, optional). */
  keyBindings?: Record<string, string>;
  origin?: { col: number; row: number };
}

export interface BridgeSheet {
  name: string;
  columns: string[];
  rows: SheetRow[];
}

export interface AckMessage {
  t: "ack";
  frameId: number;
  applyMs: number;
  cells: number;
  calls: number;
  bytes?: number;
  busy?: boolean;
  coalesced?: boolean;
  [k: string]: unknown;
}

export interface ReadyMessage {
  t: "ready";
  sink: string;
  strategy: string;
  excelVersion?: string;
  [k: string]: unknown;
}

/** The subset of the WebSocket API used here (browser WebSocket and `ws` both satisfy it). */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface ExcelBridgeOptions {
  url?: string;
  /** Called for every hello (connect, reconnect, resize, palette-mode change). */
  manifest: () => BridgeManifest;
  WebSocket?: WebSocketCtor;
  /** Max un-acked frames in flight (contract default 1). */
  window?: number;
  stateHz?: number;
  hudHz?: number;
  sheetHz?: number;
  telemetryHz?: number;
  /** Optional providers, polled from syncState() at their rates. */
  hud?: () => HudState | null;
  sheets?: () => BridgeSheet[];
  telemetry?: () => Record<string, number | string>;
  reconnect?: boolean;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** In-flight frames older than this are considered lost (bridge stalled). */
  ackTimeoutMs?: number;
  /** Run merge gap used when the backend re-diffs after drops. */
  mergeGap?: number;
  /** Send a full state snapshot at least this often (deltas otherwise). */
  fullStateMs?: number;
  /** Never send a frame while the socket has more than this many bytes queued. */
  maxBufferedBytes?: number;
  onAck?: (ack: AckMessage, rttMs: number) => void;
  onReady?: (ready: ReadyMessage) => void;
  onError?: (message: string) => void;
  onConnection?: (connected: boolean) => void;
}

const OPEN = 1;

/**
 * Largest full frame (cells) measured at >= 10 FPS per sink/strategy, from
 * renderers/excel/bench/results.json (LibreOffice 24.2 headless, 2 vCPU Xeon).
 * Native Excel is UNVERIFIED: 0 = unknown until native_test.py has been run.
 */
export const MEASURED_CELL_BUDGET: Record<string, number> = {
  "calc-uno/values-cf": 129600,
  "calc-uno/interior": 57600,
  "mock/values-cf": 129600,
  "mock/interior": 129600,
};

/** `?bridge=ws://127.0.0.1:8765/sgs` -> URL, or null. */
export function bridgeUrlFromLocation(search: string): string | null {
  const v = new URLSearchParams(search).get("bridge");
  if (!v) return null;
  return v === "1" || v === "true" ? DEFAULT_BRIDGE_URL : v;
}

function keyframeDiff(w: number, h: number): FrameDiff {
  const runs: DirtyRun[] = [];
  for (let y = 0; y < h; y++) runs.push({ row: y, x0: 0, length: w });
  return { keyframe: true, changedCells: w * h, runs, bounds: { x0: 0, y0: 0, x1: w, y1: h } };
}

export class ExcelBridgeBackend implements RenderBackend {
  readonly id = "excel-bridge";
  readonly label = "Native spreadsheet (Excel / LibreOffice bridge)";
  readonly capabilities: BackendCapabilities = { cellFrames: true, directCanvas: false, measuredCellBudget: 0, input: true, stateEdit: true };

  readonly url: string;
  private opts: Required<Omit<ExcelBridgeOptions, "hud" | "sheets" | "telemetry" | "onAck" | "onReady" | "onError" | "onConnection" | "WebSocket" | "url">> & ExcelBridgeOptions;
  private Ws: WebSocketCtor;
  private ws: WebSocketLike | null = null;
  private init_: BackendInit | null = null;
  private width = 0;
  private height = 0;
  private connected = false;
  private shuttingDown = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectWaiters: (() => void)[] = [];

  // frame state
  private inFlight = 0;
  private sentAt = new Map<number, number>();
  private shadow: Uint8Array | null = null;
  private lastSentId = -1;
  private needKey = true;
  private missed = false;
  private lastPaletteVersion = -1;
  private lastPaletteLength = -1;
  private lastPalette: Uint32Array | null = null;

  // state throttles
  private lastStateAt = -1e9;
  private lastFullStateAt = -1e9;
  private sentValues = new Map<string, StateValue>();
  private sentRules = "";
  private lastHudAt = -1e9;
  private lastSheetAt = -1e9;
  private lastTelAt = -1e9;
  private sentSheets = new Map<string, string>();
  private pendingHud: HudState | null = null;
  private pendingTel: Record<string, number | string> | null = null;

  // stats
  private rate = new RateCounter();
  private presentEma = new Ema(0.2);
  private dropped = 0;
  private lastFrameBytes = 0;
  private lastCells = 0;
  ready: ReadyMessage | null = null;
  readonly counters = { framesSent: 0, acks: 0, busyAcks: 0, rediffs: 0, keyframes: 0, hellos: 0, edits: 0, rules: 0, inputs: 0, reconnects: 0, ackTimeouts: 0, skippedEmpty: 0 };

  constructor(options: ExcelBridgeOptions) {
    this.opts = {
      window: 1, stateHz: 10, hudHz: 5, sheetHz: 2, telemetryHz: 2, reconnect: true, reconnectMinMs: 500, reconnectMaxMs: 10000,
      ackTimeoutMs: 5000, mergeGap: 4, fullStateMs: 5000, maxBufferedBytes: 4 * 1024 * 1024,
      ...options,
    } as ExcelBridgeBackend["opts"];
    this.url = options.url ?? DEFAULT_BRIDGE_URL;
    const g = globalThis as unknown as { WebSocket?: WebSocketCtor };
    const W = options.WebSocket ?? g.WebSocket;
    if (!W) throw new Error("ExcelBridgeBackend: no WebSocket implementation (pass options.WebSocket, e.g. from the 'ws' package)");
    this.Ws = W;
  }

  // ---- lifecycle ----------------------------------------------------------
  async init(init: BackendInit): Promise<void> {
    this.init_ = init;
    this.width = init.width;
    this.height = init.height;
    this.connect();
  }

  /** Resolves once connected (or after timeoutMs, returning false). */
  whenConnected(timeoutMs = 5000): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.connectWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  private connect(): void {
    if (this.shuttingDown) return;
    let ws: WebSocketLike;
    try {
      ws = new this.Ws(this.url);
    } catch (e) {
      this.opts.onError?.(`connect failed: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connected = true;
      if (this.attempts > 0) this.counters.reconnects++;
      this.attempts = 0;
      this.inFlight = 0;
      this.sentAt.clear();
      this.needKey = true;
      this.sentValues.clear();
      this.sentRules = "";
      this.sentSheets.clear();
      this.lastFullStateAt = -1e9;
      this.sendHello();
      this.opts.onConnection?.(true);
      for (const w of this.connectWaiters.splice(0)) w();
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onMessage(ev.data);
    };
    ws.onerror = () => {
      /* close follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      const was = this.connected;
      this.connected = false;
      this.ws = null;
      this.inFlight = 0;
      this.sentAt.clear();
      this.needKey = true;
      this.ready = null;
      if (was) this.opts.onConnection?.(false);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || !this.opts.reconnect || this.reconnectTimer) return;
    const base = Math.min(this.opts.reconnectMaxMs, this.opts.reconnectMinMs * 2 ** Math.min(this.attempts, 10));
    const delay = base * (0.85 + Math.random() * 0.3);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    if (ws && ws.readyState === OPEN) {
      try {
        ws.send(JSON.stringify({ t: "bye" }));
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1000);
        ws.onclose = () => {
          clearTimeout(t);
          resolve();
        };
        ws.close(1000, "bye");
      });
    } else if (ws) {
      ws.close();
    }
    this.ws = null;
    this.connected = false;
  }

  // ---- outgoing -----------------------------------------------------------------
  private sendText(obj: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  private helloPalette(): number[] {
    const m = this.opts.manifest();
    if (m.palette) return Array.from(m.palette);
    if (this.lastPalette) return Array.from(this.lastPalette);
    if (m.paletteMode === "fixed64") return Array.from(fixedPalette64());
    if (m.paletteMode === "fixed256") return Array.from(fixedPalette256());
    return [];
  }

  private sendHello(paletteOverride?: Uint32Array): void {
    const m = this.opts.manifest();
    const palette = paletteOverride ? Array.from(paletteOverride) : this.helloPalette();
    const hello = {
      t: "hello",
      game: m.game,
      title: m.title,
      width: this.width,
      height: this.height,
      origin: m.origin ?? { col: 0, row: 3 },
      palette,
      paletteMode: m.paletteMode ?? "adaptive",
      variables: m.variables,
      rules: m.rules,
      sheets: m.sheets ?? [],
      controls: m.controls ?? [],
      ...(m.keyBindings ? { keyBindings: m.keyBindings } : {}),
    };
    if (this.sendText(hello)) {
      this.counters.hellos++;
      this.needKey = true;
    }
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.shadow = null;
    this.needKey = true;
    if (this.connected) this.sendHello();
  }

  submitFrame(frame: IndexedFrame, diff: FrameDiff): boolean {
    const ws = this.ws;
    if (!this.connected || !ws || ws.readyState !== OPEN) {
      this.dropped++;
      this.missed = true;
      return false;
    }
    const now = performance.now();
    if (this.inFlight > 0) {
      let oldest = Infinity;
      for (const t of this.sentAt.values()) oldest = Math.min(oldest, t);
      if (now - oldest > this.opts.ackTimeoutMs) {
        this.counters.ackTimeouts++;
        this.inFlight = 0;
        this.sentAt.clear();
      }
    }
    if (this.inFlight >= this.opts.window || (ws.bufferedAmount ?? 0) > this.opts.maxBufferedBytes) {
      this.dropped++;
      this.missed = true;
      return false;
    }
    if (frame.width !== this.width || frame.height !== this.height) {
      // host resized without calling resize(): follow the frame
      this.width = frame.width;
      this.height = frame.height;
      this.shadow = null;
      this.sendHello();
    }
    if (this.lastPaletteLength >= 0 && frame.palette.length !== this.lastPaletteLength) {
      // palette-mode change (e.g. fixed64 -> fixed256): new hello so the bridge rebuilds its CF rules
      this.sendHello(frame.palette);
    }
    const cells = frame.width * frame.height;
    let d = diff;
    if (this.needKey || !this.shadow || this.shadow.length !== cells) {
      d = diff.keyframe ? diff : keyframeDiff(frame.width, frame.height);
    } else if (this.missed || frame.id !== this.lastSentId + 1) {
      d = diffFrames(this.shadow, frame.indices, frame.width, frame.height, this.opts.mergeGap, false, null);
      this.counters.rediffs++;
    }
    const includePalette = d.keyframe || frame.paletteVersion !== this.lastPaletteVersion;
    if (!this.shadow || this.shadow.length !== cells) this.shadow = new Uint8Array(cells);
    if (d.runs.length === 0 && !includePalette) {
      this.lastSentId = frame.id;
      this.missed = false;
      this.counters.skippedEmpty++;
      return true;
    }
    const buf = encodeFrame(frame, d, includePalette);
    ws.send(buf);
    this.inFlight++;
    this.sentAt.set(frame.id >>> 0, now);
    this.shadow.set(frame.indices);
    this.lastSentId = frame.id;
    this.lastPaletteVersion = frame.paletteVersion;
    this.lastPaletteLength = frame.palette.length;
    this.lastPalette = frame.palette;
    this.needKey = false;
    this.missed = false;
    this.lastFrameBytes = buf.byteLength;
    this.counters.framesSent++;
    if (d.keyframe) this.counters.keyframes++;
    return true;
  }

  /** Throttled state/hud/sheet/telemetry push. Called by the host (~10 Hz). */
  syncState(snapshot: StateSnapshot): void {
    if (!this.connected) return;
    const now = performance.now();
    if (now - this.lastStateAt >= 1000 / this.opts.stateHz) {
      const full = now - this.lastFullStateAt >= this.opts.fullStateMs;
      const values: Record<string, StateValue> = {};
      let n = 0;
      for (const [k, v] of Object.entries(snapshot.values)) {
        if (full || this.sentValues.get(k) !== v) {
          values[k] = v;
          this.sentValues.set(k, v);
          n++;
        }
      }
      const rulesJson = JSON.stringify(snapshot.rules);
      const rulesChanged = full || rulesJson !== this.sentRules;
      if (n > 0 || rulesChanged) {
        this.sendText({ t: "state", values, ...(rulesChanged ? { rules: snapshot.rules } : {}) });
        this.sentRules = rulesJson;
        this.lastStateAt = now;
        if (full) this.lastFullStateAt = now;
      }
    }
    const hud = this.pendingHud ?? this.opts.hud?.() ?? null;
    if (hud) this.sendHud(hud);
    if (this.opts.sheets && now - this.lastSheetAt >= 1000 / this.opts.sheetHz) {
      for (const s of this.opts.sheets()) this.sendSheet(s);
    }
    const tel = this.pendingTel ?? this.opts.telemetry?.() ?? null;
    if (tel) this.sendTelemetry(tel);
  }

  /** HUD rows (GAME!A1:A2). Rate-limited to hudHz; the latest value wins. */
  sendHud(hud: HudState): void {
    const now = performance.now();
    if (now - this.lastHudAt < 1000 / this.opts.hudHz) {
      this.pendingHud = hud;
      return;
    }
    if (this.sendText({ t: "hud", ...hud })) {
      this.lastHudAt = now;
      this.pendingHud = null;
    }
  }

  /** Custom sheet such as MISSIONS. Only sent when its content changed; ≤ sheetHz. */
  sendSheet(sheet: BridgeSheet): void {
    const json = JSON.stringify(sheet);
    if (this.sentSheets.get(sheet.name) === json) return;
    const now = performance.now();
    if (now - this.lastSheetAt < 1000 / this.opts.sheetHz) return;
    if (this.sendText({ t: "sheet", name: sheet.name, columns: sheet.columns, rows: sheet.rows })) {
      this.sentSheets.set(sheet.name, json);
      this.lastSheetAt = now;
    }
  }

  sendTelemetry(t: Record<string, number | string>): void {
    const now = performance.now();
    if (now - this.lastTelAt < 1000 / this.opts.telemetryHz) {
      this.pendingTel = t;
      return;
    }
    if (this.sendText({ t: "telemetry", ...t })) {
      this.lastTelAt = now;
      this.pendingTel = null;
    }
  }

  // ---- incoming -----------------------------------------------------------------
  private onMessage(data: unknown): void {
    if (typeof data !== "string") return; // bridge sends text only
    let m: { t?: string; [k: string]: unknown };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    const init = this.init_;
    switch (m.t) {
      case "ack": {
        const a = m as unknown as AckMessage;
        const id = a.frameId >>> 0;
        const sent = this.sentAt.get(id);
        if (sent !== undefined) {
          this.sentAt.delete(id);
          this.inFlight = Math.max(0, this.inFlight - 1);
        }
        const rtt = sent !== undefined ? performance.now() - sent : NaN;
        this.counters.acks++;
        if (a.busy) this.counters.busyAcks++;
        if (!a.coalesced) {
          if (Number.isFinite(rtt)) this.presentEma.push(rtt);
          this.lastCells = a.cells;
          this.rate.tick();
        }
        this.opts.onAck?.(a, rtt);
        break;
      }
      case "ready":
        this.ready = m as unknown as ReadyMessage;
        this.capabilities.measuredCellBudget = MEASURED_CELL_BUDGET[`${this.ready.sink}/${this.ready.strategy}`] ?? 0;
        this.opts.onReady?.(this.ready);
        break;
      case "edit":
        if (typeof m.key === "string" && init) {
          this.counters.edits++;
          init.emitState({ [m.key]: m.value as StateValue });
        }
        break;
      case "rule":
        if (typeof m.name === "string" && typeof m.formula === "string" && init) {
          this.counters.rules++;
          init.emitState({ [`rule:${m.name}`]: m.formula });
        }
        break;
      case "input":
        if (typeof m.action === "string" && init) {
          this.counters.inputs++;
          init.emitInput({ type: "action", action: m.action, down: !!m.down });
        }
        break;
      case "error":
        this.opts.onError?.(String(m.message ?? "bridge error"));
        break;
    }
  }

  stats(): BackendStats {
    return {
      presentedFps: this.rate.rate,
      droppedFrames: this.dropped,
      presentMs: this.presentEma.value,
      lastFrameBytes: this.lastFrameBytes,
      lastChangedCells: this.lastCells,
      connected: this.connected,
    };
  }

  /** Frames currently awaiting an ack. */
  get pending(): number {
    return this.inFlight;
  }
}
