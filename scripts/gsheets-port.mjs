#!/usr/bin/env node
/**
 * Port a Spreadsheet Game Studio game to Google Sheets.
 *
 *   node scripts/gsheets-port.mjs --game examples/fieldbook/turn.ts --mode turn --out dist/gsheets-phone
 *   node scripts/gsheets-port.mjs --game examples/fieldbook/game.ts --mode sidebar --out dist/gsheets
 *   node scripts/gsheets-port.mjs --game examples/cell-catch/game.ts --mode both --out dist/gsheets-cell-catch
 *
 * --game     a module exporting a TurnApp (default export with `create` and `layout`), or
 *            a game factory (default export or createGame) / game class instance factory.
 * --mode     turn    : turn-based edition, game runs in Apps Script, works in the Sheets phone app.
 *                      Needs `turn` support (or a custom TurnApp) and a DOM-free renderCells.
 *            sidebar : real-time edition, game runs in a sidebar (desktop browser only).
 *            both    : both, in <out>/turn and <out>/sidebar.
 * --size     WxH for the turn edition (default 160x90), sidebar offers 80x45 and 160x90.
 * --title    name for the menu (default: the game's title).
 *
 * Output: Code.gs (turn) or Code.gs + Sidebar.html (sidebar), plus INSTALL.md.
 */
import * as esbuild from "esbuild";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({ options: { game: { type: "string" }, mode: { type: "string", default: "turn" }, out: { type: "string" }, size: { type: "string", default: "160x90" }, title: { type: "string" } } });
if (!a.game || !a.out) {
  console.error("usage: node scripts/gsheets-port.mjs --game <module> --mode turn|sidebar|both --out <dir> [--size 160x90] [--title Name]");
  process.exit(2);
}
const root = process.cwd();
const gameAbs = resolve(a.game);
const [sw, sh] = a.size.split("x").map(Number);
await mkdir(join(root, ".build"), { recursive: true });
const rel = (p) => "./" + relative(join(root, ".build"), p).replaceAll("\\", "/");

async function bundle(entrySource, name, globalName) {
  const entry = join(root, ".build", name);
  await writeFile(entry, entrySource);
  const r = await esbuild.build({ entryPoints: [entry], bundle: true, format: "iife", globalName, target: "es2017", minify: true, write: false, legalComments: "none", charset: "utf8" });
  return r.outputFiles[0].text;
}

const pick = `const M: any = Game;
const isApp = (x: any) => x && typeof x === "object" && typeof x.create === "function" && typeof x.layout === "string";
const factory = (): any => {
  const f = M.createGame ?? (typeof M.default === "function" ? M.default : undefined) ?? Object.values(M).find((v: any) => typeof v === "function" && /^create/.test(v.name ?? ""));
  if (!f) throw new Error("no game factory export found (export default or createGame)");
  return f.prototype && f.prototype.step ? new f() : f();
};`;

async function buildTurn(outDir) {
  const src = `import * as Game from ${JSON.stringify(rel(gameAbs))};
import { createTurnApp } from ${JSON.stringify(rel(join(root, "renderers/gsheets/turn/app.ts")))};
import { turnAppFromGame } from ${JSON.stringify(rel(join(root, "renderers/gsheets/turn/kit.ts")))};
${pick}
const app = isApp(M.default) ? M.default : isApp(M.turnApp) ? M.turnApp : turnAppFromGame(factory, { width: ${sw}, height: ${sh} });
${a.title ? `app.title = ${JSON.stringify(a.title)};` : ""}
const T = createTurnApp(app);
export const onEdit = T.onEdit, onOpen = T.onOpen, setup = T.setup, title = app.title;
`;
  const js = await bundle(src, "turn-entry.ts", "SGS");
  const title = a.title ?? (await titleOf("turn"));
  const header = `/**
 * ${title}: turn-based Google Sheets edition, built with Spreadsheet Game Studio.
 * Paste this whole file into Extensions > Apps Script (replacing Code.gs) and save.
 * Then type anything into any cell (or use the ${title} menu > Set up) and play
 * by tapping the boxes on the GAME tab, on a computer or in the Sheets phone app.
 */
function onOpen(e) { SGS.onOpen(e); }
function onEdit(e) { SGS.onEdit(e); }
function setupGame() { SGS.setup(); }
`;
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "Code.gs"), header + js);
  await writeFile(join(outDir, "INSTALL.md"), installTurn(title));
  console.log(`${outDir}/Code.gs  ${(js.length / 1024).toFixed(0)} KB  (turn edition of ${title})`);
}

