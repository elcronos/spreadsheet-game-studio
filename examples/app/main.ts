/**
 * Browser entry: opens a workbook (game) in the Cellframe shell.
 *   #gridlock (default)  Gridlock City - 3D open-world driving
 *   #fieldbook           Fieldbook - 2D farming & market sim
 * Query options: ?res=320x180  ?mode=3d|sheet|grid|editor  ?bloom=0  ?shadows=0  ?bridge=ws://…  ?autostart=1
 */
import { StudioHost } from "../../engines/core/host";
import type { SpreadsheetGame } from "../../engines/core/game";
import { SheetApp, Mode } from "../../renderers/sheet-canvas/shell";
import { bridgeUrlFromLocation } from "../../renderers/excel/ExcelBridgeBackend";
import { GridlockCity } from "../gridlock-city/src/game";
import { createFieldbook } from "../fieldbook/game";

const GAMES = [
  { id: "gridlock-city", label: "Gridlock City.cfx", hash: "gridlock" },
  { id: "fieldbook", label: "Fieldbook.cfx", hash: "fieldbook" },
];

async function boot(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const which = location.hash.replace("#", "") === "fieldbook" ? "fieldbook" : "gridlock";
  const coarse = matchMedia("(pointer: coarse)").matches;
  const game: SpreadsheetGame =
    which === "fieldbook" ? createFieldbook() : new GridlockCity({ bloom: q.get("bloom") !== "0", shadows: q.get("shadows") !== "0" && !coarse, pixelRatio: coarse ? 1 : Math.min(devicePixelRatio || 1, 1.5) });
  const [rw, rh] = (q.get("res") ?? "160x90").split("x").map(Number);
  const host = new StudioHost(game, { width: rw, height: rh, quantize: { mode: which === "fieldbook" ? "fixed256" : "adaptive" } });
  const view = document.createElement("div");
  view.style.cssText = "position:absolute;inset:0";
  document.body.appendChild(view);
  await host.init(view);
  const app = new SheetApp({
    host,
    game,
    root: document.body,
    view3d: view,
    fileName: GAMES.find((g) => g.id === game.id)?.label ?? game.title,
    games: GAMES.map((g) => ({ id: g.id, label: g.label })),
    onSwitchGame: (id) => {
      location.hash = GAMES.find((g) => g.id === id)!.hash;
      location.reload();
    },
    setGameHud: (v) => (game as unknown as { setHudVisible?: (v: boolean) => void }).setHudVisible?.(v),
  });
  const mode = q.get("mode") as Mode | null;
  if (mode) app.setMode(mode);
  const bridge = bridgeUrlFromLocation(location.search);
  if (bridge) await app.connectBridge(bridge);
  document.getElementById("boot")?.remove();
  if (q.get("autostart") !== "0") await app.start();
  Object.assign(window as unknown as Record<string, unknown>, { host, game, app, ready: true });
}

window.addEventListener("hashchange", () => location.reload());
boot().catch((e) => {
  const b = document.getElementById("boot");
  if (b) b.textContent = "Could not open the workbook: " + (e as Error).message;
  console.error(e);
});
