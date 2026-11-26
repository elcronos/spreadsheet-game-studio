# SGF1 bridge protocol and workbook layout contract

Out-of-process spreadsheet renderers (native Excel, LibreOffice Calc, recorders)
connect to the running game over one WebSocket. The game is the client; the
bridge listens on `ws://127.0.0.1:8765/sgs` by default.

## Messages

Binary frames are SGF1 cell frames (`renderers/framebuffer/protocol.ts`).
Text frames are JSON objects with a `t` field.

### Game -> bridge

| t | fields | when |
|---|---|---|
| `hello` | `game`, `title`, `width`, `height`, `origin:{col,row}`, `palette:[0xRRGGBB…]`, `paletteMode`, `variables:[VariableDef]`, `rules:[RuleDef]`, `sheets:[{name, columns}]`, `controls:[[keys,desc]]` | once after connect, and after resolution/palette-mode change |
| binary SGF1 | see below | at most `window` frames un-acked (default 1) |
| `state` | `values:{key:value}`, `rules:[{name,formula,value,error?}]` | ≤10 Hz |
| `hud` | `stats:[[label,value]]`, `objective`, `banner?`, `hint?`, `meter?` | ≤5 Hz |
| `sheet` | `name`, `columns`, `rows:[{cells, style?}]` | ≤2 Hz, custom sheets such as MISSIONS |
| `telemetry` | flat `{metric: number|string}` | ≤2 Hz |
| `bye` | - | game shutting down |

### Bridge -> game

| t | fields | meaning |
|---|---|---|
| `ready` | `sink`, `strategy`, `excelVersion?` | bridge attached to a workbook |
| `ack` | `frameId`, `applyMs`, `cells`, `calls` | frame applied; game may send the next one (backpressure) |
| `edit` | `key`, `value` | user edited a variable cell |
| `rule` | `name`, `formula`, `value` | user edited a rule formula; `value` is the spreadsheet's own computed result |
| `input` | `action`, `down` | key captured by the bridge (OnKey macro or global key hook) |
| `error` | `message` | non-fatal bridge error |

## SGF1 binary frame

Little-endian. Header 24 bytes, then optional palette, then runs.

```
0  "SGF1"            magic
4  u32 frameId
8  u16 width          10 u16 height
12 u8 flags           bit0 keyframe, bit1 palette present
13 u8 reserved
14 u16 paletteCount   16 u32 paletteVersion
20 u32 runCount
24 palette RGB triplets (paletteCount*3 bytes)
.. runs: u16 row, u16 x0, u16 length, u8[length] palette indices
```

Row/column are 0-based framebuffer coordinates. The bridge adds the GAME
origin to address worksheet cells. A palette is sent with every keyframe and
whenever `paletteVersion` changes; the bridge must keep the last palette.

## Workbook layout

| Sheet | Layout |
|---|---|
| GAME | Rows 1-3: HUD (row 1 stats, row 2 objective, row 3 spacer). Frame cells start at **A4** (`origin = {col:0,row:3}`), one cell per pixel. Columns sized square (≈ 0.58 char width ≈ 6 px; rows 4.5 pt). |
| PLAYER, VEHICLES, WORLD (any variable sheet) | Header row 1: `Variable, Value, Min, Max, Unit, Description, Key`. One variable per row from row 2. Column B holds the editable value. When a variable has a `name`, a workbook defined name of that name refers to its B cell. |
| RULES | Header row 1: `Rule, Formula (live), Value, Min, Max, Description`. Column B holds a real spreadsheet formula (`=BaseBudget*AlertLevel`); defined name `<Rule>` refers to B. Column C mirrors the value the game is using. |
| MISSIONS | Written from `sheet` messages. |
| TELEMETRY | Two columns, metric and value, written from `telemetry` messages. |

Palette-indexed rendering strategy: GAME cells may hold the palette index as
a number, with one conditional-format rule per palette entry (`=A4=17` → fill
`#RRGGBB`) applied to the frame range, so frames become bulk value writes.
The alternative strategy sets `Interior.Color` directly, grouping cells of the
same colour into multi-area ranges. Bridges benchmark both and pick per sink.
