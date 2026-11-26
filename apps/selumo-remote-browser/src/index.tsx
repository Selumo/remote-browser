import type { IncomingMessage } from "node:http"
import net from "node:net"
import path from "node:path"
import type { Duplex } from "node:stream"
import { serve, type HttpBindings } from "@hono/node-server"
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import {
  type AuthVars,
  clearSession,
  login,
  mcpIdentity,
  requireUser,
  sessionFromCookieHeader,
  setSession,
  verifyToken,
} from "./auth.js"
import { profileCookies, summarize } from "./browser/cookies.js"
import { available, currentResolution, QUALITY_FOR, setResolution } from "./browser/vnc.js"
import { focusedValue, insertAtFocus } from "./browser/actions.js"
import { closeActive, current, openProfile, requireActive } from "./browser/manager.js"
import { env } from "./env.js"
import { allItems, columnsOf, listItems, toCsv } from "./jobs/crawl.js"
import { runEvents, runningRunId, startRun, type RunEvent } from "./jobs/runner.js"
import { nextRun, startScheduler } from "./jobs/scheduler.js"
import { buildMcpServer, currentHandoff } from "./mcp.js"
import { checkChallenge } from "./browser/challenge.js"
import {
  ensureAdminUser,
  ensureSuperuser,
  pb,
  waitForPocketBase,
  type JobLog,
  type JobRun,
  type Profile,
} from "./pb.js"
import {
  createJob,
  createProfile,
  deleteJob,
  deleteProfile,
  findJob,
  findProfile,
  listJobs,
  listProfiles,
  listRuns,
  updateJob,
  updateProfile,
} from "./services.js"
import { serveFile, vendorFiles } from "./static.js"
import { viewerHtml } from "./views/viewer.js"
import {
  BrowserPage,
  BrowserStatus,
  ItemsTable,
  JobDetailPage,
  JobsPage,
  LoginPage,
  ProfilesPage,
  ProfileList,
  RunPanel,
  RunStatus,
} from "./views/pages.js"

type App = { Bindings: HttpBindings } & AuthVars
const app = new Hono<App>()

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  )

const logClock = new Intl.DateTimeFormat("sv-SE", {
  timeZone: env.SCHEDULE_TZ,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})

const logLine = (level: string, text: string, created: string) => {
  const d = new Date(created.replace(" ", "T"))
  const time = Number.isNaN(d.getTime()) ? created.slice(11, 19) : logClock.format(d)
  return `<li class="${level === "error" ? "error" : ""}">${escapeHtml(time)} ${escapeHtml(text)}</li>`
}

async function openProfileRecord(): Promise<Profile | null> {
  const id = current()?.profileId
  if (!id) return null
  return findProfile(id).catch(() => null)
}

const formText = (form: FormData, key: string) => String(form.get(key) ?? "").trim()

app.get("/healthz", (c) => c.text("ok"))

app.get("/vendor/:file", async (c) => {
  const file = vendorFiles[c.req.param("file")]
  if (!file) return c.notFound()
  return serveFile(path.dirname(file), path.basename(file))
})

// ---- auth ----

app.get("/login", (c) => c.html(<LoginPage />))

app.post("/login", async (c) => {
  const form = await c.req.formData()
  try {
    setSession(c, await login(formText(form, "email"), String(form.get("password") ?? "")))
    return c.redirect("/")
  } catch {
    return c.html(<LoginPage error="이메일 또는 비밀번호가 맞지 않아요." />, 401)
  }
})

app.post("/logout", (c) => {
  clearSession(c)
  return c.redirect("/login")
})

// ---- noVNC static files (the WebSocket is proxied in the upgrade handler below) ----

app.get("/novnc/*", requireUser, (c) =>
  serveFile(env.NOVNC_DIR, c.req.path.slice("/novnc/".length)),
)

app.get("/viewer", requireUser, (c) =>
  c.html(
    viewerHtml({
      compression: env.VNC_COMPRESSION,
      resolution: currentResolution(),
      qualityFor: QUALITY_FOR,
    }),
  ),
)

app.post("/viewer/resolution", requireUser, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { height?: unknown } | null
  try {
    return c.json({ height: await setResolution(Number(body?.height)) })
  } catch (e) {
    return c.json({ error: message(e) }, 400)
  }
})

