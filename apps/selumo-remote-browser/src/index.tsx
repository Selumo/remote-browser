import type { IncomingMessage } from "node:http"
import net from "node:net"
import path from "node:path"
import type { Duplex } from "node:stream"
import { serve, type HttpBindings } from "@hono/node-server"
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { type Context, Hono } from "hono"
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
import { currentQuality, QUALITIES, setQuality } from "./browser/vnc.js"
import { closeActive, current, openProfile } from "./browser/manager.js"
import {
  allTags,
  backlinks,
  deleteDoc,
  findDoc,
  listDocs,
  renderMarkdown,
  saveDoc,
  docHref,
} from "./docs.js"
import { allowedEmails, env } from "./env.js"
import { captureImage, deleteImage, findImage, imageFile, listImages, saveImage } from "./images.js"
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
import { KASM_STYLE } from "./views/kasm.js"
import { DataPage, DocEditPage, DocPage, DocsPage, ImagesPage, McpPage } from "./views/more.js"
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

// ---- remote screen: KasmVNC's web client (WebSocket proxied below) ----

app.get("/kasm/vnc.html", requireUser, async (c) => {
  const res = await serveFile(env.KASM_WWW, "vnc.html")
  if (!res.ok) return res
  const html = (await res.text()).replace("<head>", `<head>${KASM_STYLE}`)
  // Never cached, so a new build always shows its own page.
  return c.html(html, 200, { "Cache-Control": "no-store" })
})

app.get("/kasm/*", requireUser, (c) => serveFile(env.KASM_WWW, c.req.path.slice("/kasm/".length)))

/**
 * Changes on every start. A viewer page left open from an older build reconnects on its own after
 * a restart and would keep running old keyboard code; it is refused until the page is reloaded.
 */
const VIEWER_BUILD = Date.now().toString(36)

/** Settings for the KasmVNC client, passed in the URL hash where it reads them. */
function kasmViewerUrl(viewOnly: boolean): string {
  const settings: Record<string, string | number | boolean> = {
    autoconnect: true,
    path: `kasm/websockify?b=${VIEWER_BUILD}`,
    resize: "scale",
    enable_ime: false,
    view_only: viewOnly,
    // Kasm's own quality preset (Low 1 .. Lossless 5).
    video_quality: QUALITIES[currentQuality()].level,
    compression: env.VNC_COMPRESSION,
    idle_disconnect: 0,
    reconnect: true,
    reconnect_delay: 1000,
    clipboard_up: false,
    clipboard_down: false,
    clipboard_seamless: false,
    prefer_local_cursor: true,
    toggle_control_panel: false,
  }
  const hash = Object.entries(settings)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&")
  // A new URL per build, so copies cached by older builds are never reused.
  return `/kasm/vnc.html?v=${VIEWER_BUILD}#${hash}`
}

app.get("/viewer", requireUser, (c) => {
  c.header("Cache-Control", "no-store")
  return c.redirect(kasmViewerUrl(c.req.query("view_only") === "true"))
})

app.post("/viewer/quality", requireUser, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { quality?: unknown } | null
  try {
    return c.json({ quality: setQuality(String(body?.quality)) })
  } catch (e) {
    return c.json({ error: message(e) }, 400)
  }
})

// ---- browser ----

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
      quality={currentQuality()}
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

// ---- docs (markdown notes) ----

app.get("/docs", requireUser, async (c) => {
  const q = c.req.query("q")?.trim() ?? ""
  const tag = c.req.query("tag")?.trim() ?? ""
  const [docs, tags] = await Promise.all([listDocs({ q, tag }), allTags()])
  return c.html(<DocsPage user={c.get("user")} docs={docs} tags={tags} q={q} tag={tag} />)
})

app.post("/docs", requireUser, async (c) => {
  const form = await c.req.formData()
  const title = formText(form, "title")
  const body = String(form.get("body") ?? "")
  try {
    if (await findDoc(title)) throw new Error(`"${title}" 문서가 이미 있어요`)
    const doc = await saveDoc({ title, body })
    return c.redirect(docHref(doc.title))
  } catch (e) {
    return c.html(
      <DocEditPage
        user={c.get("user")}
        doc={{ title, body }}
        preview={renderMarkdown(body)}
        error={message(e)}
      />,
      400,
    )
  }
})

app.post("/docs/preview", requireUser, async (c) => {
  const form = await c.req.formData()
  return c.html(renderMarkdown(String(form.get("body") ?? "")))
})

/** [[Title]] links land here; a missing note opens the editor so it can be created. */
app.get("/docs/t/:title", requireUser, async (c) => {
  const title = c.req.param("title")
  const doc = await findDoc(title)
  if (!doc) return c.html(<DocEditPage user={c.get("user")} doc={{ title, body: "" }} preview="" />)
  return c.html(
    <DocPage
      user={c.get("user")}
      doc={doc}
      html={renderMarkdown(doc.body)}
      backlinks={await backlinks(doc.title)}
    />,
  )
})

app.get("/docs/:id/edit", requireUser, async (c) => {
  const doc = await findDoc(c.req.param("id"))
  if (!doc) return c.redirect("/docs")
  return c.html(<DocEditPage user={c.get("user")} doc={doc} preview={renderMarkdown(doc.body)} />)
})

