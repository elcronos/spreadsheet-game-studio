import * as esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";
await mkdir("dist/quayside", { recursive: true });
await cp("examples/quayside/data/ground.png", "dist/quayside/ground.png");
await cp("examples/quayside/dev/view.html", "dist/quayside-view.html");
await esbuild.build({ entryPoints: ["examples/quayside/dev/view.ts"], bundle: true, format: "esm", target: "es2022", outfile: "dist/quayside-view.js", minify: false, logLevel: "warning" });
console.log("built dist/quayside-view.html");