// ---- browser ----

/** Viewer panel: insert text at the remote focus. VNC clipboard is Latin-1 only, this is UTF-8. */
app.post("/browser/insert-text", requireUser, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null
  const text = typeof body?.text === "string" ? body.text : ""
  if (!text || text.length > 20_000)
    return c.json({ error: "text is required (max 20000 chars)" }, 400)
  try {
    const { page } = requireActive()
    const mode = (body as { mode?: unknown } | null)?.mode
    if (mode === "cdp") await page.keyboard.insertText(text)
    else if (mode === "type") await page.keyboard.type(text)
    else await insertAtFocus(page, text)
    return c.json({ ok: true, value: await focusedValue(page) })
  } catch (e) {
    return c.json({ error: message(e) }, 409)
  }
})

app.get("/", requireUser, async (c) => {
  const [profiles, open] = await Promise.all([listProfiles(), openProfileRecord()])
  return c.html(
    <BrowserPage
      user={c.get("user")}
      profiles={profiles}
      openProfile={open}
      url={current()?.page.url() ?? null}
      running={runningRunId()}
      screen={{ width: env.SCREEN_WIDTH, height: env.SCREEN_HEIGHT }}
      resolution={currentResolution()}
      resolutions={available()}
    />,
  )
})

app.get("/partials/status", requireUser, async (c) => {
  const page = current()?.page
  const challenge = page ? await checkChallenge(page).catch(() => null) : null
  return c.html(
    <BrowserStatus
      profile={await openProfileRecord()}
      url={page?.url() ?? null}
      running={runningRunId()}
      challenge={challenge}
      handoff={currentHandoff()}
    />,
  )
})

const profileList = async () => (
  <ProfileList profiles={await listProfiles()} openId={current()?.profileId ?? null} />
)

app.post("/profiles", requireUser, async (c) => {
  const form = await c.req.formData()
  await createProfile({
    name: formText(form, "name"),
    notes: formText(form, "notes"),
  })
  return c.html(await profileList())
})

app.delete("/profiles/:id", requireUser, async (c) => {
  await deleteProfile(c.req.param("id"))
  return c.html(await profileList())
})

app.post("/profiles/:id/open", requireUser, async (c) => {
  const profile = await findProfile(c.req.param("id"))
  const browser = await openProfile(profile)
  return c.html(
    <BrowserStatus profile={profile} url={browser.page.url()} running={runningRunId()} />,
  )
})

app.post("/browser/close", requireUser, async (c) => {
  await closeActive()
  return c.html(<BrowserStatus profile={null} url={null} running={runningRunId()} />)
})

// ---- profiles ----

async function profilesPage(c: { get(key: "user"): string }, id?: string, error?: string) {
  const profiles = await listProfiles()
  const selected = (id ? profiles.find((p) => p.id === id) : profiles[0]) ?? null
  const data = selected ? await profileCookies(selected) : null
  return (
    <ProfilesPage
      user={c.get("user")}
      profiles={profiles}
      openId={current()?.profileId ?? null}
      selected={selected}
      source={data?.source ?? null}
      summary={data ? summarize(data.cookies) : []}
      error={error}
    />
  )
}

app.get("/profiles", requireUser, async (c) => c.html(await profilesPage(c, c.req.query("id"))))

app.post("/profiles/:id/settings", requireUser, async (c) => {
  const id = c.req.param("id")
  const form = await c.req.formData()
  try {
    await updateProfile(id, {
      name: formText(form, "name"),
      notes: formText(form, "notes"),
      engine: formText(form, "engine") as "chromium" | "firefox" | "webkit",
      device: formText(form, "device") as "desktop" | "mobile",
      locale: formText(form, "locale"),
      timezone: formText(form, "timezone"),
      color_scheme: formText(form, "color_scheme") as "light" | "dark" | "",
      stealth: form.get("stealth") === "1",
      proxy: formText(form, "proxy"),
    })
    return c.redirect(`/profiles?id=${id}`)
  } catch (e) {
    return c.html(await profilesPage(c, id, message(e)), 400)
  }
})

