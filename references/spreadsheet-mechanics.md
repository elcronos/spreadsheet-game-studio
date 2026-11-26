# Spreadsheet mechanics: variables, rules, sheets

## Variables (`engines/core/variables.ts`)

```ts
{ key: "veh.sports.maxSpeed", sheet: "VEHICLES", label: "Sports car: max speed",
  name: "SportsMaxSpeed", type: "number", default: 187, min: 10, max: 400, unit: "km/h" }
```

- `sheet` decides the worksheet. Every distinct sheet name becomes a tab in the
  browser and a worksheet in the native workbook (header row: Variable, Value,
  Min, Max, Unit, Description, Defined name).
- `name` makes the variable usable in formulas and becomes a workbook defined
  name pointing at its Value cell, so `=BaseBudget*AlertLevel` works in Excel too.
- `live: true` marks values the simulation writes (position, health, time of
  day). They stay editable unless `readOnly`; editing a live value is how the
  player teleports, heals or changes the clock.
- Types: `number`, `int`, `bool` (TRUE/FALSE), `enum` (`options`), `text`.
- The game reads values every step (`registry.num/str/bool`). Cache derived
  values only if you clear the cache in `registry.onChange`.
- `registry.edit()` validates (type, range, options) and returns an error
  message; nothing invalid reaches the simulation. `setLive()` is the
  simulation's own clamped write.

## Rules

```ts
{ name: "PoliceBudget", formula: "=ROUND(BaseBudget*AlertLevel*PoliceResponse, 0)", min: 0, max: 14,
  description: "Police cars allowed in a pursuit" }
```

- Excel-compatible subset: numbers, strings, `+ - * / ^ &`, comparisons,
  `MIN MAX ABS SQRT ROUND FLOOR CEILING INT POWER MOD SIN COS PI AVERAGE SUM
  MEDIAN IF AND OR NOT`, names of variables and other rules.
- Safety: no property access, no host functions, 400-character and depth
  limits, unknown names rejected at edit time, cycles rejected, results
  clamped to `[min, max]`, runtime errors (`#DIV/0!`, `#NUM!`) keep the last
  good value and are shown in the sheet.
- Text and enum variables compare as strings: `=IF(Weather="Rain", 0.7, 1)`.
- Rules recompute on every user edit. If they depend on values the game
  changes itself, call `registry.recomputeRules()` on a cadence (Gridlock City:
  twice a second).
- Design rules around the questions players will want to ask: "what if the
  police were twice as aggressive?", "what if traffic tripled at rush hour?".
  Each rule should drive one visible behaviour.

## Custom sheets

`customSheets: [{ name: "MISSIONS", columns: [...], rows: () => [...] }]` for
read-mostly tables (missions, orders, inventory). Row `style` can be
`active`, `done`, `failed`, `muted`, `header`.

## The GAME sheet

- Rows 1-3: HUD (stats, objective/banner and hint, range description).
- Frame cells from A4: cell value = palette index, fill = palette colour.
- Editing a frame cell to another palette index repaints that cell until the
  renderer next changes it - a direct demonstration that the picture is cells.

## Native workbook

`scripts/excel/build_workbook.py manifest.json out.xlsx` builds the same
layout with real formulas, defined names and per-palette conditional formats.
The bridge syncs values both ways (`references/excel-backend.md`).
