import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Page } from "playwright"
import { z } from "zod"
import { locate, pageSummary, settle, snapshot } from "./browser/actions.js"
import { addBookmark, deleteBookmark, listBookmarks, updateBookmark } from "./browser/bookmarks.js"
import { currentChallenge } from "./browser/challenge.js"
import { profileCookies, summarize } from "./browser/cookies.js"
import {
  deleteStored,
  fillChooser,
  listFiles,
  mimeOf,
  payload,
  pendingChooser,
  pendingDownloads,
  readStored,
  type Store,
} from "./browser/files.js"
import { askHuman, currentHelp } from "./browser/help.js"
import { readHistory } from "./browser/history.js"
import { findPlaybook, playbookTitle } from "./browser/playbook.js"
import {
  closeActive,
  closeTab,
  current,
  newTab,
  openProfile,
  requireActive,
  selectTab,
  tabs,
} from "./browser/manager.js"
import { getDialogPolicy, readLog, setDialogPolicy, type LogKind } from "./browser/pagelog.js"
import { currentQuality, QUALITIES, setQuality } from "./browser/vnc.js"
import {
  allTags,
  appendDoc,
  backlinks,
  deleteDoc,
  getDoc,
  listDocs,
  saveDoc,
  wikiTargets,
} from "./docs.js"
import { captureImage, deleteImage, findImage, imageFile, listImages } from "./images.js"
import { allItems, extractRows, listItems, toCsv } from "./jobs/crawl.js"
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

/**
 * MCP tools, grouped by subject with an `action` argument so the tool list stays small (every
 * tool description is sent with every request). Results are compact: one-line JSON, no padding.
 */

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] })
const json = (value: unknown): CallToolResult => text(JSON.stringify(value))

const MAX_TEXT = 20_000
const clip = (s: string, max = MAX_TEXT) =>
  s.length > max ? `${s.slice(0, max)}\n... (${s.length - max} more chars)` : s

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

function need<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null || value === "") throw new Error(`${name} is required`)
  return value
}

const iso = (unix: number | null) => (unix ? new Date(unix * 1000).toISOString() : null)

async function viewport(page: Page) {
  return page.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio,
  }))
}

const target = {
  ref: z.string().optional().describe("Element ref from snapshot, e.g. e12"),
  selector: z.string().optional().describe("CSS/Playwright selector, used when no ref"),
}

// Async function built in Node and evaluated in the page as a function (CDP callFunctionOn), so
// page CSP does not block it. `el` is the target element, or undefined.
const AsyncFunction = (async () => undefined).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<unknown>