app.post("/profiles/new", requireUser, async (c) => {
  const form = await c.req.formData()
  const profile = await createProfile({
    name: formText(form, "name"),
    notes: formText(form, "notes"),
  })
  return c.redirect(`/profiles?id=${profile.id}`)
})

// ---- jobs ----

async function jobsPage(c: { get(key: "user"): string }, error?: string) {
  const [jobs, profiles, runs] = await Promise.all([
    listJobs(),
    listProfiles(),
    listRuns({ limit: 30 }),
  ])
  return (
    <JobsPage
      user={c.get("user")}
      jobs={jobs.map((j) => ({ ...j, nextRun: nextRun(j.id)?.toISOString() ?? null }))}
      profiles={profiles}
      runs={runs}
      error={error}
    />
  )
}

function jobInput(form: FormData) {
  return {
    name: formText(form, "name"),
    profile: formText(form, "profile"),
    steps: String(form.get("steps") ?? ""),
    schedule: formText(form, "schedule"),
    enabled: form.get("enabled") === "1",
  }
}

app.get("/jobs", requireUser, async (c) => c.html(await jobsPage(c)))

app.post("/jobs", requireUser, async (c) => {
  try {
    const job = await createJob(jobInput(await c.req.formData()))
    return c.redirect(`/jobs/${job.id}`)
  } catch (e) {
    return c.html(await jobsPage(c, message(e)), 400)
  }
})

async function jobDetail(
  c: { get(key: "user"): string },
  jobId: string,
  opts: { runId?: string | undefined; error?: string | undefined } = {},
) {
  const job = await findJob(jobId)
  const [profiles, runs, data, panelRun] = await Promise.all([
    listProfiles(),
    listRuns({ jobId: job.id, limit: 30 }),
    listItems(job.id, { runId: opts.runId, limit: 100 }),
    opts.runId
      ? pb
          .collection("job_runs")
          .getOne<JobRun>(opts.runId)
          .catch(() => null)
      : Promise.resolve(null),
  ])
  return (
    <JobDetailPage
      user={c.get("user")}
      job={job}
      profiles={profiles}
      nextRun={nextRun(job.id)?.toISOString() ?? null}
      runs={runs}
      items={data.items}
      total={data.total}
      columns={columnsOf(data.items.map((i) => i.data ?? {}))}
      runId={opts.runId}
      panelRun={panelRun}
      error={opts.error}
    />
  )
}

app.get("/jobs/:id", requireUser, async (c) =>
  c.html(await jobDetail(c, c.req.param("id"), { runId: c.req.query("run") || undefined })),
)

app.post("/jobs/:id", requireUser, async (c) => {
  const id = c.req.param("id")
  try {
    await updateJob(id, jobInput(await c.req.formData()))
    return c.redirect(`/jobs/${id}`)
  } catch (e) {
    return c.html(await jobDetail(c, id, { error: message(e) }), 400)
  }
})

app.post("/jobs/:id/delete", requireUser, async (c) => {
  await deleteJob(c.req.param("id"))
  return c.redirect("/jobs")
})

app.post("/jobs/:id/run", requireUser, async (c) => {
  try {
    return c.html(<RunPanel run={await startRun(c.req.param("id"), "manual")} />)
  } catch (e) {
    return c.html(<RunPanel run={null} error={message(e)} />)
  }
})

app.get("/jobs/:id/items", requireUser, async (c) => {
  const job = await findJob(c.req.param("id"))
  const runId = c.req.query("run") || undefined
  const data = await listItems(job.id, { runId, limit: 100 })
  return c.html(
    <ItemsTable
      jobId={job.id}
      items={data.items}
      total={data.total}
      columns={columnsOf(data.items.map((i) => i.data ?? {}))}
      runId={runId}
    />,
  )
})