async function buildSidebar(outDir) {
  const src = `import * as Game from ${JSON.stringify(rel(gameAbs))};
import { startSidebar } from ${JSON.stringify(rel(join(root, "renderers/gsheets/sidebar-entry.ts")))};
${pick}
startSidebar(factory);
`;
  const js = (await bundle(src, "sidebar-entry.ts", "SGSUI")).replace(/<\/script/gi, "<\\/script");
  const title = a.title ?? (await titleOf("sidebar"));
  const tpl = await readFile(join(root, "renderers/gsheets/Sidebar.template.html"), "utf8");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "Sidebar.html"), tpl.replaceAll("__TITLE__", title).replace("/*__BUNDLE__*/", () => js));
  await writeFile(join(outDir, "Code.gs"), (await readFile(join(root, "renderers/gsheets/Code.gs"), "utf8")).replaceAll("__TITLE__", title));
  await writeFile(join(outDir, "INSTALL.md"), installSidebar(title));
  console.log(`${outDir}/Sidebar.html  ${(js.length / 1024).toFixed(0)} KB  (sidebar edition of ${title})`);
}

async function titleOf() {
  const src = `import * as Game from ${JSON.stringify(rel(gameAbs))};
${pick}
export const t = isApp(M.default) ? M.default.title : isApp(M.turnApp) ? M.turnApp.title : factory().title;`;
  const js = await bundle(src, "title-entry.ts", "T");
  const ctx = {};
  new Function("globalThis", "window", "document", js + "; return T;")(ctx, undefined, undefined);
  return new Function(js + "; return T.t;")();
}

function installTurn(title) {
  return `# ${title}: turn-based Google Sheets edition

The whole game runs inside the spreadsheet's own script. Play on the **GAME** tab by tapping
the boxes. Works in the Google Sheets phone app and in a browser. Each tap is one move
(about 2 seconds on Google's servers).

## Set up (once, on a computer)
1. Open a Google Sheet, then **Extensions > Apps Script**.
2. Replace everything in \`Code.gs\` with this \`Code.gs\` and click **Save**.
3. Back in the sheet, type anything into any cell. The first edit builds the game (about 15 s).
   No permission prompt appears, because only simple triggers are used.

## Let anyone play
Share the sheet as **Anyone with the link: Viewer** and send the link with \`/edit...\` replaced by
\`/copy\`. Each player gets their own copy, script included. Viewers can't play in the original,
because scripts never run for view-only users.

## Notes
* Phones in dark mode recolour cells. Use **View in light theme** in the Sheets app for true colours.
* Edit values on the variable tabs or formulas in RULES while you play. Bad values are rejected.
* Free Google accounts get about 90 minutes of script time per day, which is a few thousand taps.
`;
}
function installSidebar(title) {
  return `# ${title}: real-time Google Sheets edition (desktop)

The game runs in a sidebar and paints the **GAME** sheet as you play. Needs a desktop browser,
because the Sheets phone app has no sidebars.

1. Open a Google Sheet, then **Extensions > Apps Script**.
2. Replace \`Code.gs\` with this \`Code.gs\`. Add an HTML file named \`Sidebar\` and paste in \`Sidebar.html\`.
3. Save, reload the sheet, and choose **${title} > Play**. Google asks you to authorise the script once.
4. Pick a size and press **Start**. Click the sidebar before using the keyboard.
`;
}

if (a.mode === "turn") await buildTurn(resolve(a.out));
else if (a.mode === "sidebar") await buildSidebar(resolve(a.out));
else if (a.mode === "both") {
  await buildTurn(resolve(a.out, "turn"));
  await buildSidebar(resolve(a.out, "sidebar"));
} else {
  console.error("--mode must be turn, sidebar or both");
  process.exit(2);
}
