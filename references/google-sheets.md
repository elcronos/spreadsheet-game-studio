# Google Sheets backend

Two editions, built from the same game by `scripts/gsheets-port.mjs`.

| | Turn edition (`--mode turn`) | Sidebar edition (`--mode sidebar`) |
|---|---|---|
| Where the game runs | Inside the spreadsheet's Apps Script | In an HtmlService sidebar (a browser iframe) |
| Phone (Sheets app) | Yes | No, the app has no sidebars |
| Feel | One move per tap, about 2 s per tap | Real time, about 1 to 3 sheet updates per second |
| Permission prompt | None for players (simple triggers only) | Owner authorises once |
| Needs | `turn` support or a custom `TurnApp`, DOM-free `renderCells` | Any game (WebGL works in the sidebar) |
| Files | `Code.gs` | `Code.gs` + `Sidebar.html` |

## How the turn edition works

`renderers/gsheets/turn/app.ts` (`createTurnApp`) builds a GAME tab: two text rows, a row of
labels, a row of checkboxes, then one cell per pixel with gridlines hidden. Each checkbox tap
fires the `onEdit` simple trigger:

1. Load the saved game: `CacheService` document cache first (tens of ms), the hidden `_STATE`
   tab as backup (written every 4th tap, and always on edits, because the cache expires after
   6 hours).
2. `app.create(saved)` rebuilds the session, `play(id)` advances the game.
3. `render()` returns W*H hex colours; `changedRects` turns the difference from the last
   painted frame into at most 12 rectangles, each one `setBackgrounds` call.
4. Variable tabs, RULES values and custom sheets are rewritten only when they changed.
5. The checkbox is set back to FALSE (an untick also counts as a press, so fast taps work).

A `LockService` document lock serialises overlapping taps. `layout` in the save makes a copy
built by an older version rebuild itself on its next tap.

## Making a game portable

Simplest: add `turn` to the game (see `engines/core/game.ts` and `examples/cell-catch/game.ts`):

```ts
readonly turn: TurnSupport = {
  controls: [
    { id: "left", label: "←", action: "left", hold: 0.35, after: 0.15 },
    { id: "wait", label: "Wait", after: 0.5 },
    { id: "reset", label: "Reset", command: "reset" },
  ],
  save: () => ({ x: this.x, drops: this.drops }),
  load: (s) => Object.assign(this, s),
};
```

`turnAppFromGame` then gives a working edition with no other glue. Write a custom session
(`examples/fieldbook/turn.ts`) when taps should mean something smarter than "hold a key":
Fieldbook walks exactly one tile per tap and turns before walking.

## Measured on real Google Sheets (Fieldbook, 160x90, Nov 2026)

* Setup: 14 to 15 s (one execution, about 56 API calls).
* Tap: 1.7 to 3.1 s end to end in the Executions log. Our code: load 0.3 to 0.6 s, simulate
  about 0.1 s, render 0.1 to 0.2 s, queue writes 0.2 to 0.3 s. The rest is Apps Script start up
  and the final flush, which a script cannot remove.
* The phone app adds its own sync delay on top.

## Lessons that cost real time

* **Repaint as little as possible.** A camera that follows the player repaints most of the
  frame every step. Use a dead zone (scroll only near the edge of the view).
* **Lighting that changes every step repaints every cell.** Quantise time of day (Fieldbook
  draws daylight in half hour steps).
* **Don't average pixels.** 160x90 art squeezed into 80x45 cells turns muddy. Render at the
  art's own resolution, one cell per pixel.
* **Hide gridlines** (`setHiddenGridlines(true)`): at 4 px per cell they wash the picture out.
* **Dark mode recolours cells** in the Sheets phone apps. Scripts cannot detect or override it;
  tell players to use View in light theme.
* **Some phones draw ◀ ▶ as emoji.** Use ← ↑ ↓ → or words for labels.
* **Simple triggers can't use authorised services** (no DriveApp, UrlFetch, menus on phones).
  SpreadsheetApp on the bound file, CacheService and LockService are fine.
* **Viewers can't play.** Scripts never run for view-only users. Share a `/copy` link so each
  player gets a copy with the script inside.
* **setRowHeights won't go below the text height**; use `setRowHeightsForced`.
* **Chunk big saves** (40k characters per cell) and prefix each chunk with `|` so Sheets never
  reads it as a number or formula.
* **Named ranges**: wrap `setNamedRange` in try/catch; the game still evaluates its own rules if
  Sheets refuses a name.

## Installing for someone

The script editor can't be reached through the Drive or Sheets APIs, so the code has to be
pasted once into Extensions > Apps Script. If you can drive the person's browser, the path
that worked: upload `Code.gs` to Drive as a text file, open its Drive preview, select the
`<pre>` contents and copy with a real key press, then paste into the Apps Script editor (Monaco)
and save. Check the pasted text by length and hash against the build before saving. Then type
into any cell to build the game without an authorisation prompt.

## Tests

* `tests/gsheets/fake-gas.ts`: an in-memory spreadsheet implementing only the Apps Script methods
  the editions call (anything else throws), run in a fresh VM per trigger like Apps Script.
* `tests/gsheets/phone.test.ts`: Fieldbook turn edition, end to end.
* `tests/gsheets/port.test.ts`: the template game ported with no game-specific glue.
* `tests/gsheets/gsheets.test.ts` + `e2e.mjs`: the sidebar edition in headless Chrome with
  `google.script.run` routed to the fake.
