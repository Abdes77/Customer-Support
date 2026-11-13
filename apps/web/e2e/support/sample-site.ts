/**
 * A sample business website for `pnpm e2e`, served twice: on the origin the widget allows
 * and on one it does not. The page embeds the widget exactly as a business would, with the
 * snippet from the admin panel.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { APP_URL, type E2eState, OTHER_SITE_PORT, SITE_PORT, STATE_FILE } from "./config";

function page(): string {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2eState;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Summit Roofing Co. | Denver roof repair and replacement</title>
<style>
  body { margin: 0; font-family: Georgia, serif; color: #1f2937; background: #f8fafc; }
  header { background: #0f172a; color: #fff; padding: 24px 32px; }
  main { max-width: 760px; margin: 0 auto; padding: 32px; line-height: 1.6; }
  section { min-height: 60vh; }
  /* Host styles that must not leak into the widget. */
  button { background: hotpink !important; font-size: 30px !important; }
  div { letter-spacing: 3px; }
</style>
</head>
<body>
<header><h1>Summit Roofing Co.</h1><p>Family-owned roofers serving the Denver area since 1998.</p></header>
<main>
  <section>
    <h2>Roof repair, replacement and storm damage</h2>
    <p>Leaks, missing shingles, hail damage: we inspect for free and give you a written estimate.</p>
  </section>
  <section><h2>Why homeowners choose us</h2><p>Licensed, insured, and on time.</p></section>
</main>
<script src="${APP_URL}/api/widget/v1/widget.js" data-key="${state.widgetKey}" async></script>
</body>
</html>`;
}

for (const port of [SITE_PORT, OTHER_SITE_PORT]) {
  createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    try {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page());
    } catch {
      response.writeHead(503, { "content-type": "text/plain" }).end("The app server is not ready.");
    }
  }).listen(port, "127.0.0.1");
}
