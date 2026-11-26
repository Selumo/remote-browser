# Selumo remote-browser

Respond to the user in Korean. Write every configuration file in English.

A self-hosted remote browser. AI agents drive it over MCP, people watch and take over through
KasmVNC, logins persist per profile, and saved jobs run on cron schedules, crawl rows into
PocketBase and export them as CSV. Everything the dashboard can do, MCP can do too.

## Stack (decided 2026-11-26)

| Layer | Choice |
|---|---|
| Server | Hono on Node 24 (`@hono/node-server`), pages rendered with `hono/jsx` |
| Front end | htmx with the SSE extension, Alpine.js only where local UI state is needed. Served from node_modules, no CDN |
| Data | PocketBase: dashboard users (auth), profiles, jobs, job runs, logs, crawl items, docs and images. Downloads and uploads are files under `/data/downloads` and `/data/uploads`. Bound to 127.0.0.1, used by the app as a superuser |
| Browser | Playwright Chromium, headful on the KasmVNC X server, one persistent context per profile under `/data/profiles/<id>` |
| Remote view | KasmVNC (`Xkasmvnc`, X server and VNC over WebSocket in one) at `SCREEN_WIDTH`x`SCREEN_HEIGHT` (1920x1080). Its stock web client is served at `/kasm/` (settings in the URL hash, Kasm's UI hidden), `/viewer` redirects to it, WebSocket proxied at `/kasm/websockify`. The quality select uses Kasm's own presets (`video_quality` Low..Lossless) and reloads the client; the server honours them only through `-AllowOverride` in the entrypoint. Korean cannot be typed through VNC. Details and what was tried: `docs/remote-view.md` |
| AI access | MCP Streamable HTTP at `/mcp`, stateless per request, the browser state lives in the process. 18 grouped tools (~4.5k tokens), including raw mouse/keyboard (`input`) and `browser ask_human` |
| Scheduling | croner inside the app process, one cron per enabled job, evaluated in `SCHEDULE_TZ` |
| UI | Black and white, square, monospace. No colors, no radius, no theme work |
| Packaging | One container (`docker/Dockerfile`), deployed by Dokploy from `docker-compose.yml`, exposed through Cloudflare Tunnel with Cloudflare Access in front |
| Toolchain | pnpm workspaces, TypeScript 7 (tsgo), oxlint, oxfmt, Vitest |

## Layout

```
apps/selumo-remote-browser/src/
  index.tsx        Routes, SSE, MCP endpoint, VNC WebSocket proxy, start-up
  auth.ts          PocketBase user session cookie, MCP bearer or Cloudflare Access identity
  pb.ts            Superuser client and record types
  services.ts      Profile, job and run operations shared by routes and MCP tools
  browser/         The single shared Playwright context and AI-facing helpers: page log and
                   dialogs, files (downloads, uploads from people, intercepted file choosers),
                   bookmarks (chrome://bookmarks API), history, login detection and requests
                   for a person (help.ts), site playbooks (playbook.ts: notes titled
                   "플레이북: <host>" pointed at from page summaries)
  jobs/            Step schema, runner, cron scheduler, crawl extraction, CSV
  docs.ts          Markdown notes: [[wiki links]], ![[image]] embeds, #tags, backlinks
  images.ts        Stored images (captures, uploads, job screenshots) in PocketBase
  cfaccess.ts      Cloudflare Access JWT verification for /mcp-oauth
  setup.ts         One-line installers for Claude Code and Claude Desktop (/setup/*.sh)
  mcp.ts           MCP tools, 18 grouped by subject with an `action` argument; compact JSON
                   output. Add new actions to an existing tool before adding a tool
  views/           hono/jsx pages (more.tsx: docs, data, images, MCP setup; kasm.ts: viewer CSS)
pocketbase/remote-browser/pb_migrations/   JS migrations, applied when PocketBase starts
docker/            Dockerfile and entrypoint for the single container
docs/              Notes for maintainers (remote-view.md: KasmVNC findings)
```

## Constraints

- One browser and one open profile at a time, shared by MCP, jobs and the remote view. One job
  run at a time; a scheduled run that finds the runner busy is recorded as a skipped failed run.
- Any new dashboard action gets a matching MCP tool, through `services.ts`.
- PocketBase and KasmVNC listen on 127.0.0.1 only. Port 3000 is the only exposed port.
- Every dashboard route and the VNC WebSocket require a PocketBase user session.
- `/mcp` requires `MCP_TOKEN` as a bearer token, nothing else. `/mcp-oauth` sits behind Cloudflare
  Access (managed OAuth, for claude.ai connectors) and requires a valid Access JWT
  (`Cf-Access-Jwt-Assertion`, checked against `CF_ACCESS_TEAM_DOMAIN` keys and `CF_ACCESS_AUD`);
  email headers alone are never trusted. `/setup/*.sh` installers are public and hold no secrets.
- Never commit `.env` files. Secrets go into Dokploy's Environment tab.
