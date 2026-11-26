import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Page } from "playwright"
import { z } from "zod"
import { locate, pageSummary, settle, snapshot } from "./browser/actions.js"
import { profileCookies, summarize } from "./browser/cookies.js"
import { available, currentResolution, setResolution } from "./browser/vnc.js"
import {
  closeActive,
  current,
  openProfile,
  requireActive,
  selectTab,
  tabs,
} from "./browser/manager.js"
import { allItems, listItems, toCsv } from "./jobs/crawl.js"
import { runningRunId, startRun } from "./jobs/runner.js"
import { nextRun } from "./jobs/scheduler.js"
import { STEP_HELP } from "./jobs/steps.js"
import { ensureSuperuser, pb, type JobLog, type JobRun } from "./pb.js"
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

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] })
const json = (value: unknown): CallToolResult => text(JSON.stringify(value, null, 2))

async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn()
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
    }
  }
}

async function viewport(page: Page): Promise<{ width: number; height: number; dpr: number }> {
  return page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
  }))
}

const target = {
  ref: z.string().optional().describe("Element ref from browser_snapshot, e.g. e12"),
  selector: z.string().optional().describe("Playwright selector, used when no ref is given"),
}

const point = {
  x: z.number().min(0).describe("CSS pixels from the left edge of the page viewport"),
  y: z.number().min(0).describe("CSS pixels from the top edge of the page viewport"),
}

const MAX_CSV_CHARS = 1_000_000

