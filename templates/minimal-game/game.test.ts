import { test } from "node:test";
import assert from "node:assert/strict";
import { StudioHost } from "../../engines/core/host";
import { createGame } from "./game";

test("__GAME_ID__ runs headless, renders cells and reacts to sheet edits", async () => {
  const game = createGame();
  const host = new StudioHost(game, { width: 80, height: 45 });
  await host.init({ appendChild() {} } as unknown as HTMLElement);
  for (let i = 0; i < 120; i++) game.step(1 / 60);
  const out = new Uint8Array(80 * 45 * 4);
  game.renderCells(80, 45, out);
  const { frame } = host.pipeline.process(out);
  assert.ok(new Set(frame.indices).size > 2, "frame has content");
  const before = host.registry.rule("SpawnPerSecond");
  assert.deepEqual(host.applyPatch({ "rule:SpawnPerSecond": "=Level*5" }), {});
  assert.ok(host.registry.rule("SpawnPerSecond") > before);
  assert.ok(host.applyPatch({ "play.speed": "fast" })["play.speed"], "invalid value rejected");
});
