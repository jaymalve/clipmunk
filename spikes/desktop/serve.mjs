// Serves the two desktop spikes on http://localhost:4747 and saves posted results to results.json.
// Run: node serve.mjs   (no dependencies)
import http from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const dir = new URL(".", import.meta.url);
const port = Number(process.env.PORT ?? 4747);
const pages = { "/cursor": "cursor.html", "/dof": "dof.html" };
const index = `<body style="font:16px system-ui;max-width:40em;margin:3em auto"><h1>Flick desktop spikes</h1>
<p>Use desktop Chrome. Run both; each posts its result back automatically.</p>
<p><a href="/cursor">1. Cursor capture test</a> (about 30 seconds, needs you to move the mouse)</p>
<p><a href="/dof">2. Depth-of-field performance test</a> (about 40 seconds, hands off)</p>`;
http.createServer((req, res) => {
  const path = req.url.split("?")[0];
  if (req.method === "POST" && path === "/result") {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      const file = new URL("results.json", dir);
      const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
      all.push({ at: new Date().toISOString(), ...JSON.parse(body) });
      writeFileSync(file, JSON.stringify(all, null, 1));
      console.log("saved result:", JSON.parse(body).test);
      res.end("ok");
    });
    return;
  }
  if (path === "/") return res.setHeader("content-type", "text/html").end(index);
  if (pages[path]) return res.setHeader("content-type", "text/html").end(readFileSync(new URL(pages[path], dir)));
  res.writeHead(404).end();
}).listen(port, "127.0.0.1", () => console.log(`Open http://localhost:${port} in desktop Chrome`));
