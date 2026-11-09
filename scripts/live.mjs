// One command for the owner's real setup: web app + worker + ngrok, in one window.
//
//   npm run live         dev server (reloads on every saved change; for reviewing changes)
//   npm run live:prod    production build, then start (faster; for everyday use)
//
// Ctrl+C stops all three. The ngrok domain is never committed: it comes from NGROK_DOMAIN in
// .env.local, else the host of PLAID_REDIRECT_URI / PLAID_WEBHOOK_URL. Port: LIVE_PORT (default 3001).
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const env = {};
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env.local: demo mode, no ngrok domain */ }

const host = (u) => { try { return new URL(u).host; } catch { return ""; } };
// NGROK_DOMAIN=off (shell or .env.local) runs without ngrok
const domainSetting = process.env.NGROK_DOMAIN || env.NGROK_DOMAIN;
const domain = domainSetting === "off" ? "" : domainSetting || host(env.PLAID_REDIRECT_URI) || host(env.PLAID_WEBHOOK_URL);
const port = env.LIVE_PORT || "3001";
const prod = process.argv.includes("--prod");
const win = process.platform === "win32";

const COLORS = { web: 36, worker: 35, ngrok: 33 };
const tag = (name) => `\x1b[${COLORS[name]}m${name.padEnd(6)}\x1b[0m | `;
const say = (msg) => console.log(`\x1b[1m${msg}\x1b[0m`);

const children = [];
let stopping = false;

function run(name, cmd) {
  const child = spawn(cmd, { shell: true, env: process.env });
  children.push(child);
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/); buf = lines.pop();
      for (const l of lines) if (l.trim()) out.write(tag(name) + l + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (stopping) return;
    say(`${name} stopped (exit ${code}). Stopping the others.`);
    stop(code ?? 1);
  });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode != null) continue;
    // shell: true wraps each command in cmd.exe on Windows; kill the whole tree, not just the shell
    if (win) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill("SIGTERM");
  }
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

if (prod) {
  say("Building (npm run build)…");
  const b = spawnSync("npm run build", { shell: true, stdio: "inherit" });
  if (b.status !== 0) { say("Build failed. Nothing started."); process.exit(b.status ?? 1); }
}

say(`Starting ${prod ? "production" : "dev"} server on :${port}, worker${domain ? ", ngrok" : ""}. Ctrl+C stops everything.`);
run("web", prod ? `npx next start -p ${port}` : `npx next dev -p ${port}`);
run("worker", "npx tsx worker/index.ts");
if (domain) {
  run("ngrok", `ngrok http --url=${domain} ${port} --log=stdout --log-format=term`);
  say(`Open https://${domain}`);
} else {
  say(`No ngrok domain found (set NGROK_DOMAIN in .env.local). Local only: http://localhost:${port}`);
}
