# Native spreadsheet backend (Excel / LibreOffice Calc bridge)

The game streams SGF1 palette-indexed dirty-run frames over a WebSocket to a
local Python bridge (`sgs_bridge`) that writes them into **real worksheet
cells**, keeps the PLAYER / VEHICLES / WORLD / RULES / MISSIONS / TELEMETRY
sheets in sync, sends user edits and rule formulas back to the game, and
forwards key presses. Contract: [`protocol.md`](protocol.md).

| What | Status in this repo |
|---|---|
| Bridge + protocol + planning | Tested (unit + end-to-end over real WebSockets) |
| LibreOffice Calc 24.2 via UNO (`calc-uno`) | **Tested and measured** (headless soffice): exact pixel to cell readback, CF rules, formulas recalculated by Calc, edit polling, save |
| Mock sink (`mock`) | Tested and measured (upper bound of bridge overhead; runs the Excel address-string planner) |
| Snapshot sink (`snapshot`, openpyxl .xlsx) | Tested |
| Excel via COM (`excel-com`) / xlwings (`excel-xlwings`) | Implemented; call sequences checked against a **fake** COM object model only. **Native Excel: UNVERIFIED** (see the last section) |

## Architecture

```
 Browser or Node (the game)                                  Local machine
 +--------------------------------+  ws://127.0.0.1:8765/sgs  +------------------------------------------+
 | SpreadsheetGame -> StudioHost  |  binary SGF1 frames  ---> | python -m sgs_bridge                     |
 | FramePipeline (quantise, diff) |  hello/state/hud/sheet/   |  asyncio server, one game connection     |
 | ExcelBridgeBackend             |  telemetry/bye (JSON) --> |  ordered ops queue: hello, frames        |
 |  - ack window (1 in flight)    |                           |   (queued frames coalesce into one write)|
 |  - shadow of last sent frame,  | <--- ready / ack / edit / |  FrameState: target indices + dirty mask |
 |    re-diff after drops         |      rule / input / error |  planning.py: bands | colour rectangles  |
 |  - reconnect with backoff      |                           |  ONE worker thread -> Sink               |
 +--------------------------------+                           |   excel-com     (pywin32)  -> Excel      |
                                                              |   excel-xlwings (xlwings)  -> Excel      |
                                                              |   calc-uno      (UNO URP)  -> soffice    |
                                                              |   snapshot      (openpyxl) -> .xlsx      |
                                                              |   mock          (numpy)                  |
                                                              |  writers: state 10 Hz, hud 5 Hz,         |
                                                              |           sheet/telemetry 2 Hz           |
                                                              |  pollers: variable B / RULES!B (250 ms), |
                                                              |           INPUT sheet (50 ms), pynput    |
                                                              +------------------------------------------+
```

Key design points:

* **Backpressure (ADR-005).** The backend keeps at most `window` (default 1)
  frames un-acked and returns `false` from `submitFrame` otherwise (counted in
  `droppedFrames`). Because the host's diff is relative to the *previous
  pipeline frame*, not to what the bridge has, the backend keeps a shadow copy
  of the last frame it actually sent and re-diffs against it after any drop or
  reconnect (keyframe after connect/resize/palette-mode change). The bridge
  can never miss changes.
* **Self-healing writes.** The bridge applies every frame to a shadow
  (`target`) and marks a `dirty` mask that is cleared only after a successful
  sink write. If Excel refuses COM calls (cell edit mode, modal dialog:
  `RPC_E_CALL_REJECTED`), the frame is acked with `busy:true` and its cells are
  rewritten with the next frame. No keyframe request is needed in the protocol.
* **Ordered, coalesced processing.** `hello` and frames go through one queue;
  if several frames are queued (a client ignoring the window), they are
  merged into one sink write and each is acked (`coalesced:true` on all but
  the last).
* **One worker thread** owns the spreadsheet connection (COM STA requirement,
  blocking UNO calls); the asyncio loop never blocks on the application.

## Files

