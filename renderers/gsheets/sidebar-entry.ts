/**
 * Generic sidebar (real-time) entry for the Google Sheets port: builds the
 * buttons from the game's own touch buttons, key bindings and commands, then
 * boots the game when the player presses Start. The build calls
 * startSidebar(createGame) from a generated entry file.
 */
import type { SpreadsheetGame } from "../../engines/core/game";
import { bootSidebar, Transport } from "./client";

declare const google: { script: { run: any } };

const call: Transport = (fn, arg) =>
  new Promise((resolve, reject) => {
    google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[fn](arg);
  });

function button(label: string, attr: string, value: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.setAttribute(attr, value);
  b.setAttribute("aria-label", label);
  return b;
}

export function startSidebar(createGame: () => SpreadsheetGame): void {
  const root = document.getElementById("app")!;
  const probe = createGame();
  const actions = new Set(Object.values(probe.keyBindings));
  const pad = root.querySelector(".pad")!;
  if (["up", "down", "left", "right"].every((a) => actions.has(a))) {
    pad.append(document.createElement("span"), button("↑", "data-action", "up"), document.createElement("span"), button("←", "data-action", "left"), button("↓", "data-action", "down"), button("→", "data-action", "right"));
  } else if (actions.has("left") && actions.has("right")) {
    pad.append(button("←", "data-action", "left"), document.createElement("span"), button("→", "data-action", "right"));
  }
  const acts = root.querySelector(".acts")!;
  for (const t of probe.touchButtons) if (!["up", "down", "left", "right"].includes(t.action)) acts.append(button(t.label, "data-action", t.action));
  const cmds = root.querySelector(".cmds")!;
  for (const c of probe.commands) cmds.append(button(c.label, "data-command", c.id));
  root.querySelector(".keys")!.textContent = "Keyboard (click this panel first): " + probe.controls.map(([k, d]) => `${k} ${d}`).join(" · ");

  const sel = root.querySelector(".res") as HTMLSelectElement;
  const start = root.querySelector(".start") as HTMLButtonElement;
  start.addEventListener("click", async () => {
    start.style.display = "none";
    const [w, h] = sel.value.split("x").map(Number);
    sel.disabled = true;
    try {
      await bootSidebar({ createGame, call, root, width: w, height: h });
    } catch (e) {
      const s = root.querySelector(".status")!;
      s.textContent = "Could not start: " + ((e as Error)?.message ?? e);
      s.className = "status err";
    }
  });
}
