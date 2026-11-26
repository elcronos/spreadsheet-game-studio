---
name: google-sheets-port
description: Port a game made with Spreadsheet Game Studio (or its Excel workbook) to Google Sheets, as a turn-based edition that works in the Sheets phone app or a real-time sidebar edition, then install and test it in a real sheet. Use when asked to bring a studio game to Google Sheets or Google Drive.
---

# Google Sheets port

Takes a game built with the `spreadsheet-game-studio` skill and makes it playable in Google
Sheets. The game stays the same code; the port adds an Apps Script layer that paints the
GAME tab and reads player edits back.

Repo: <https://github.com/elcronos/spreadsheet-game-studio>. Clone it (or use the copy you
already have) and work from its root. Full details: `references/google-sheets.md`.

## 1. Pick the edition

Ask only if the request doesn't say. Default to **turn** when players will use phones or the
person says "anyone can play".

* **turn**: runs inside Apps Script, one move per tap (about 2 s), works in the Sheets phone app,
  no permission prompt for players. Needs a DOM-free `renderCells` (raster2d style). Three.js
  or other WebGL games cannot use it.
* **sidebar**: real time in a desktop sidebar, any game including WebGL, about 1 to 3 sheet
  updates per second. No phones.
* **both** when in doubt and the game supports turns.

An Excel workbook from the studio (`scripts/excel/build_workbook.py`) can be uploaded to
Drive and converted, but that only brings the sheets and formulas across as a static
snapshot: the bridge and VBA don't run in Google Sheets. To make it playable, port the
game's source with the steps below.

## 2. Make the game portable (turn edition only)

If the game has no `turn` field, add one (`engines/core/game.ts`, example in
`examples/cell-catch/game.ts`): a short list of controls (an input action held for some
seconds, a wait, or a command) plus `save()` and `load()` for the simulation state. The
variable registry and RNG are saved for you. Keep labels to words or ← ↑ ↓ →.

Write a custom session instead (`examples/fieldbook/turn.ts`) when a tap should do something
smarter, such as walking exactly one tile. Apply the repaint rules from the reference: a dead
zone camera and stepped lighting, so a tap changes hundreds of cells rather than all of them.

## 3. Build

```
node scripts/gsheets-port.mjs --game <module> --mode turn|sidebar|both --out dist/gsheets-<id>
```

`<module>` exports a game factory (`createGame` or default) or a `TurnApp`. Output:
`Code.gs` (plus `Sidebar.html` for sidebar) and an `INSTALL.md` written for players.

## 4. Test before installing

* Add the game to `tests/gsheets/port.test.ts` (copy the Cell Catch case): setup builds every
  tab, a tap changes the state, the GAME cells match the recorded frame. `useCode()` points
  the fake spreadsheet at the new build.
* `npm run test:gsheets`. The fake throws on any Apps Script method it doesn't implement, so a
  typo fails here instead of in a real sheet.

## 5. Install in a real sheet

1. Create the spreadsheet (Drive connector `create_file`, type
   `application/vnd.google-apps.spreadsheet`) or use the person's.
2. The script must be pasted into Extensions > Apps Script; no API reaches the bound script
   editor. If you can drive the person's browser: upload `Code.gs` to Drive as text, open its
   preview, select the `<pre>` contents, copy with a real key press, paste into the editor,
   check length and hash against the build, save. Otherwise send `Code.gs` and `INSTALL.md`.
3. Turn edition: type into any cell. The first edit builds the game (about 15 s) with no
   authorisation prompt. Sidebar edition: reload, then menu > Play (owner authorises once).
4. Tap a few controls and read **Apps Script > Executions**: each tap logs a JSON line with
   load, play, render and write times. Report the measured numbers, not estimates.

## 6. Share

Viewers can't run scripts. Share as Anyone with the link: Viewer and hand out the
`.../copy` link so each player gets their own copy, script included.

## Report honestly

* Say which edition, the measured tap time, and what wasn't verified (for example the `/copy`
  link on a phone).
* If colours look wrong on a phone, it's almost always dark mode recolouring cells.