app.get("/jobs/:id/items.csv", requireUser, async (c) => {
  const job = await findJob(c.req.param("id"))
  const runId = c.req.query("run") || undefined
  const csv = toCsv(await allItems(job.id, runId))
  const stamp = new Date().toISOString().slice(0, 10)
  const file = `${job.name}${runId ? `-${runId}` : ""}-${stamp}.csv`
  return c.body(csv, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${encodeURIComponent(file).replace(/'/g, "%27")}"; filename*=UTF-8''${encodeURIComponent(file)}`,
  })
})

// ---- runs ----

app.get("/runs/:id", requireUser, async (c) => {
  await ensureSuperuser()
  const run = await pb.collection("job_runs").getOne<JobRun>(c.req.param("id"))
  return c.redirect(`/jobs/${run.job}?run=${run.id}`)
})

app.get("/runs/:id/panel", requireUser, async (c) => {
  await ensureSuperuser()
  return c.html(
    <RunPanel run={await pb.collection("job_runs").getOne<JobRun>(c.req.param("id"))} />,
  )
})

app.get("/runs/:id/status", requireUser, async (c) => {
  await ensureSuperuser()
  const run = await pb.collection("job_runs").getOne<JobRun>(c.req.param("id"))
  if (run.status !== "running") c.header("HX-Trigger", "run-finished")
  return c.html(<RunStatus run={run} />)
})

app.get("/runs/:id/stream", requireUser, (c) =>
  streamSSE(c, async (stream) => {
    const runId = c.req.param("id")
    const seen = new Set<string>()
    const queue: RunEvent[] = []
    let wake: (() => void) | null = null
    const onEvent = (e: RunEvent) => {
      queue.push(e)
      wake?.()
    }
    runEvents.on(runId, onEvent)
    stream.onAbort(() => {
      runEvents.off(runId, onEvent)
      wake?.()
    })
    try {
      await ensureSuperuser()
      const past = await pb
        .collection("job_logs")
        .getFullList<JobLog>({ filter: pb.filter("run = {:id}", { id: runId }), sort: "created" })
      for (const l of past) {
        seen.add(l.id)
        await stream.writeSSE({ event: "log", data: logLine(l.level, l.message, l.created) })
      }
      const run = await pb.collection("job_runs").getOne<JobRun>(runId)
      if (run.status === "running") {
        while (!stream.aborted) {
          const next = queue.shift()
          if (!next) {
            await new Promise<void>((r) => (wake = r))
            wake = null
            continue
          }
          if (next.type === "end") break
          if (seen.has(next.id)) continue
          seen.add(next.id)
          await stream.writeSSE({
            event: "log",
            data: logLine(next.level, next.message, next.created),
          })
        }
      }
      await stream.writeSSE({ event: "end", data: "" })
    } finally {
      runEvents.off(runId, onEvent)
    }
  }),
)

app.onError((e, c) => {
  console.error(`[app] ${c.req.method} ${c.req.path}`, e)
  return c.text(message(e), 500)
})

// ---- MCP (Streamable HTTP, stateless; browser state lives in this process) ----

app.post("/mcp", async (c) => {
  if (!mcpIdentity(c.req.raw.headers)) return c.json({ error: "unauthorized" }, 401)
  const body: unknown = await c.req.json().catch(() => null)
  if (body === null) return c.json({ error: "invalid JSON" }, 400)
  const server = buildMcpServer()
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  const { incoming, outgoing } = c.env
  outgoing.on("close", () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(incoming, outgoing, body)
  return RESPONSE_ALREADY_SENT
})

app.on(["GET", "DELETE"], "/mcp", (c) => c.body(null, 405, { Allow: "POST" }))

// ---- start ----

/** noVNC connects to /novnc/websockify; pipe it to the local websockify after checking the session. */
async function proxyVnc(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const token = sessionFromCookieHeader(req.headers.cookie)
  if (!token || !(await verifyToken(token))) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
    return
  }
  const upstream = net.connect(env.VNC_WS_PORT, "127.0.0.1", () => {
    const lines = [`${req.method} /websockify HTTP/${req.httpVersion}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`)
    if (head.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  const destroy = () => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.on("error", destroy)
  socket.on("error", destroy)
}

async function main(): Promise<void> {
  await waitForPocketBase()
  await ensureAdminUser()
  await startScheduler()
  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`[app] listening on :${info.port}`)
  })
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // noVNC resolves its `path` relative to /novnc/vnc.html, so accept both locations.
    const target = req.url?.split("?")[0]
    if (target === "/websockify" || target === "/novnc/websockify") void proxyVnc(req, socket, head)
    else socket.destroy()
  })
  const shutdown = () => {
    void closeActive().finally(() => process.exit(0))
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

void main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