/**
 * Builds a fresh MCP server per HTTP request (stateless transport). Every tool drives the single
 * shared browser and PocketBase, so state survives across requests and across MCP sessions.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "selumo-remote-browser", version: "0.2.0" },
    {
      instructions: [
        "A real Chromium on a remote desktop that keeps logins per profile, plus scheduled crawl jobs.",
        "Browse: profiles_list -> profile_open -> browser_snapshot, then act with refs (browser_click, browser_fill).",
        "When refs are not enough (canvas, maps, drag), take browser_screenshot and use mouse_* with its coordinates.",
        "Automate: job_create with steps (extract saves rows), job_update to set a cron schedule and enabled,",
        "job_run to run now, run_get for logs, crawl_items / crawl_csv for the collected data.",
        "Only one profile and one job run at a time. A person may be watching through noVNC.",
      ].join(" "),
    },
  )

  // ---------- browser ----------

  server.registerTool(
    "browser_status",
    { description: "Which profile is open, the current URL, and the running job." },
    () =>
      guarded(async () => {
        const browser = current()
        if (!browser) return json({ open: null, running_run: runningRunId() })
        const profile = await findProfile(browser.profileId).catch(() => null)
        return json({
          open: { profile: profile?.name ?? browser.profileId, url: browser.page.url() },
          tabs: tabs(),
          running_run: runningRunId(),
        })
      }),
  )

  server.registerTool(
    "profile_open",
    {
      description: "Open a profile in the shared browser, closing any other open profile.",
      inputSchema: { profile: z.string().describe("Profile id or exact name") },
    },
    ({ profile }) =>
      guarded(async () => {
        const record = await findProfile(profile)
        const browser = await openProfile(record)
        return text(`opened "${record.name}"\n${await pageSummary(browser.page)}`)
      }),
  )

  server.registerTool("browser_close", { description: "Close the open profile's browser." }, () =>
    guarded(async () => {
      await closeActive()
      return text("closed")
    }),
  )

  server.registerTool(
    "browser_navigate",
    {
      description: "Go to a URL, or back/forward in history.",
      inputSchema: { url: z.string().describe('A URL, or "back" / "forward"') },
    },
    ({ url }) =>
      guarded(async () => {
        await settle(requireActive().page)
        const { page } = requireActive()
        if (url === "back") await page.goBack()
        else if (url === "forward") await page.goForward()
        else await page.goto(z.string().url().parse(url))
        return text(await pageSummary(page))
      }),
  )

  server.registerTool(
    "browser_snapshot",
    {
      description:
        "Accessibility snapshot of the current page with element refs ([ref=eN]) for browser_click / browser_fill. " +
        "Set boxes to also get [box=x,y,w,h] viewport coordinates for mouse_* tools.",
      inputSchema: { boxes: z.boolean().optional() },
    },
    ({ boxes }) =>
      guarded(async () => {
        const { page } = requireActive()
        return text(
          `${await pageSummary(page)}\n\n${await snapshot(page, { boxes: boxes ?? false })}`,
        )
      }),
  )

  server.registerTool(
    "browser_click",
    { description: "Click an element by ref or selector.", inputSchema: target },
    (args) =>
      guarded(async () => {
        const { page } = requireActive()
        await locate(page, args).first().click()
        await settle(page)
        return text(await pageSummary(requireActive().page))
      }),
  )

  server.registerTool(
    "browser_fill",
    {
      description: "Fill a text input by ref or selector.",
      inputSchema: { ...target, value: z.string() },
    },
    ({ value, ...t }) =>
      guarded(async () => {
        const { page } = requireActive()
        await locate(page, t).first().fill(value)
        return text("filled")
      }),
  )

  server.registerTool(
    "browser_press",
    {
      description: "Press a key, optionally on an element (e.g. Enter, Tab, Control+A).",
      inputSchema: { key: z.string(), ref: target.ref, selector: target.selector },
    },
    ({ key, ...t }) =>
      guarded(async () => {
        const { page } = requireActive()
        if (t.ref || t.selector) await locate(page, t).first().press(key)
        else await page.keyboard.press(key)
        await settle(page)
        return text(await pageSummary(requireActive().page))
      }),
  )

  server.registerTool(
    "browser_wait_for",
    {
      description: "Wait for an element or visible text to appear.",
      inputSchema: {
        selector: z.string().optional(),
        text: z.string().optional(),
        timeout_ms: z.number().int().min(0).max(120_000).optional(),
      },
    },
    ({ selector, text: needle, timeout_ms }) =>
      guarded(async () => {
        const { page } = requireActive()
        const timeout = timeout_ms ?? 30_000
        if (selector) await page.locator(selector).first().waitFor({ timeout })
        else if (needle) await page.getByText(needle).first().waitFor({ timeout })
        else throw new Error("Give selector or text")
        return text("found")
      }),
  )

  server.registerTool(
    "browser_screenshot",
    {
      description:
        "Screenshot of the current viewport. Its pixel coordinates (divided by dpr) are what mouse_* tools take.",
      inputSchema: { full_page: z.boolean().optional() },
    },
    ({ full_page }) =>
      guarded(async () => {
        const { page } = requireActive()
        const vp = await viewport(page)
        const png = await page.screenshot({ type: "png", fullPage: full_page ?? false })
        return {
          content: [
            {
              type: "text",
              text: `viewport ${vp.width}x${vp.height} css px, dpr ${vp.dpr}. ${await pageSummary(page)}`,
            },
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
          ],
        }
      }),
  )

  server.registerTool("browser_tabs", { description: "List open tabs." }, () =>
    guarded(async () =>
      text(
        tabs()
          .map((t) => `${t.index}${t.active ? "*" : " "} ${t.url}`)
          .join("\n"),
      ),
    ),
  )

  server.registerTool(
    "browser_select_tab",
    { description: "Switch to a tab by index.", inputSchema: { index: z.number().int().min(0) } },
    ({ index }) =>
      guarded(async () => {
        const page = await selectTab(index)
        return text(await pageSummary(page))
      }),
  )

  server.registerTool(
    "viewer_resolution",
    {
      description:
        "Get or set the resolution people see in noVNC (the browser itself and screenshots stay full size).",
      inputSchema: {
        height: z
          .number()
          .int()
          .optional()
          .describe("1080, 720, 480 or 360. Omit to read the current one"),
      },
    },
    ({ height }) =>
      guarded(async () => {
        if (height !== undefined) await setResolution(height)
        return json({
          resolution: `${currentResolution()}p`,
          available: available().map((h) => `${h}p`),
        })
      }),
  )

  // ---------- virtual mouse and keyboard ----------

  server.registerTool(
    "mouse_click",
    {
      description:
        "Click at viewport coordinates with a virtual mouse (use browser_screenshot to find them).",
      inputSchema: {
        ...point,
        button: z.enum(["left", "right", "middle"]).optional(),
        click_count: z.number().int().min(1).max(3).optional().describe("2 for double click"),
      },
    },
    ({ x, y, button, click_count }) =>
      guarded(async () => {
        const { page } = requireActive()
        await page.mouse.click(x, y, { button: button ?? "left", clickCount: click_count ?? 1 })
        await settle(page)
        return text(`clicked (${x}, ${y})\n${await pageSummary(requireActive().page)}`)
      }),
  )

  server.registerTool(
    "mouse_move",
    { description: "Move the virtual mouse (hover) to viewport coordinates.", inputSchema: point },
    ({ x, y }) =>
      guarded(async () => {
        const { page } = requireActive()
        await page.mouse.move(x, y, { steps: 5 })
        return text(`moved to (${x}, ${y})`)
      }),
  )

  server.registerTool(
    "mouse_drag",
    {
      description:
        "Press at one point, move to another and release (drag and drop, sliders, selection).",
      inputSchema: {
        from_x: z.number().min(0),
        from_y: z.number().min(0),
        to_x: z.number().min(0),
        to_y: z.number().min(0),
        steps: z.number().int().min(1).max(100).optional(),
      },
    },
    ({ from_x, from_y, to_x, to_y, steps }) =>
      guarded(async () => {
        const { page } = requireActive()
        await page.mouse.move(from_x, from_y)
        await page.mouse.down()
        await page.mouse.move(to_x, to_y, { steps: steps ?? 15 })
        await page.mouse.up()
        return text(`dragged (${from_x}, ${from_y}) → (${to_x}, ${to_y})`)
      }),
  )

  server.registerTool(
    "mouse_wheel",
    {
      description: "Scroll with the mouse wheel, optionally after moving to a point first.",
      inputSchema: {
        delta_y: z.number().describe("Positive scrolls down"),
        delta_x: z.number().optional(),
        x: z.number().min(0).optional(),
        y: z.number().min(0).optional(),
      },
    },
    ({ delta_x, delta_y, x, y }) =>
      guarded(async () => {
        const { page } = requireActive()
        if (x !== undefined && y !== undefined) await page.mouse.move(x, y)
        await page.mouse.wheel(delta_x ?? 0, delta_y)
        await page.waitForTimeout(200)
        return text("scrolled")
      }),
  )

  server.registerTool(
    "keyboard_type",
    {
      description: "Type text into whatever has focus (after mouse_click on a field).",
      inputSchema: { text: z.string(), delay_ms: z.number().int().min(0).max(500).optional() },
    },
    ({ text: value, delay_ms }) =>
      guarded(async () => {
        const { page } = requireActive()
        await page.keyboard.type(value, { delay: delay_ms ?? 20 })
        return text("typed")
      }),
  )

  // ---------- profiles ----------

  server.registerTool(
    "profiles_list",
    { description: "List browser profiles (each keeps its own logins)." },
    () =>
      guarded(async () => {
        const open = current()?.profileId
        const items = await listProfiles()
        return json(
          items.map((p) => ({
            id: p.id,
            name: p.name,
            notes: p.notes,
            open: p.id === open,
            engine: p.engine || "chromium",
            device: p.device || "desktop",
            locale: p.locale || "ko-KR",
            timezone: p.timezone || null,
            color_scheme: p.color_scheme || null,
            stealth: p.stealth,
            proxy: p.proxy || null,
          })),
        )
      }),
  )

  const profileFields = {
    notes: z.string().max(2000).optional(),
    engine: z.enum(["chromium", "firefox", "webkit"]).optional().describe("Browser engine"),
    device: z.enum(["desktop", "mobile"]).optional(),
    locale: z.string().optional().describe("e.g. ko-KR"),
    timezone: z.string().optional().describe("e.g. Asia/Seoul"),
    color_scheme: z.enum(["light", "dark", ""]).optional(),
    stealth: z.boolean().optional().describe("Hide automation flags (Chromium), helps with logins"),
    proxy: z.string().optional().describe("http://host:port or socks5://host:port, empty for none"),
  }

  server.registerTool(
    "profile_create",
    {
      description:
        "Create a profile. Log in to sites inside it once (noVNC or browser_* tools) and it stays logged in.",
      inputSchema: { name: z.string().min(1).max(100), ...profileFields },
    },
    (input) => guarded(async () => json(await createProfile(input))),
  )

  server.registerTool(
    "profile_update",
    {
      description:
        "Change a profile's name, notes or browser settings. An open profile is reopened to apply them. " +
        "Switching engine starts that engine logged out (logins are stored per engine).",
      inputSchema: {
        profile: z.string(),
        name: z.string().min(1).max(100).optional(),
        ...profileFields,
      },
    },
    ({ profile, ...input }) => guarded(async () => json(await updateProfile(profile, input))),
  )

  server.registerTool(
    "profile_delete",
    {
      description: "Delete a profile and its jobs. The saved browser data stays on disk.",
      inputSchema: { profile: z.string() },
    },
    ({ profile }) =>
      guarded(async () => {
        const record = await findProfile(profile)
        await deleteProfile(record.id)
        return text(`deleted profile "${record.name}"`)
      }),
  )

  server.registerTool(
    "profile_cookies",
    {
      description:
        "Which sites a profile is logged in to: cookies grouped by site with login-like names, status " +
        "(valid, expiring within 3 days, expired, session) and expiry. Cookie values are never returned.",
      inputSchema: {
        profile: z.string(),
        domain: z.string().optional().describe("Only sites containing this text"),
        details: z.boolean().optional().describe("Include each cookie's name, status and expiry"),
      },
    },
    ({ profile, domain, details }) =>
      guarded(async () => {
        const record = await findProfile(profile)
        const data = await profileCookies(record)
        const sites = summarize(data.cookies).filter((g) => !domain || g.domain.includes(domain))
        return json({
          profile: record.name,
          source: data.source,
          sites: sites.map((g) => ({
            site: g.domain,
            status: g.status,
            login_cookies: g.login,
            total: g.total,
            expired: g.expired,
            latest_expiry: g.latestExpiry ? new Date(g.latestExpiry * 1000).toISOString() : null,
            ...(details
              ? {
                  cookies: g.cookies.map((c) => ({
                    name: c.name,
                    login_like: c.loginLike,
                    status: c.status,
                    expires: c.expires ? new Date(c.expires * 1000).toISOString() : null,
                  })),
                }
              : {}),
          })),
        })
      }),
  )

  // ---------- jobs ----------

  server.registerTool(
    "jobs_list",
    { description: "List jobs with their schedule and next run." },
    () =>
      guarded(async () => {
        const jobs = await listJobs()
        return json(
          jobs.map((j) => ({
            id: j.id,
            name: j.name,
            profile: j.profileName,
            schedule: j.schedule,
            enabled: j.enabled,
            next_run: nextRun(j.id)?.toISOString() ?? null,
          })),
        )
      }),
  )

  server.registerTool(
    "job_get",
    { description: "A job with its steps.", inputSchema: { job: z.string() } },
    ({ job }) =>
      guarded(async () => {
        const record = await findJob(job)
        return json({ ...record, next_run: nextRun(record.id)?.toISOString() ?? null })
      }),
  )

  const jobFields = {
    profile: z.string().describe("Profile id or name"),
    steps: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        `Steps run in order. Actions: goto, click, fill, press, wait, waitFor, text, screenshot, scroll, extract. Example: ${STEP_HELP}`,
      ),
    schedule: z
      .string()
      .describe(
        'Cron expression evaluated in the server time zone, e.g. "0 9 * * *". Empty for none.',
      ),
    enabled: z.boolean().describe("Whether the schedule is active"),
  }

  server.registerTool(
    "job_create",
    {
      description: "Create an automation or crawl job. extract steps save rows to crawl_items.",
      inputSchema: {
        name: z.string().min(1).max(100),
        profile: jobFields.profile,
        steps: jobFields.steps,
        schedule: jobFields.schedule.optional(),
        enabled: jobFields.enabled.optional(),
      },
    },
    (input) => guarded(async () => json(await createJob(input))),
  )

  server.registerTool(
    "job_update",
    {
      description:
        "Change a job: rename, move profile, replace steps, set or clear the cron schedule, enable or disable.",
      inputSchema: {
        job: z.string(),
        name: z.string().min(1).max(100).optional(),
        profile: jobFields.profile.optional(),
        steps: jobFields.steps.optional(),
        schedule: jobFields.schedule.optional(),
        enabled: jobFields.enabled.optional(),
      },
    },
    ({ job, ...input }) =>
      guarded(async () => {
        const updated = await updateJob(job, input)
        return json({ ...updated, next_run: nextRun(updated.id)?.toISOString() ?? null })
      }),
  )

  server.registerTool(
    "job_delete",
    {
      description: "Delete a job with its runs, logs and crawled data.",
      inputSchema: { job: z.string() },
    },
    ({ job }) =>
      guarded(async () => {
        await deleteJob(job)
        return text("deleted")
      }),
  )

  server.registerTool(
    "job_run",
    {
      description: "Run a job now. Returns the run id; poll run_get for progress.",
      inputSchema: { job: z.string() },
    },
    ({ job }) =>
      guarded(async () => {
        const record = await findJob(job)
        const run = await startRun(record.id, "mcp")
        return json({ run: run.id, job: record.name, status: run.status })
      }),
  )

  server.registerTool(
    "runs_list",
    {
      description: "Recent runs, optionally for one job.",
      inputSchema: {
        job: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    ({ job, limit }) =>
      guarded(async () => {
        const jobId = job ? (await findJob(job)).id : undefined
        const runs = await listRuns({ jobId, limit: limit ?? 20 })
        return json(
          runs.map((r) => ({
            id: r.id,
            job: r.jobName,
            status: r.status,
            trigger: r.trigger,
            items: r.items,
            started: r.started,
            finished: r.finished,
            error: r.error,
          })),
        )
      }),
  )

  server.registerTool(
    "run_get",
    { description: "A run's status and its log lines.", inputSchema: { run: z.string() } },
    ({ run }) =>
      guarded(async () => {
        await ensureSuperuser()
        const record = await pb.collection("job_runs").getOne<JobRun>(run)
        const logs = await pb
          .collection("job_logs")
          .getFullList<JobLog>({ filter: pb.filter("run = {:run}", { run }), sort: "created" })
        return text(
          `status: ${record.status}  items: ${record.items}  trigger: ${record.trigger}\n` +
            (record.error ? `error: ${record.error}\n` : "") +
            logs
              .map(
                (l) =>
                  `${l.created.slice(11, 19)} ${l.level === "error" ? "ERROR " : ""}${l.message}`,
              )
              .join("\n"),
        )
      }),
  )

  // ---------- crawled data ----------

  server.registerTool(
    "crawl_items",
    {
      description: "Collected rows of a job (newest first), optionally from one run.",
      inputSchema: {
        job: z.string(),
        run: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    ({ job, run, limit, offset }) =>
      guarded(async () => {
        const record = await findJob(job)
        const res = await listItems(record.id, {
          runId: run,
          limit: limit ?? 50,
          offset: offset ?? 0,
        })
        return json({
          total: res.total,
          items: res.items.map((i) => ({ ...i.data, _run: i.run, _collected_at: i.created })),
        })
      }),
  )

  server.registerTool(
    "crawl_csv",
    {
      description:
        "All collected rows of a job as CSV text (first column collected_at). The dashboard serves the same file at /jobs/<id>/items.csv.",
      inputSchema: { job: z.string(), run: z.string().optional() },
    },
    ({ job, run }) =>
      guarded(async () => {
        const record = await findJob(job)
        const csv = toCsv(await allItems(record.id, run)).replace(/^﻿/, "")
        const note = `download: /jobs/${record.id}/items.csv${run ? `?run=${run}` : ""}\n\n`
        return text(
          csv.length > MAX_CSV_CHARS
            ? `${note}${csv.slice(0, MAX_CSV_CHARS)}\n... truncated, use the download URL for the full file`
            : `${note}${csv}`,
        )
      }),
  )

  return server
}