/** Files for an upload: "upload:<name>" (sent from a person's computer), "download:<name>" or "image:<id|title>". */
async function uploadFiles(files: string[]) {
  return Promise.all(
    files.map(async (ref) => {
      const [kind, ...rest] = ref.split(":")
      const key = rest.join(":")
      if (kind === "upload" || kind === "download") return payload(kind, key)
      if (kind === "image") {
        const record = await findImage(key)
        if (!record) throw new Error(`Image not found: ${key}`)
        const res = await imageFile(record)
        return {
          name: record.file,
          mimeType: res.headers.get("content-type") ?? "image/png",
          buffer: Buffer.from(await res.arrayBuffer()),
        }
      }
      throw new Error(
        `File must be "upload:<name>", "download:<name>" or "image:<id|title>", got ${ref}`,
      )
    }),
  )
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "selumo-remote-browser", version: "0.3.0" },
    {
      instructions:
        "Real Chromium on a remote desktop; logins persist per profile. Flow: profiles list -> " +
        "browser open -> snapshot -> act with refs. extract/evaluate read the DOM. Use screenshot + " +
        "input for canvas/maps. Never solve CAPTCHAs or guess passwords: browser ask_human gets a person. " +
        "Site playbooks are notes titled '플레이북: <host>': read one before working on a site " +
        "(docs playbook) and append what you learned (steps that worked, selectors, pitfalls) when done. " +
        "One profile and one job run at a time; a person may be watching.",
    },
  )

  // ---------- browser session, navigation, tabs ----------

  server.registerTool(
    "browser",
    {
      description:
        "Session and navigation. status | open(profile) | close | goto(url) | back | forward | reload | " +
        "tabs | tab_new(url?) | tab_select(index) | tab_close(index?) | ask_human(kind, message?, timeout_seconds?: " +
        "ask the person to log in / clear a captcha / type something only they know / confirm, through the " +
        "remote view; waits until done) | quality(quality?: remote view stream preset).",
      inputSchema: {
        action: z.enum([
          "status",
          "open",
          "close",
          "goto",
          "back",
          "forward",
          "reload",
          "tabs",
          "tab_new",
          "tab_select",
          "tab_close",
          "ask_human",
          "quality",
        ]),
        profile: z.string().optional().describe("open: profile id or name"),
        url: z.string().optional(),
        index: z.number().int().min(0).optional().describe("Tab index"),
        kind: z.enum(["login", "captcha", "input", "confirm"]).optional().describe("ask_human"),
        message: z.string().max(300).optional().describe("ask_human: shown to the person"),
        timeout_seconds: z
          .number()
          .int()
          .min(5)
          .max(1800)
          .optional()
          .describe("ask_human, default 600"),
        quality: z.enum(["low", "medium", "high", "extreme", "lossless"]).optional(),
      },
    },
    (a) =>
      guarded(async () => {
        switch (a.action) {
          case "status": {
            const browser = current()
            if (!browser) return json({ open: null, running_run: runningRunId() })
            const profile = await findProfile(browser.profileId).catch(() => null)
            const c = currentChallenge()
            return json({
              profile: profile?.name ?? browser.profileId,
              engine: browser.engine,
              url: browser.page.url(),
              tabs: tabs(),
              running_run: runningRunId(),
              bot_check: c ? { kind: c.kind, url: c.url } : null,
              waiting_for_person: currentHelp(),
              playbook: (await findPlaybook(browser.page.url()).catch(() => null))?.title ?? null,
              downloads: pendingDownloads(),
              file_chooser_open: pendingChooser(),
            })
          }
          case "open": {
            const record = await findProfile(need(a.profile, "profile"))
            const browser = await openProfile(record)
            return text(`opened "${record.name}"\n${await pageSummary(browser.page)}`)
          }
          case "close":
            await closeActive()
            return text("closed")
          case "goto": {
            const { page } = requireActive()
            await page.goto(z.string().url().parse(need(a.url, "url")))
            return text(await pageSummary(page))
          }
          case "back":
          case "forward":
          case "reload": {
            const { page } = requireActive()
            if (a.action === "back") await page.goBack()
            else if (a.action === "forward") await page.goForward()
            else await page.reload()
            return text(await pageSummary(page))
          }
          case "tabs":
            return json(tabs())
          case "tab_new":
            return text(
              await pageSummary(await newTab(a.url ? z.string().url().parse(a.url) : undefined)),
            )
          case "tab_select":
            return text(await pageSummary(await selectTab(need(a.index, "index"))))
          case "tab_close":
            await closeTab(a.index)
            return json(tabs())
          case "ask_human": {
            requireActive()
            const outcome = await askHuman(() => requireActive().page, {
              kind: a.kind ?? "login",
              message: a.message,
              from: "mcp",
              timeoutMs: (a.timeout_seconds ?? 600) * 1000,
            })
            const said = {
              done: "the person finished",
              cancelled: "the person declined",
              timeout: "no answer (timed out)",
            }[outcome]
            return text(`${said}\n${await pageSummary(requireActive().page)}`)
          }
          case "quality":
            if (a.quality) setQuality(a.quality, "mcp")
            return json({ quality: currentQuality(), available: Object.keys(QUALITIES) })
        }
      }),
  )

  // ---------- reading the page ----------

  server.registerTool(
    "snapshot",
    {
      description:
        "Accessibility tree of the page with element refs [ref=eN] for act/evaluate. boxes adds [box=x,y,w,h] for input.",
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
    "screenshot",
    {
      description: "PNG of the viewport (CSS px = image px / dpr, the coordinates input takes).",
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
              text: `viewport ${vp.w}x${vp.h} dpr ${vp.dpr}\n${await pageSummary(page)}`,
            },
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
          ],
        }
      }),
  )

  server.registerTool(
    "extract",
    {
      description:
        "Read rows from the DOM: each element matching selector becomes a row. fields maps names to a " +
        'sub-selector or {selector?, attr} (e.g. {"title":"a","url":{"selector":"a","attr":"href"}}). ' +
        "Without fields returns each match's text.",
      inputSchema: {
        selector: z.string(),
        fields: z
          .record(
            z.string(),
            z.union([
              z.string(),
              z.object({ selector: z.string().optional(), attr: z.string().optional() }),
            ]),
          )
          .optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    ({ selector, fields, limit }) =>
      guarded(async () => {
        const { page } = requireActive()
        const n = limit ?? 50
        if (fields) return text(clip(JSON.stringify(await extractRows(page, selector, fields, n))))
        const texts = await page
          .locator(selector)
          .evaluateAll(
            (els, n) =>
              els
                .slice(0, n)
                .map((e) => ((e as HTMLElement).innerText ?? e.textContent ?? "").trim()),
            n,
          )
        return text(clip(JSON.stringify(texts)))
      }),
  )

  server.registerTool(
    "evaluate",
    {
      description:
        "Run JavaScript in the page as an async function body (use return). With ref/selector the element is `el`. " +
        "Result is JSON (max 20k chars).",
      inputSchema: { script: z.string().max(50_000), ...target },
    },
    ({ script, ref, selector }) =>
      guarded(async () => {
        const { page } = requireActive()
        const fn = new AsyncFunction("el", script)
        const result =
          ref || selector
            ? await (
                await locate(page, { ref, selector }).first().elementHandle({ timeout: 10_000 })
              ).evaluate(fn)
            : await page.evaluate(fn)
        return text(
          clip(result === undefined ? "undefined" : (JSON.stringify(result) ?? String(result))),
        )
      }),
  )

  // ---------- acting on the page ----------

  server.registerTool(
    "act",
    {
      description:
        "Act on an element (ref or selector): click | dblclick | fill(value) | type(value, keystrokes) | " +
        "press(key, element optional, e.g. Enter, Control+A) | select(values) | check | uncheck | hover | " +
        'focus | scroll(into view) | upload(files: "upload:<name>" sent from the person computer, ' +
        '"download:<name>", "image:<id|title>"; without ref/selector it fills the file chooser the page opened).',
      inputSchema: {
        action: z.enum([
          "click",
          "dblclick",
          "fill",
          "type",
          "press",
          "select",
          "check",
          "uncheck",
          "hover",
          "focus",
          "scroll",
          "upload",
        ]),
        ...target,
        value: z.string().optional(),
        key: z.string().optional(),
        values: z.array(z.string()).optional().describe("select: option values or labels"),
        files: z.array(z.string()).optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
      },
    },
    (a) =>
      guarded(async () => {
        const { page } = requireActive()
        const hasTarget = Boolean(a.ref || a.selector)
        if (a.action === "upload" && !hasTarget) {
          const files = await uploadFiles(need(a.files, "files"))
          if (!(await fillChooser(files)))
            throw new Error(
              "No file chooser is open; click the page's upload button first, or give the file input's ref",
            )
          await settle(page)
          return text(
            `uploaded ${files.map((f) => f.name).join(", ")}\n${await pageSummary(requireActive().page)}`,
          )
        }
        if (a.action === "press" && !hasTarget) {
          await page.keyboard.press(need(a.key, "key"))
          await settle(page)
          return text(await pageSummary(requireActive().page))
        }
        if (!hasTarget) throw new Error("ref or selector is required")
        const el = locate(page, a).first()
        let note = "ok"
        switch (a.action) {
          case "click":
            await el.click({ button: a.button ?? "left" })
            break
          case "dblclick":
            await el.dblclick()
            break
          case "fill":
            await el.fill(a.value ?? "")
            return text("filled")
          case "type":
            await el.pressSequentially(need(a.value, "value"), { delay: 20 })
            return text("typed")
          case "press":
            await el.press(need(a.key, "key"))
            break
          case "select":
            note = `selected ${JSON.stringify(await el.selectOption(a.values ?? need(a.value, "values")))}`
            break
          case "check":
            await el.check()
            break
          case "uncheck":
            await el.uncheck()
            break
          case "hover":
            await el.hover()
            return text("hovered")
          case "focus":
            await el.focus()
            return text("focused")
          case "scroll":
            await el.scrollIntoViewIfNeeded()
            return text("scrolled into view")
          case "upload": {
            const files = await uploadFiles(need(a.files, "files"))
            await el.setInputFiles(files)
            return text(`uploaded ${files.map((f) => f.name).join(", ")}`)
          }
        }
        await settle(page)
        return text(`${note}\n${await pageSummary(requireActive().page)}`)
      }),
  )

  server.registerTool(
    "wait",
    {
      description:
        "Wait for: selector (gone=true to wait until hidden) | text | url (glob, e.g. **/done) | load " +
        "(load, domcontentloaded, networkidle) | ms.",
      inputSchema: {
        selector: z.string().optional(),
        text: z.string().optional(),
        url: z.string().optional(),
        load: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
        ms: z.number().int().min(0).max(60_000).optional(),
        gone: z.boolean().optional(),
        timeout_ms: z.number().int().min(0).max(120_000).optional(),
      },
    },
    (a) =>
      guarded(async () => {
        const { page } = requireActive()
        const timeout = a.timeout_ms ?? 30_000
        const state = a.gone ? ("hidden" as const) : ("visible" as const)
        if (a.ms !== undefined) await page.waitForTimeout(a.ms)
        else if (a.selector) await page.locator(a.selector).first().waitFor({ state, timeout })
        else if (a.text) await page.getByText(a.text).first().waitFor({ state, timeout })
        else if (a.url) await page.waitForURL(a.url, { timeout })
        else if (a.load) await page.waitForLoadState(a.load, { timeout })
        else throw new Error("Give selector, text, url, load or ms")
        return text(`done\n${await pageSummary(page)}`)
      }),
  )

  server.registerTool(
    "input",
    {
      description:
        "Raw mouse/keyboard at viewport CSS px (see screenshot): click(x,y,button?,count?) | move(x,y) | " +
        "drag(x,y,to_x,to_y) | wheel(delta_y, delta_x?, x?, y?) | type(text, into focus) | key(key).",
      inputSchema: {
        action: z.enum(["click", "move", "drag", "wheel", "type", "key"]),
        x: z.number().min(0).optional(),
        y: z.number().min(0).optional(),
        to_x: z.number().min(0).optional(),
        to_y: z.number().min(0).optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        count: z.number().int().min(1).max(3).optional(),
        delta_x: z.number().optional(),
        delta_y: z.number().optional(),
        text: z.string().optional(),
        key: z.string().optional(),
      },
    },
    (a) =>
      guarded(async () => {
        const { page } = requireActive()
        const m = page.mouse
        switch (a.action) {
          case "click":
            await m.click(need(a.x, "x"), need(a.y, "y"), {
              button: a.button ?? "left",
              clickCount: a.count ?? 1,
            })
            await settle(page)
            return text(await pageSummary(requireActive().page))
          case "move":
            await m.move(need(a.x, "x"), need(a.y, "y"), { steps: 5 })
            return text("moved")
          case "drag":
            await m.move(need(a.x, "x"), need(a.y, "y"))
            await m.down()
            await m.move(need(a.to_x, "to_x"), need(a.to_y, "to_y"), { steps: 15 })
            await m.up()
            return text("dragged")
          case "wheel":
            if (a.x !== undefined && a.y !== undefined) await m.move(a.x, a.y)
            await m.wheel(a.delta_x ?? 0, a.delta_y ?? 0)
            await page.waitForTimeout(200)
            return text("scrolled")
          case "type":
            await page.keyboard.type(need(a.text, "text"), { delay: 20 })
            return text("typed")
          case "key":
            await page.keyboard.press(need(a.key, "key"))
            await settle(page)
            return text(await pageSummary(requireActive().page))
        }
      }),
  )

  server.registerTool(
    "page_log",
    {
      description:
        "Recent console messages, page errors, failed/4xx/5xx requests and dialogs (alert/confirm/prompt). " +
        "dialog sets how future dialogs are answered (default dismiss).",
      inputSchema: {
        kinds: z.array(z.enum(["console", "error", "request", "dialog"])).optional(),
        limit: z.number().int().min(1).max(300).optional(),
        clear: z.boolean().optional(),
        dialog: z.enum(["accept", "dismiss"]).optional(),
        prompt_text: z.string().optional().describe("Answer for prompt() when accepting"),
      },
    },
    (a) =>
      guarded(async () => {
        if (a.dialog) setDialogPolicy(a.dialog, a.prompt_text)
        const log = readLog({
          kinds: a.kinds as LogKind[] | undefined,
          limit: a.limit ?? 50,
          clear: a.clear ?? false,
        })
        return text(
          `dialogs: ${getDialogPolicy().action}\n` +
            log.map((e) => `${e.t} ${e.kind} ${e.text}`).join("\n"),
        )
      }),
  )

  // ---------- files, bookmarks, history ----------

  server.registerTool(
    "files",
    {
      description:
        "Files: downloads (saved automatically when the browser downloads) and uploads (sent by the person " +
        "from their computer via the dashboard). list(store?) | read(name: text as text, images as image) | " +
        "delete(name). Put one into a page with act upload.",
      inputSchema: {
        action: z.enum(["list", "read", "delete"]),
        store: z
          .enum(["upload", "download"])
          .optional()
          .describe("Default: both for list, download for read/delete"),
        name: z.string().optional().describe("File name or part of it (newest match)"),
      },
    },
    (a) =>
      guarded(async () => {
        if (a.action === "list")
          return json({
            files: (await listFiles(a.store)).slice(0, 100),
            downloading: pendingDownloads(),
            file_chooser_open: pendingChooser(),
          })
        const store: Store = a.store ?? "download"
        if (a.action === "delete")
          return text(`deleted ${await deleteStored(store, need(a.name, "name"))}`)
        const { file, data } = await readStored(store, need(a.name, "name"))
        const mime = mimeOf(file.name)
        if (mime.startsWith("image/"))
          return {
            content: [
              { type: "text", text: file.name },
              { type: "image", data: data.toString("base64"), mimeType: mime },
            ],
          }
        if (
          /^text\/|json|csv|xml|javascript/.test(mime) ||
          /\.(md|log|tsv|yaml|yml)$/i.test(file.name)
        )
          return text(`${file.name}\n\n${clip(data.toString("utf8"), 100_000)}`)
        return json({ ...file, mime, url: `/files/${store}/${encodeURIComponent(file.name)}` })
      }),
  )

  server.registerTool(
    "bookmarks",
    {
      description:
        "Chromium bookmarks of the open profile. list(query?) | add(title, url, folder?) | " +
        'update(id, title?, url?, folder?, index?) | delete(id, folders recursively) | open(id). folder is a path like "Bookmarks bar/News" (created if missing) or an id.',
      inputSchema: {
        action: z.enum(["list", "add", "update", "delete", "open"]),
        id: z.string().optional(),
        query: z.string().optional(),
        title: z.string().optional(),
        url: z.string().optional(),
        folder: z.string().optional(),
        index: z.number().int().min(0).optional(),
      },
    },
    (a) =>
      guarded(async () => {
        switch (a.action) {
          case "list":
            return json(await listBookmarks(a.query))
          case "add":
            return json(
              await addBookmark({ title: need(a.title, "title"), url: a.url, folder: a.folder }),
            )
          case "update":
            return json(await updateBookmark(need(a.id, "id"), a))
          case "delete":
            await deleteBookmark(need(a.id, "id"))
            return text("deleted")
          case "open": {
            const hit = (await listBookmarks()).find((b) => b.id === a.id)
            if (!hit?.url) throw new Error(`No bookmark with id ${a.id}`)
            const { page } = requireActive()
            await page.goto(hit.url)
            return text(await pageSummary(page))
          }
        }
      }),
  )

  server.registerTool(
    "history",
    {
      description: "Browsing history (Chromium) of the open or given profile, newest first.",
      inputSchema: {
        query: z.string().optional().describe("Text in URL or title"),
        profile: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    (a) =>
      guarded(async () => {
        const id = a.profile ? (await findProfile(a.profile)).id : requireActive().profileId
        return json(await readHistory(id, { query: a.query, limit: a.limit ?? 30 }))
      }),
  )

  // ---------- profiles ----------

  server.registerTool(
    "profiles",
    {
      description:
        "Browser profiles (each keeps its own logins). list | create(name, settings) | update(profile, " +
        "settings; reopens an open profile; switching engine starts logged out) | delete(profile) | " +
        "cookies(profile, domain?, details?: login state per site, never cookie values).",
      inputSchema: {
        action: z.enum(["list", "create", "update", "delete", "cookies"]),
        profile: z.string().optional().describe("Id or name"),
        name: z.string().min(1).max(100).optional(),
        notes: z.string().max(2000).optional(),
        engine: z.enum(["chromium", "firefox", "webkit"]).optional(),
        device: z.enum(["desktop", "mobile"]).optional(),
        locale: z.string().optional().describe("e.g. ko-KR"),
        timezone: z.string().optional().describe("e.g. Asia/Seoul"),
        color_scheme: z.enum(["light", "dark", ""]).optional(),
        stealth: z.boolean().optional().describe("Hide automation flags (Chromium)"),
        proxy: z.string().optional().describe("http://host:port or socks5://..., empty for none"),
        domain: z.string().optional(),
        details: z.boolean().optional(),
      },
    },
    ({ action, profile, domain, details, ...input }) =>
      guarded(async () => {
        switch (action) {
          case "list": {
            const open = current()?.profileId
            return json(
              (await listProfiles()).map((p) => ({
                id: p.id,
                name: p.name,
                notes: p.notes || undefined,
                open: p.id === open || undefined,
                engine: p.engine || "chromium",
                device: p.device || "desktop",
                locale: p.locale || undefined,
                timezone: p.timezone || undefined,
                color_scheme: p.color_scheme || undefined,
                stealth: p.stealth,
                proxy: p.proxy || undefined,
              })),
            )
          }
          case "create":
            return json(await createProfile({ ...input, name: need(input.name, "name") }))
          case "update":
            return json(await updateProfile(need(profile, "profile"), input))
          case "delete": {
            const record = await findProfile(need(profile, "profile"))
            await deleteProfile(record.id)
            return text(`deleted profile "${record.name}"`)
          }
          case "cookies": {
            const record = await findProfile(need(profile, "profile"))
            const data = await profileCookies(record)
            const sites = summarize(data.cookies).filter(
              (g) => !domain || g.domain.includes(domain),
            )
            return json({
              profile: record.name,
              source: data.source,
              sites: sites.map((g) => ({
                site: g.domain,
                status: g.status,
                login: g.login,
                total: g.total,
                expired: g.expired || undefined,
                expiry: iso(g.latestExpiry),
                ...(details
                  ? {
                      cookies: g.cookies.map((c) => ({
                        name: c.name,
                        login: c.loginLike || undefined,
                        status: c.status,
                        expires: iso(c.expires),
                      })),
                    }
                  : {}),
              })),
            })
          }
        }
      }),
  )

  // ---------- jobs, runs, collected data ----------

  server.registerTool(
    "jobs",
    {
      description:
        "Saved automations / crawls run on cron. list | get(job) | create(name, profile, steps, schedule?, " +
        "enabled?) | update(job, any field) | delete(job, with runs and data) | run(job: start now, then runs get).",
      inputSchema: {
        action: z.enum(["list", "get", "create", "update", "delete", "run"]),
        job: z.string().optional().describe("Id or name"),
        name: z.string().min(1).max(100).optional(),
        profile: z.string().optional(),
        steps: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            `Actions: goto, click, fill, press, wait, waitFor, text, screenshot, scroll, extract (saves rows). E.g. ${STEP_HELP}`,
          ),
        schedule: z.string().optional().describe('Cron in the server time zone, "" for none'),
        enabled: z.boolean().optional(),
      },
    },
    ({ action, job, ...input }) =>
      guarded(async () => {
        const withNext = <T extends { id: string }>(j: T) => ({
          ...j,
          next_run: nextRun(j.id)?.toISOString() ?? null,
        })
        switch (action) {
          case "list":
            return json(
              (await listJobs()).map((j) => ({
                id: j.id,
                name: j.name,
                profile: j.profileName,
                schedule: j.schedule || undefined,
                enabled: j.enabled,
                next_run: nextRun(j.id)?.toISOString() ?? undefined,
              })),
            )
          case "get":
            return json(withNext(await findJob(need(job, "job"))))
          case "create":
            return json(
              await createJob({
                ...input,
                name: need(input.name, "name"),
                profile: need(input.profile, "profile"),
                steps: need(input.steps, "steps"),
              }),
            )
          case "update":
            return json(withNext(await updateJob(need(job, "job"), input)))
          case "delete":
            await deleteJob(need(job, "job"))
            return text("deleted")
          case "run": {
            const record = await findJob(need(job, "job"))
            const run = await startRun(record.id, "mcp")
            return json({ run: run.id, job: record.name, status: run.status })
          }
        }
      }),
  )

  server.registerTool(
    "runs",
    {
      description: "Job runs. list(job?, limit?) | get(run: status and log lines).",
      inputSchema: {
        action: z.enum(["list", "get"]),
        job: z.string().optional(),
        run: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    (a) =>
      guarded(async () => {
        if (a.action === "list") {
          const jobId = a.job ? (await findJob(a.job)).id : undefined
          return json(
            (await listRuns({ jobId, limit: a.limit ?? 20 })).map((r) => ({
              id: r.id,
              job: r.jobName,
              status: r.status,
              trigger: r.trigger,
              items: r.items,
              started: r.started,
              finished: r.finished || undefined,
              error: r.error || undefined,
            })),
          )
        }
        const run = need(a.run, "run")
        await ensureSuperuser()
        const record = await pb.collection("job_runs").getOne<JobRun>(run)
        const logs = await pb
          .collection("job_logs")
          .getFullList<JobLog>({ filter: pb.filter("run = {:run}", { run }), sort: "created" })
        return text(
          `status: ${record.status} items: ${record.items} trigger: ${record.trigger}\n` +
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

  server.registerTool(
    "crawl_data",
    {
      description:
        "Rows saved by a job's extract steps. items(job, run?, limit?, offset?: newest first) | csv(job, run?: " +
        "whole set; the dashboard serves it at /jobs/<id>/items.csv).",
      inputSchema: {
        action: z.enum(["items", "csv"]),
        job: z.string(),
        run: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    (a) =>
      guarded(async () => {
        const record = await findJob(a.job)
        if (a.action === "items") {
          const res = await listItems(record.id, {
            runId: a.run,
            limit: a.limit ?? 50,
            offset: a.offset ?? 0,
          })
          return json({
            total: res.total,
            items: res.items.map((i) => ({ ...i.data, _run: i.run, _at: i.created })),
          })
        }
        const csv = toCsv(await allItems(record.id, a.run)).replace(/^﻿/, "")
        return text(
          clip(
            `download: /jobs/${record.id}/items.csv${a.run ? `?run=${a.run}` : ""}\n\n${csv}`,
            1_000_000,
          ),
        )
      }),
  )

  // ---------- docs and images (the dashboard's 문서 and 이미지 pages) ----------

  server.registerTool(
    "docs",
    {
      description:
        "Markdown notes ([[Title]] links, ![[image title]] embeds, #tags). list(query?, tag?) | read(doc) | " +
        "playbook(host?: the site playbook for the open page or a host, with its title even when missing) | " +
        "write(title, body, doc?: create, replace or rename) | append(doc, body; creates if missing) | delete(doc).",
      inputSchema: {
        action: z.enum(["list", "read", "playbook", "write", "append", "delete"]),
        doc: z.string().optional().describe("Title or id"),
        host: z.string().optional().describe("playbook: e.g. instagram.com"),
        title: z.string().min(1).max(200).optional(),
        body: z.string().max(1_000_000).optional(),
        query: z.string().optional(),
        tag: z.string().optional(),
      },
    },
    (a) =>
      guarded(async () => {
        switch (a.action) {
          case "list": {
            const docs = await listDocs({ q: a.query, tag: a.tag })
            return json({
              docs: docs.map((d) => ({
                title: d.title,
                tags: d.tags?.length ? d.tags : undefined,
                updated: d.updated,
              })),
              tags: await allTags(),
            })
          }
          case "playbook": {
            const url = a.host
              ? `https://${a.host.replace(/^https?:\/\//, "")}`
              : requireActive().page.url()
            const found = await findPlaybook(url)
            if (!found) throw new Error("Give host, or open a web page first")
            if (!found.title)
              return text(
                `No playbook for ${found.host}. Create one with docs write title "${playbookTitle(found.host)}".`,
              )
            const d = await getDoc(found.title)
            return text(`# ${d.title}\nupdated ${d.updated}\n\n${d.body}`)
          }
          case "read": {
            const d = await getDoc(need(a.doc, "doc"))
            const links = wikiTargets(d.body)
            const back = (await backlinks(d.title)).map((b) => b.title)
            return text(
              `# ${d.title}\nupdated ${d.updated}` +
                (d.tags?.length ? ` tags ${d.tags.join(",")}` : "") +
                (links.length ? `\nlinks: ${links.join(", ")}` : "") +
                (back.length ? `\nbacklinks: ${back.join(", ")}` : "") +
                `\n\n${d.body}`,
            )
          }
          case "write": {
            const saved = await saveDoc({
              ref: a.doc,
              title: need(a.title, "title"),
              body: a.body ?? "",
            })
            return text(`saved "${saved.title}" (${saved.id})`)
          }
          case "append": {
            const saved = await appendDoc(need(a.doc, "doc"), need(a.body, "body"))
            return text(`appended to "${saved.title}"`)
          }
          case "delete":
            await deleteDoc(need(a.doc, "doc"))
            return text("deleted")
        }
      }),
  )

  server.registerTool(
    "images",
    {
      description:
        "Stored images (embed in notes as ![[title]]). list(limit?, job?) | get(image) | " +
        "capture(title?, full_page?: screenshot of the open page saved here) | delete(image).",
      inputSchema: {
        action: z.enum(["list", "get", "capture", "delete"]),
        image: z.string().optional().describe("Id or title"),
        title: z.string().max(200).optional(),
        full_page: z.boolean().optional(),
        job: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    (a) =>
      guarded(async () => {
        switch (a.action) {
          case "list":
            return json(
              (await listImages({ limit: a.limit ?? 50, job: a.job })).map((i) => ({
                id: i.id,
                title: i.title,
                source: i.source,
                page_url: i.page_url || undefined,
                job: i.job || undefined,
                created: i.created,
              })),
            )
          case "capture": {
            const image = await captureImage(requireActive().page, {
              title: a.title,
              source: "mcp",
              fullPage: a.full_page ?? false,
            })
            return json({ id: image.id, title: image.title, embed: `![[${image.title}]]` })
          }
          case "get": {
            const record = await findImage(need(a.image, "image"))
            if (!record) throw new Error(`Image not found: ${a.image}`)
            const res = await imageFile(record)
            if (!res.ok) throw new Error(`Could not read the image (${res.status})`)
            return {
              content: [
                { type: "text", text: `${record.title} (${record.id}) ${record.page_url}`.trim() },
                {
                  type: "image",
                  data: Buffer.from(await res.arrayBuffer()).toString("base64"),
                  mimeType: res.headers.get("content-type") ?? "image/png",
                },
              ],
            }
          }
          case "delete":
            await deleteImage(need(a.image, "image"))
            return text("deleted")
        }
      }),
  )

  return server
}
