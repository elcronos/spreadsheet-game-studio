// Build the browser version into dist/: node scripts/build.mjs [--watch]
import * as esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await cp("web/index.html", "dist/index.html");
await mkdir("dist/quayside", { recursive: true });
await cp("examples/quayside/data/ground.png", "dist/quayside/ground.png");
const opts = { entryPoints: ["examples/app/main.ts"], bundle: true, format: "esm", target: "es2022", outfile: "dist/app.js", minify: true, sourcemap: false, legalComments: "eof", logLevel: "info" };
if (process.argv.includes("--watch")) (await esbuild.context(opts)).watch();
else await esbuild.build(opts);