| Path | Purpose |
|---|---|
| `renderers/excel/ExcelBridgeBackend.ts` | `RenderBackend` id `excel-bridge` (browser WebSocket or Node `ws`) |
| `renderers/excel/node-client.ts` | Node benchmark client: synthetic scene -> real `FramePipeline` (fixed64) -> backend -> bridge |
| `renderers/excel/bridge/sgs_bridge/` | Python package: `protocol.py` (SGF1), `layout.py` (workbook contract), `planning.py` (bands, colour groups, Excel address strings), `state.py` (shadow, echo guard), `sync.py` (two-way cell sync, VBA input timing), `server.py`, `workbook.py` (openpyxl builder), `input_capture.py` (pynput), `sinks/` |
| `renderers/excel/vba/SGSInput.bas` | VBA `Application.OnKey` capture into the hidden INPUT sheet |
| `renderers/excel/native_test.py` | Windows/Excel correctness + benchmark script (also runs on Calc/mock) |
| `renderers/excel/bench/results.json` | Measured results (this document's tables) |
| `scripts/excel/build_workbook.py` | hello manifest -> contract workbook (.xlsx), `--verify` recalculates with LibreOffice |
| `scripts/excel/bench_sinks.py` | Benchmark driver (real bridge processes + Node client) |
| `scripts/excel/run_tests.sh` | Runs both test suites |
| `tests/excel/` | Tests, fixtures (`sample_hello.json`, TS-encoded SGF1 frames), fake COM model |

## Setup

### Windows + Microsoft Excel (UNVERIFIED in this repo)

```bat
pip install websockets numpy openpyxl pywin32 xlwings
REM 1. (optional) prebuild the workbook; the bridge also builds it if the file is missing
python scripts\excel\build_workbook.py tests\excel\fixtures\sample_hello.json --out %USERPROFILE%\gridlock.xlsx
REM 2. open it in Excel (keep Excel open), then start the bridge
cd renderers\excel\bridge
python -m sgs_bridge --sink excel-com --workbook %USERPROFILE%\gridlock.xlsx
REM    or: --sink excel-xlwings
REM 3. serve the game from localhost and open http://localhost:<port>/?bridge=ws://127.0.0.1:8765/sgs
```

* The game page **must be served from localhost** (`npm run serve` / any
  local static server). Pages served from a public host cannot open a
  WebSocket to `127.0.0.1` (mixed content / private-network-access blocking).
* The bridge attaches to a running Excel (`GetActiveObject`) and to the
  workbook if it is already open, otherwise opens or creates it. If the
  `_SGS!B1` signature of the workbook matches the hello (same size, palette
  and variable layout) the existing layout and conditional formats are
  reused; otherwise GAME and the variable sheets are rebuilt in place.
* Per frame batch the Excel sinks set `ScreenUpdating = False` and
  `Calculation = xlCalculationManual`, then restore both (one repaint per
  frame). Ctrl+C stops the bridge, writes `BRIDGE STOPPED` in GAME!A1 and
  saves the workbook; Excel stays open. When the game disconnects, GAME!A1
  shows `DISCONNECTED - waiting for game ...` and the workbook stays as is.
* Do not click into cells while playing: Excel in edit mode rejects COM
  calls (frames are acked `busy` and healed afterwards; state writes and
  polls pause).
* Keyboard: either import `renderers/excel/vba/SGSInput.bas`, save as
  `.xlsm`, run `SGS_Start` (F12 toggles), or start the bridge with
  `--global-keys` (`pip install pynput`, captures keys system-wide with real
  key-up events).

### macOS + Excel (UNVERIFIED)

`pip install xlwings websockets numpy openpyxl`, then
`python -m sgs_bridge --sink excel-xlwings --workbook ~/gridlock.xlsx`.
xlwings drives Excel through AppleScript: every call is an Apple Event round
trip, so expect far lower FPS than Windows COM (use 80x45 or 160x90).
xlwings cannot create conditional formats on macOS, so `values-cf` requires a
workbook built by `build_workbook.py` (the bridge builds one automatically
when the file does not exist yet); without CF rules the sink falls back to
`interior`. `--global-keys` needs Accessibility / Input Monitoring permission
for the terminal. VBA `OnKey` works in Mac Excel too, with the same limits.

### LibreOffice Calc (Linux, macOS, Windows) - tested

```sh
cd renderers/excel/bridge
python3 -m sgs_bridge --sink calc-uno --workbook ~/gridlock.xlsx [--visible]
```

The sink starts a private `soffice --accept=socket,...;urp;` with its own
user profile (`-env:UserInstallation`) and kills it on exit; use
`--no-spawn-soffice --uno-port 2002` to attach to an soffice you started.
It needs the Python that ships `uno` (system python3 on Linux; LibreOffice's
bundled python on Windows/macOS). `--visible` shows the Calc window (needs a
desktop; all numbers below are headless, without repaint cost).

### Other sinks

* `--sink snapshot --workbook out.xlsx`: writes a real .xlsx (openpyxl) where
  each GAME cell has the fill of its pixel, every `--snapshot-every` seconds
  and on bye/shutdown. For inspection and demos, not real-time play.
* `--sink mock [--mock-dump state.json]`: in-memory, for tests and to measure
  the bridge's own overhead.

### Node / headless use of the backend

```ts
import WebSocket from "ws";
import { ExcelBridgeBackend } from "./renderers/excel/ExcelBridgeBackend";
const be = new ExcelBridgeBackend({ url: "ws://127.0.0.1:8765/sgs", WebSocket: WebSocket as never, manifest: () => ({ game, title, variables, rules, paletteMode: "fixed64", keyBindings }) });
await host.addBackend(be);
```

Options: `window` (ack window), `stateHz`/`hudHz`/`sheetHz`/`telemetryHz`,
providers `hud()`, `sheets()`, `telemetry()` (polled from `syncState`),
`reconnect`, `reconnectMinMs`/`MaxMs` (exponential backoff with jitter),
`ackTimeoutMs`, `onAck`, `onReady`, `onError`, `onConnection`.
`bridgeUrlFromLocation(location.search)` reads `?bridge=`.

### Bridge CLI

Run from `renderers/excel/bridge`, or install once with
`pip install -e renderers/excel/bridge` (checked) to use `python -m sgs_bridge` anywhere.

```
python -m sgs_bridge --sink {excel-xlwings,excel-com,calc-uno,mock,snapshot}
                     --strategy {auto,values-cf,interior,interior-runs}
                     --workbook PATH --host 127.0.0.1 --port 8765 --path /sgs
                     [--poll-ms 250] [--input-release-ms 600] [--global-keys]
                     [--uno-host H --uno-port P --no-spawn-soffice --visible]
                     [--mock-dump PATH --mock-call-ms MS] [--snapshot-every S] [-v]
```

## Workbook layout and `build_workbook.py`

`python3 scripts/excel/build_workbook.py manifest.json --out game.xlsx [--frame f.sgf1 ...] [--verify]`
builds the contract layout from a hello-shaped manifest with openpyxl:
GAME (frame at A4, columns 0.85 OOXML units, rows 4.5 pt, which LibreOffice
imports as 1.66 mm x 1.59 mm, i.e. square; HUD rows 1-3; one `cellIs equal i`
conditional-format rule per palette entry over the frame range; cell number
format `;;;`), one sheet per variable sheet (header
`Variable, Value, Min, Max, Unit, Description, Key`, data validation from
min/max/options), RULES with real formulas in B, a workbook defined name for
every named variable and rule, MISSIONS, TELEMETRY, README (setup steps),
hidden INPUT (for SGSInput.bas) and hidden `_SGS` (layout signature).
`--verify` reopens the file with openpyxl, converts it with
`soffice --headless --convert-to xlsx` and reads the recalculated values back:
every RULES formula must equal the value computed from the defined names
(tested with non-default inputs and a rule that references other rules).

## Strategies

| Strategy | How | Palette change | Best when |
|---|---|---|---|
| `values-cf` | GAME cells hold the palette index; 1 CF rule per index colours them. Dirty cells are planned into rectangular bands (`plan_bands`, cost model: one call is worth `call_cost_cells` redundant cells; Calc 3000, Excel 400 unverified) and written with one bulk call each (`setDataArray` / `Range.Value = 2D tuple`). | Only the CF rule / cell-style colours change (64-256 calls); no cell is rewritten | Almost always (default for every sink) |
| `interior` | Direct fill. Dirty cells are grouped per colour into rectangles (vectorised, vertical merging; `plan_colour_rects`), then one call per colour: Calc `XSheetCellRanges` + `CellBackColor`; Excel multi-area `Range("A4:B5,C7,...")` strings of <= 255 characters + `Interior.Color` (BGR). | Every cell of a changed slot is refilled | Very sparse changes at high resolution; files viewed without CF support |
| `interior-runs` | Calc only, benchmark: one `CellBackColor` call per rectangle | as interior | Never (shown to quantify per-call cost) |

`--strategy auto` picks `values-cf` for every sink (measured best for Calc;
for Excel it is the design choice from ADR-003, unverified). Excel on macOS
without CF rules falls back to `interior`.

## Edits, rules and echo suppression

* Every 250 ms the bridge reads column B of each variable sheet and
  RULES!B (formula text + the spreadsheet's own computed value) in one job
  on the worker thread. Before every state write the same read happens first,
  so an edit typed since the last poll is sent to the game instead of being
  overwritten by stale state.
* `EchoGuard` (`state.py`) remembers what the bridge itself wrote *as read
  back from the application* (Calc rewrites `,` to `;` and reformats
  formulas; that is never mistaken for a user edit). A user edit is sent once
  (`edit {key, value}` normalised by variable type, or
  `rule {name, formula, value}` with Excel syntax), then incoming game state
  for that key is held off until the game echoes the new value or 1.5 s pass
  (then the game's value is written back, e.g. when the game rejected it).
  Read-only variables are reverted. The cell the user currently has selected
  is never overwritten (Calc: controller selection; Excel: `ActiveCell`; COM
  busy errors pause writes entirely).
* Rule edits reach the host as patch key `rule:<Name>` with the formula
  string (`StudioHost.applyPatch` -> `setRuleFormula`).

## Input

* **VBA** (`SGSInput.bas`): `Application.OnKey` per key in INPUT!D
  (`|`-separated), each press increments INPUT!B; the bridge polls every
  50 ms and emits `input down` on a counter change. OnKey has **no key-up**:
  the bridge releases the action `--input-release-ms` (600 ms) after the
  last press, which covers the usual 500 ms auto-repeat delay. Consequences:
  taps hold ~0.6 s; with two keys held, Windows auto-repeats only the last one,
  so the other is released (diagonals pulse); Shift alone cannot be bound
  (an action listed as `+` becomes a modifier: Shift+W presses `up` and
  `sprint`); OnKey only fires in Ready mode and intercepts the bound keys in
  all of Excel (F12 toggles capture so you can type in cells).
* **pynput** (`--global-keys`): real down/up events system-wide, mapped via
  the hello's `keyBindings` (or the Gridlock City defaults), auto-repeat
  suppressed. Captures keys in every application while running.

## Benchmarks (measured)

Method: `python3 scripts/excel/bench_sinks.py` (total 210 s). For each sink
and strategy a real bridge process is started; for each resolution and mode
the Node client renders a synthetic scene, quantises it with the real
`FramePipeline` (fixed64, default hysteresis), and streams it through the
real `ExcelBridgeBackend` over a real WebSocket, sending the next frame on
ack (one in flight). `apply ms` = bridge-side decode + plan + sink write;
`ack ms` = client round trip; FPS = acked frames per second (sink-bound
maximum). Modes: `full` = keyframe every frame, `diff` = differential. Scenes:
`pan` = camera pans 1.5 cells/frame over skyline + road + 6 cars (about 6% of
cells change, spread over the frame); `drive` = static camera, lane dashes +
6 moving cars (about 0.9% change, localised). Frames: 40 (full) / 90 (diff), at
most 6 s per configuration (but at least 7 frames), first 2 frames excluded. Raw data:
`renderers/excel/bench/results.json`.

Environment: Linux container, Intel Xeon @ 2.10 GHz, **2 vCPUs** (client,
bridge and soffice compete for them), 7.8 GB RAM, Python 3.13, Node 22.23,
LibreOffice 24.2.7.2 **headless** (no window, so no repaint cost; a visible
Calc window will be slower). Expect roughly ±20% run-to-run noise on the
Calc rows (p95 shows the spikes).

### LibreOffice Calc (calc-uno), measured

| strategy | res | mode | scene | changed % | apply ms med | apply ms p95 | ack ms med | FPS | cells/frame | calls/frame | bytes/frame |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| values-cf | 80x45 | full | pan | 100.0 | 6.06 | 9.86 | 6.59 | 134.9 | 3600 | 4.0 | 4086 |
| values-cf | 80x45 | diff | pan | 6.1 | 4.62 | 7.16 | 5.10 | 177.3 | 3009 | 4.0 | 743 |
| values-cf | 80x45 | diff | drive | 0.9 | 3.76 | 6.27 | 4.19 | 211.7 | 1235 | 4.0 | 203 |
| values-cf | 160x90 | full | pan | 100.0 | 13.24 | 21.07 | 14.19 | 65.7 | 14400 | 4.0 | 15156 |
| values-cf | 160x90 | diff | pan | 6.1 | 9.92 | 14.60 | 10.59 | 86.1 | 12400 | 4.0 | 2454 |
| values-cf | 160x90 | diff | drive | 0.9 | 5.91 | 11.27 | 6.34 | 136.8 | 6077 | 4.0 | 578 |
| values-cf | 240x135 | full | pan | 100.0 | 27.45 | 41.33 | 29.25 | 31.4 | 32400 | 4.0 | 33426 |
| values-cf | 240x135 | diff | pan | 5.8 | 22.45 | 40.03 | 23.31 | 37.7 | 27916 | 4.0 | 4753 |
| values-cf | 240x135 | diff | drive | 0.8 | 13.32 | 20.75 | 13.97 | 62.2 | 11108 | 5.4 | 1003 |
| values-cf | 320x180 | full | pan | 100.0 | 45.30 | 74.98 | 46.33 | 19.2 | 57600 | 4.0 | 58896 |
| values-cf | 320x180 | diff | pan | 5.5 | 38.29 | 60.85 | 39.24 | 23.2 | 48717 | 4.7 | 7384 |
| values-cf | 320x180 | diff | drive | 0.9 | 19.52 | 23.80 | 20.19 | 45.1 | 13103 | 8.0 | 1504 |
| values-cf | 480x270 | full | pan | 100.0 | 85.08 | 99.00 | 86.74 | 11.1 | 129600 | 4.0 | 131436 |
| values-cf | 480x270 | diff | pan | 5.6 | 73.36 | 112.85 | 74.39 | 12.3 | 103794 | 7.2 | 14803 |
| values-cf | 480x270 | diff | drive | 0.8 | 34.05 | 46.11 | 34.77 | 25.8 | 19416 | 10.6 | 2527 |
| interior | 80x45 | full | pan | 100.0 | 31.87 | 41.06 | 33.55 | 28.9 | 3600 | 37.0 | 4086 |
| interior | 80x45 | diff | pan | 6.1 | 26.86 | 41.02 | 27.55 | 34.3 | 307 | 30.0 | 743 |
| interior | 80x45 | diff | drive | 0.9 | 6.46 | 10.74 | 6.86 | 132.2 | 63 | 17.2 | 203 |
| interior | 160x90 | full | pan | 100.0 | 44.28 | 59.25 | 44.98 | 21.6 | 14400 | 37.3 | 15156 |
| interior | 160x90 | diff | pan | 6.1 | 42.48 | 51.89 | 43.41 | 22.4 | 1164 | 34.0 | 2454 |
| interior | 160x90 | diff | drive | 0.9 | 18.82 | 26.86 | 19.50 | 46.9 | 127 | 22.0 | 578 |
| interior | 240x135 | full | pan | 100.0 | 67.58 | 79.70 | 68.68 | 14.2 | 32400 | 37.0 | 33426 |
| interior | 240x135 | diff | pan | 5.8 | 40.23 | 52.69 | 40.90 | 22.9 | 2578 | 34.8 | 4753 |
| interior | 240x135 | diff | drive | 0.8 | 12.28 | 24.09 | 12.76 | 63.9 | 256 | 22.8 | 1003 |
| interior | 320x180 | full | pan | 100.0 | 57.01 | 83.56 | 57.93 | 16.4 | 57600 | 37.3 | 58896 |
| interior | 320x180 | diff | pan | 5.5 | 79.39 | 97.08 | 80.21 | 12.2 | 4284 | 35.1 | 7425 |
| interior | 320x180 | diff | drive | 0.9 | 23.25 | 29.95 | 24.10 | 38.3 | 497 | 23.1 | 1504 |
| interior | 480x270 | full | pan | 100.0 | 126.34 | 177.27 | 127.46 | 7.2 | 129600 | 37.0 | 131436 |
| interior | 480x270 | diff | pan | 5.6 | 133.61 | 160.79 | 136.53 | 7.1 | 9847 | 35.0 | 14625 |
| interior | 480x270 | diff | drive | 0.8 | 25.65 | 36.63 | 26.46 | 31.9 | 1066 | 23.3 | 2527 |
| interior-runs | 80x45 | full | pan | 100.0 | 362.35 | 407.17 | 363.09 | 2.7 | 3600 | 530.7 | 4086 |
| interior-runs | 80x45 | diff | pan | 6.1 | 212.18 | 283.59 | 212.81 | 4.5 | 308 | 326.8 | 757 |
| interior-runs | 80x45 | diff | drive | 0.9 | 13.15 | 28.18 | 14.39 | 60.7 | 63 | 30.9 | 203 |
| interior-runs | 160x90 | full | pan | 100.0 | 1268.56 | 1468.49 | 1269.54 | 0.8 | 14400 | 1736.0 | 15156 |
| interior-runs | 160x90 | diff | pan | 6.5 | 1060.55 | 1093.78 | 1061.69 | 0.9 | 1243 | 1485.7 | 2762 |
| interior-runs | 160x90 | diff | drive | 0.9 | 35.75 | 48.29 | 36.55 | 27.5 | 127 | 47.8 | 578 |
| interior-runs | 320x180 | full | pan | 100.0 | 2370.75 | 4622.28 | 2372.66 | 0.3 | 57600 | 5370.0 | 58896 |
| interior-runs | 320x180 | diff | pan | 5.8 | 2994.20 | 3863.77 | 2995.20 | 0.3 | 4473 | 4926.3 | 8060 |
| interior-runs | 320x180 | diff | drive | 0.9 | 51.28 | 75.50 | 52.64 | 17.0 | 501 | 65.2 | 1497 |

Calc "calls" count UNO round trips issued by the sink (values-cf: lock/unlock
controllers + range lookup + `setDataArray` per band; interior: per colour
`createInstance` + `addRangeAddresses` + `CellBackColor`).

### Mock sink (bridge overhead only), measured

| strategy | res | mode | scene | changed % | apply ms med | apply ms p95 | ack ms med | FPS | cells/frame | calls/frame | bytes/frame |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| values-cf | 80x45 | full | pan | 100.0 | 0.36 | 0.65 | 0.68 | 891.0 | 3600 | 1.0 | 4086 |
| values-cf | 80x45 | diff | pan | 6.1 | 0.40 | 0.51 | 0.85 | 876.1 | 2995 | 1.0 | 743 |
| values-cf | 80x45 | diff | drive | 0.9 | 0.41 | 0.59 | 0.74 | 996.7 | 1211 | 1.0 | 203 |
| values-cf | 160x90 | full | pan | 100.0 | 0.62 | 0.94 | 1.13 | 629.5 | 14400 | 1.0 | 15156 |
| values-cf | 160x90 | diff | pan | 6.1 | 0.81 | 1.19 | 1.25 | 571.0 | 11295 | 2.2 | 2454 |
| values-cf | 160x90 | diff | drive | 0.9 | 0.62 | 0.77 | 1.09 | 638.6 | 2488 | 3.0 | 578 |
| values-cf | 240x135 | full | pan | 100.0 | 1.14 | 1.43 | 1.95 | 305.1 | 32400 | 1.0 | 33426 |
| values-cf | 240x135 | diff | pan | 5.8 | 1.14 | 1.84 | 1.70 | 376.0 | 23423 | 4.0 | 4753 |
| values-cf | 240x135 | diff | drive | 0.8 | 0.77 | 0.98 | 1.23 | 458.5 | 6409 | 4.0 | 1003 |
| values-cf | 320x180 | full | pan | 100.0 | 1.03 | 1.32 | 1.67 | 310.3 | 57600 | 1.0 | 58896 |
| values-cf | 320x180 | diff | pan | 5.5 | 1.45 | 2.16 | 1.95 | 292.3 | 39687 | 7.5 | 7384 |
| values-cf | 320x180 | diff | drive | 0.9 | 1.06 | 1.85 | 1.62 | 289.5 | 6706 | 5.6 | 1504 |
| values-cf | 480x270 | full | pan | 100.0 | 1.79 | 2.74 | 2.77 | 173.1 | 129600 | 1.0 | 131436 |
| values-cf | 480x270 | diff | pan | 5.6 | 2.43 | 3.19 | 3.01 | 162.3 | 89836 | 10.3 | 14764 |
| values-cf | 480x270 | diff | drive | 0.8 | 1.46 | 1.74 | 1.97 | 200.4 | 13906 | 7.0 | 2527 |
| interior | 80x45 | full | pan | 100.0 | 1.42 | 1.95 | 1.87 | 428.0 | 3600 | 19.6 | 4086 |
| interior | 80x45 | diff | pan | 6.1 | 1.17 | 1.42 | 1.67 | 515.1 | 307 | 12.8 | 743 |
| interior | 80x45 | diff | drive | 0.9 | 0.42 | 1.83 | 0.74 | 817.4 | 63 | 6.4 | 203 |
| interior | 160x90 | full | pan | 100.0 | 3.01 | 7.19 | 3.46 | 207.1 | 14400 | 36.1 | 15156 |
| interior | 160x90 | diff | pan | 6.1 | 2.58 | 3.48 | 2.94 | 246.6 | 1164 | 28.4 | 2454 |
| interior | 160x90 | diff | drive | 0.9 | 0.67 | 0.92 | 1.07 | 570.4 | 127 | 8.5 | 578 |
| interior | 240x135 | full | pan | 100.0 | 5.03 | 5.79 | 5.58 | 156.6 | 32400 | 61.4 | 33426 |
| interior | 240x135 | diff | pan | 5.8 | 5.02 | 6.00 | 5.48 | 155.4 | 2578 | 51.7 | 4753 |
| interior | 240x135 | diff | drive | 0.8 | 1.10 | 1.42 | 1.65 | 339.7 | 256 | 8.9 | 1003 |
| interior | 320x180 | full | pan | 100.0 | 6.76 | 22.33 | 7.40 | 87.7 | 57600 | 93.6 | 58896 |
| interior | 320x180 | diff | pan | 5.5 | 7.20 | 7.92 | 7.60 | 110.5 | 4242 | 79.3 | 7384 |
| interior | 320x180 | diff | drive | 0.9 | 1.19 | 1.40 | 1.69 | 315.0 | 497 | 9.0 | 1504 |
| interior | 480x270 | full | pan | 100.0 | 19.73 | 30.97 | 20.96 | 39.8 | 129600 | 204.6 | 131436 |
| interior | 480x270 | diff | pan | 5.6 | 18.92 | 27.68 | 19.78 | 42.4 | 9831 | 186.9 | 14764 |
| interior | 480x270 | diff | drive | 0.8 | 1.94 | 2.58 | 2.53 | 158.0 | 1066 | 9.1 | 2527 |

The mock's interior path goes through the Excel planner, so its
"calls/frame" is the number of multi-area `Range(...)` address strings (of at
most 255 characters) the Excel sinks would issue per frame (each is about 3 COM
round trips: `Range`, `.Interior`, `.Color`). Its values-cf calls are bands
(one `Range.Value` each). These are counts, not Excel timings.

### What the numbers say

* **Calc: `values-cf` wins** at every full-frame and `pan` configuration
  (1.3-5.8x faster than `interior`). Calc sustains >= 10 FPS for full frames up to
  480x270 (129,600 cells, 11 FPS headless) and >= 60 FPS up to 160x90.
* Calc cost is dominated by per-call overhead, measured directly: a trivial
  UNO round trip is ~0.14 ms, creating a cell-range object ~0.8 ms, a
  `setDataArray` ~1.3-1.8 ms fixed plus ~0.5-0.7 us per cell. Hence the planner's
  call cost of 3000 cells for Calc, and why `interior-runs` (one call per
  rectangle) is unusable (0.3-0.8 FPS beyond 80x45). Turning off Calc's
  automatic row-height adjustment (`IsAdjustHeightEnabled = False`) made bulk
  writes up to ~35% faster in a micro-benchmark; `lockControllers` and locking the undo manager made
  no measurable difference headless.
* **Full vs differential:** when changes are spread over the frame (`pan`,
  ~6%), diff updates save 80-90% of the transport bytes but only 14-25% of
  Calc time, because the cheapest plan is still a few large bands. With
  localised changes (`drive`, ~1%) diff is 1.6-2.5x faster than full in Calc
  and needs 20-50x fewer bytes. For very sparse changes at high resolution,
  `interior` beats `values-cf` (480x270 drive: 25.7 ms vs 34.1 ms).
* Bridge overhead (mock) is at most 2.5 ms per frame for `values-cf` even at
  480x270; `interior` planning costs up to ~20 ms at 480x270 full frames
  (vectorised grouping plus a Python loop over every rectangle, 205 address
  strings per frame).
* `ack ms` is `apply ms` + 0.3-3 ms: WebSocket transport and Node-side
  encoding are small next to the spreadsheet.

## Native Excel performance: UNVERIFIED in this environment

No Microsoft Excel was available (Linux container). Nothing in this document
is an Excel measurement. The Excel sinks (`excel-com`, `excel-xlwings`) are
implemented from the documented object model and verified only for their
logic: the planning code through the mock sink, and the COM call sequences
(addresses, BGR colours, 2D arrays, CF rules, names, busy handling) against a
fake COM object model in `tests/excel/test_excel_fake.py`. Real Excel
behaviour (e.g. whether `ColumnWidth = 0.58` renders square, CF repaint cost
with 64 rules over 129,600 cells, COM marshalling speed of large arrays) is
unknown. `capabilities.measuredCellBudget` is 0 for Excel sinks until
measured.

To measure on Windows (the script produces the same `results.json` format):

```bat
pip install websockets numpy openpyxl pywin32 xlwings
python renderers\excel\native_test.py                    :: excel-com, all resolutions
python renderers\excel\native_test.py --sink excel-xlwings --quick
:: optional, same driver as this document (needs Node 22 + npm install):
python scripts\excel\bench_sinks.py --sinks excel-com --bridge-args "--workbook %TEMP%\sgs_bench.xlsx"
```

`native_test.py` first checks correctness in the real application (every
GAME cell read back - value for `values-cf`, `Interior.Color` for `interior`;
CF rule count; RULES!B3 recalculated by Excel from the defined names after
writing BaseBudget=2, AlertLevel=3, PoliceResponse=1.5 must be 9; no echo
after layout; a cell change is detected by the poller), then benchmarks both
strategies at 80x45 ... 480x270 for `full:pan`, `diff:pan` and `diff:drive`
through an in-process bridge and a Python game client (same scenes as the
Node client, quantised to the same fixed 64-colour palette). Output:
`renderers/excel/bench/results-native.json` with `"verified": true` rows.
The script was self-checked here with `--sink mock` and `--sink calc-uno`
(both PASS); it has not been run against Excel.

## Tests

```sh
scripts/excel/run_tests.sh
# = python3 -m unittest discover tests/excel        (90 tests, ~16 s, includes headless Calc)
#   node --import tsx --test tests/excel/*.test.ts   (9 tests, ~2 s, includes the Python bridge)
```

| Suite | Covers |
|---|---|
| `test_protocol.py` | Python decoder vs SGF1 fixtures produced by the TS encoder (`gen_fixtures.ts`): header, palette, runs, frame reconstruction; Python encoder byte-identical; malformed frames; fixture regeneration is deterministic |
| `test_planning.py` | spans, band cover property (random), exact colour partition (random), 255-char address chunks round trip, layout/names/normalisation |
| `test_state.py` | FrameState, EchoGuard (own writes, stale state, rejected edit revert, formula canonicalisation), StateSync with mock, VBA release timing, key mapping |
| `test_bridge_mock.py` | real WebSocket: TS fixture sequence to exact cells (both strategies), backpressure + coalescing, busy self-heal, frames before hello / size change, protocol errors, state/hud/sheet/telemetry, user and rule edits with echo suppression, INPUT polling, disconnect + reconnect, client replacement, wrong path |
| `test_calc_uno.py` | headless Calc: exact pixel to cell readback (values / CellBackColor) for all three strategies, CF entries, palette change, defined names + formula recalculation, edit/rule polling, save + reopen, full bridge over WebSocket |
| `test_workbook.py` | build_workbook output reopened with openpyxl (sheets, headers, names, 64 CF rules, prefilled frame) and recalculated by LibreOffice with non-default inputs |
| `test_excel_fake.py` | ComSink against the fake COM model (layout, frames, BGR, batching, busy, attach by signature) |
| `test_snapshot.py` | snapshot .xlsx fills equal pixels |
| `bridge-backend.test.ts` | backend vs a fake bridge (hello, keyframe, window/drops/re-diff exactness, edit/rule/input, resize, palette changes, state deltas/throttling, reconnect, ack timeout, bye) and end to end vs the Python bridge (exact cells after deliberate drops) |

## Contract notes and issues found

1. **`hello.keyBindings` (extension).** The contract's `controls` are
   human-readable only, so a bridge cannot map captured keys to game actions.
   The backend sends the optional `keyBindings` (`KeyboardEvent.code ->
   action`, as in `SpreadsheetGame.keyBindings`); the bridge falls back to
   Gridlock City's table. Suggest adding the field to `protocol.md`.
2. **Partial `state.values`.** The backend sends deltas (changed keys only)
   plus a full snapshot every 5 s and after (re)connect; `rules` only when
   changed. The bridge merges. Suggest stating "values may be partial" in the
   contract.
3. **No feedback for rejected edits.** `BackendInit.emitState` returns void,
   so `StudioHost.applyPatch`'s error text never reaches the spreadsheet; the
   bridge can only revert the cell after 1.5 s. Suggest `emitState` returning
   the errors and a bridge-bound `{"t":"editResult","key","ok","error"}`
   message (shown e.g. in GAME!A2 or a cell comment).
4. **Extra fields (backward compatible):** `ack.bytes`, `ack.busy`,
   `ack.coalesced`, `ack.merged`; `ready.width/height/origin/warnings/appVersion`
   (`excelVersion` is only set by the Excel sinks).
5. **`IndexedFrame.indices` is only valid until the next `process()` call**
   (FramePipeline double-buffers). Any backend that keeps frames must copy
   (this backend copies into its shadow). Worth a line in `frame.ts`.
6. **No keyframe request message** is needed: drops are handled by the
   backend shadow, sink failures by the bridge's dirty mask.
7. **Any hello rebuilds the workbook layout** (GAME, variable and RULES
   sheets), including after a resolution change. Variable cells briefly show
   defaults until the next `state` (<= 100 ms later). A resize-only hello
   could keep the other sheets; not done yet.
8. The contract's column width "0.58 char ~ 6 px" is used as-is for Excel
   `ColumnWidth` (unverified that it renders square); the openpyxl file uses
   0.85 OOXML units, which LibreOffice renders square (1.66 x 1.59 mm).

## Limitations

* Native Excel untested (see above). macOS xlwings is expected to be much
  slower and cannot create CF rules.
* All Calc numbers are headless; a visible Calc window adds repaint cost.
* VBA OnKey input is coarse (no key-up, single-key auto-repeat); prefer
  `--global-keys` for precise control.
* One game connection at a time (a new connection replaces the old one).
* The bridge owns GAME, variable, RULES, TELEMETRY, INPUT and `_SGS` sheets
  and rewrites them on hello; other sheets in the workbook are left alone.
