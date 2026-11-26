// Scaffold a new game from templates/minimal-game: node scripts/new-game.mjs <id> ["Title"]
import { mkdir, readFile, writeFile } from "node:fs/promises";
const [id, title = id] = process.argv.slice(2);
if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) {
  console.error("usage: node scripts/new-game.mjs <kebab-id> [\"Title\"]");
  process.exit(1);
}
const cls = id.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase()) + "Game";
const dir = `examples/${id}`;
await mkdir(dir, { recursive: true });
for (const f of ["game.ts", "game.test.ts"]) {
  const src = (await readFile(`templates/minimal-game/${f}`, "utf8")).replaceAll("__GAME_ID__", id).replaceAll("__TITLE__", title).replaceAll("TemplateGame", cls).replaceAll("../../engines", "../../engines");
  await writeFile(`${dir}/${f}`, src);
}
console.log(`Created ${dir}/game.ts and ${dir}/game.test.ts.
Next: add it to examples/app/main.ts (GAMES + factory), then:
  node --import tsx --test ${dir}/game.test.ts && npm run build && npm run serve`);