app.post("/docs/:id", requireUser, async (c) => {
  const id = c.req.param("id")
  const form = await c.req.formData()
  const title = formText(form, "title")
  const body = String(form.get("body") ?? "")
  try {
    const other = await findDoc(title)
    if (other && other.id !== id) throw new Error(`"${title}" 문서가 이미 있어요`)
    const doc = await saveDoc({ ref: id, title, body })
    return c.redirect(docHref(doc.title))
  } catch (e) {
    return c.html(
      <DocEditPage
        user={c.get("user")}
        doc={{ id, title, body }}
        preview={renderMarkdown(body)}
        error={message(e)}
      />,
      400,
    )
  }
})

app.post("/docs/:id/delete", requireUser, async (c) => {
  await deleteDoc(c.req.param("id"))
  return c.redirect("/docs")
})

// ---- data (crawl items across jobs) ----

app.get("/data", requireUser, async (c) => {
  const jobs = await listJobs()
  const counts = await Promise.all(
    jobs.map(async (j) => ({
      id: j.id,
      name: j.name,
      total: (await listItems(j.id, { limit: 1 })).total,
    })),
  )
  const selected = counts.find((j) => j.id === c.req.query("job")) ?? null
  const items = selected ? (await listItems(selected.id, { limit: 200 })).items : []
  return c.html(
    <DataPage
      user={c.get("user")}
      jobs={counts}
      selected={selected}
      items={items}
      columns={columnsOf(items.map((i) => i.data ?? {}))}
    />,
  )
})

// ---- images ----

async function imagesPage(c: Context<App>, error?: string) {
  return c.html(
    <ImagesPage
      user={c.get("user")}
      images={await listImages({ limit: 200 })}
      browserOpen={Boolean(current())}
      error={error}
    />,
    error ? 400 : 200,
  )
}

app.get("/images", requireUser, (c) => imagesPage(c))

app.post("/images/capture", requireUser, async (c) => {
  const form = await c.req.formData()
  try {
    const browser = current()
    if (!browser) throw new Error("열린 브라우저가 없어요")
    await captureImage(browser.page, {
      title: formText(form, "title") || undefined,
      source: "capture",
      fullPage: form.get("full") === "1",
    })
    return c.redirect("/images")
  } catch (e) {
    return imagesPage(c, message(e))
  }
})

app.post("/images/upload", requireUser, async (c) => {
  const form = await c.req.formData()
  try {
    const file = form.get("file")
    if (!(file instanceof File) || file.size === 0) throw new Error("파일을 골라 주세요")
    if (file.size > 20 * 1024 * 1024) throw new Error("20MB까지 올릴 수 있어요")
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
      throw new Error("PNG, JPEG, WebP, GIF만 올릴 수 있어요")
    await saveImage({
      data: new Uint8Array(await file.arrayBuffer()),
      filename: file.name || "upload",
      mime: file.type,
      title: formText(form, "title") || file.name.replace(/\.[^.]+$/, ""),
      source: "upload",
    })
    return c.redirect("/images")
  } catch (e) {
    return imagesPage(c, message(e))
  }
})

async function sendImage(ref: string): Promise<Response> {
  const image = await findImage(ref)
  if (!image) return new Response("Not found", { status: 404 })
  const res = await imageFile(image)
  return new Response(res.body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "private, max-age=300",
    },
  })
}

app.get("/images/:id/file", requireUser, (c) => sendImage(c.req.param("id")))
/** ![[title]] embeds in notes: by id or the newest image with that title. */
app.get("/images/t/:ref", requireUser, (c) => sendImage(c.req.param("ref")))

app.post("/images/:id/delete", requireUser, async (c) => {
  await deleteImage(c.req.param("id"))
  return c.redirect("/images")
})

// ---- MCP setup ----

function publicOrigin(c: Context<App>): string {
  const url = new URL(c.req.url)
  const proto =
    c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.slice(0, -1)
  const host = c.req.header("x-forwarded-host") || c.req.header("host") || url.host
  return `${proto}://${host}`
}

app.get("/mcp-setup", requireUser, (c) =>
  c.html(
    <McpPage
      user={c.get("user")}
      url={`${publicOrigin(c)}/mcp`}
      hasToken={Boolean(env.MCP_TOKEN)}
      emails={[...allowedEmails]}
    />,
  ),
)

/** The token is only handed out on request (POST, logged-in user), never rendered into the page. */
app.post("/mcp-setup/token", requireUser, (c) => {
  if (!env.MCP_TOKEN) return c.json({ error: "MCP_TOKEN is not set" }, 404)
  c.header("Cache-Control", "no-store")
  return c.json({ token: env.MCP_TOKEN })
})

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

/** The viewer connects to /kasm/websockify; pipe it to KasmVNC after checking the session. */
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
    const url = new URL(req.url ?? "/", "http://local")
    if (url.pathname !== "/kasm/websockify") socket.destroy()
    else if (url.searchParams.get("b") !== VIEWER_BUILD)
      socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n")
    else void proxyVnc(req, socket, head)
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
