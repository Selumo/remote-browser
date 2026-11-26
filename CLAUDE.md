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
| Data | PocketBase: dashboard users (auth), profiles, jobs, job runs, logs and crawl items. Bound to 127.0.0.1, used by the app as a superuser |
| Browser | Playwright Chromium, headful on the KasmVNC X server, one persistent context per profile under `/data/profiles/<id>` |
| Remote view | KasmVNC (`Xkasmvnc`, X server and VNC over WebSocket in one) at `SCREEN_WIDTH`x`SCREEN_HEIGHT` (1920x1080). Its stock web client is served at `/kasm/` (settings in the URL hash, Kasm's UI hidden), `/viewer` redirects to it, WebSocket proxied at `/kasm/websockify`. The quality select uses Kasm's own presets (`video_quality` Low..Lossless) and reloads the client; the server honours them only through `-AllowOverride` in the entrypoint. Korean cannot be typed through VNC. Details and what was tried: `docs/remote-view.md` |
| AI access | MCP Streamable HTTP at `/mcp`, stateless per request, the browser state lives in the process. Includes a virtual mouse (`mouse_*`) |
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
  browser/         The single shared Playwright context and AI-facing helpers
  jobs/            Step schema, runner, cron scheduler, crawl extraction, CSV
  docs.ts          Markdown notes: [[wiki links]], ![[image]] embeds, #tags, backlinks
  images.ts        Stored images (captures, uploads, job screenshots) in PocketBase
  mcp.ts           MCP tools (browser, virtual mouse, profiles, jobs, runs, crawl data, docs, images)
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
- `/mcp` requires `MCP_TOKEN` as a bearer token or a Cloudflare Access email listed in `ALLOWED_EMAILS`.
- Never commit `.env` files. Secrets go into Dokploy's Environment tab.
