# Selumo remote-browser

Respond to the user in Korean. Write every configuration file in English.

A self-hosted remote browser. AI agents drive it over MCP, people watch and take over through
noVNC, logins persist per profile, and saved jobs run on cron schedules, crawl rows into
PocketBase and export them as CSV. Everything the dashboard can do, MCP can do too.

## Stack (decided 2026-11-26)

| Layer | Choice |
|---|---|
| Server | Hono on Node 24 (`@hono/node-server`), pages rendered with `hono/jsx` |
| Front end | htmx with the SSE extension, Alpine.js only where local UI state is needed. Served from node_modules, no CDN |
| Data | PocketBase: dashboard users (auth), profiles, jobs, job runs, logs and crawl items. Bound to 127.0.0.1, used by the app as a superuser |
| Browser | Playwright Chromium, headful on Xvfb, one persistent context per profile under `/data/profiles/<id>` |
| Remote view | Xvfb at `SCREEN_WIDTH`x`SCREEN_HEIGHT` (1920x1080), x11vnc + websockify, a minimal noVNC viewer at `/viewer` with reduced JPEG quality (`VNC_QUALITY`), WebSocket proxied at `/websockify` |
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
  mcp.ts           MCP tools (browser, virtual mouse, profiles, jobs, runs, crawl data)
  views/           hono/jsx pages
pocketbase/remote-browser/pb_migrations/   JS migrations, applied when PocketBase starts
docker/            Dockerfile and entrypoint for the single container
```

## Constraints

- One browser and one open profile at a time, shared by MCP, jobs and the noVNC viewer. One job
  run at a time; a scheduled run that finds the runner busy is recorded as a skipped failed run.
- Any new dashboard action gets a matching MCP tool, through `services.ts`.
- PocketBase, x11vnc and websockify listen on 127.0.0.1 only. Port 3000 is the only exposed port.
- Every dashboard route and the VNC WebSocket require a PocketBase user session.
- `/mcp` requires `MCP_TOKEN` as a bearer token or a Cloudflare Access email listed in `ALLOWED_EMAILS`.
- Never commit `.env` files. Secrets go into Dokploy's Environment tab.
