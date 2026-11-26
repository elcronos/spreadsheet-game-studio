// Minimal static file server for local play and tests: node scripts/serve.mjs [dir] [port]
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(process.argv[2] ?? "dist");
const port = parseInt(process.argv[3] ?? "8080", 10);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".bas": "text/plain", ".md": "text/markdown" };
http.createServer(async (req, res) => {
  try {
    let p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!p.startsWith(root)) throw new Error("forbidden");
    if ((await stat(p)).isDirectory()) p = path.join(p, "index.html");
    const body = await readFile(p);
    res.writeHead(200, { "content-type": types[path.extname(p)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
