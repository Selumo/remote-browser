import { mkdir } from "node:fs/promises"
import path from "node:path"
import {
  chromium,
  devices,
  firefox,
  webkit,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright"
import { env } from "../env.js"

/**
 * One headful browser on the shared KasmVNC display, so the remote view shows exactly what the AI and the jobs
 * are driving. Each profile has its own user data directory under DATA_DIR/profiles, which keeps
 * cookies and storage (logins) across restarts. Data is per engine, so a profile switched to
 * another engine starts logged out on that engine.
 */
export type Engine = "chromium" | "firefox" | "webkit"

export type BrowserSettings = {
  id: string
  engine?: Engine | ""
  device?: "desktop" | "mobile" | ""
  locale?: string
  timezone?: string
  color_scheme?: "light" | "dark" | ""
  stealth?: boolean
  proxy?: string
}

export type ActiveBrowser = {
  profileId: string
  engine: Engine
  context: BrowserContext
  page: Page
}

export const ENGINES: Engine[] = ["chromium", "firefox", "webkit"]

/** Chromium keeps the original path so profiles made before engines existed keep their logins. */
export function profileDir(profileId: string, engine: Engine): string {
  return path.join(
    env.DATA_DIR,
    "profiles",
    engine === "chromium" ? profileId : `${profileId}-${engine}`,
  )
}

function contextOptions(
  s: BrowserSettings,
  engine: Engine,
): BrowserContextOptions & {
  args?: string[]
  ignoreDefaultArgs?: string[]
} {
  const base: BrowserContextOptions & { args?: string[]; ignoreDefaultArgs?: string[] } = {
    locale: s.locale || "ko-KR",
    timezoneId: s.timezone || env.SCHEDULE_TZ,
    ...(s.color_scheme ? { colorScheme: s.color_scheme } : {}),
    ...(s.proxy ? { proxy: { server: s.proxy } } : {}),
  }
  if (s.device === "mobile") {
    // Phone sized page inside the desktop window. DPR 1: measured no memory gain from higher.
    const d = engine === "webkit" ? devices["iPhone 13"] : devices["Pixel 7"]
    const { isMobile, hasTouch, deviceScaleFactor: _dpr, defaultBrowserType: _b, ...rest } = d
    Object.assign(base, rest, { deviceScaleFactor: 1 })
    // Firefox has no mobile emulation; it gets the size and user agent only.
    if (engine !== "firefox") Object.assign(base, { isMobile, hasTouch })
  } else {
    base.viewport = null
  }
  if (engine === "chromium") {
    base.args = [
      "--start-maximized",
      "--window-position=0,0",
      `--window-size=${env.SCREEN_WIDTH},${env.SCREEN_HEIGHT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-crash-restore-bubble",
      ...(s.stealth ? ["--disable-blink-features=AutomationControlled"] : []),
    ]
    if (s.stealth) base.ignoreDefaultArgs = ["--enable-automation"]
  }
  return base
}

let active: ActiveBrowser | null = null
let opening: Promise<ActiveBrowser> | null = null

const PROFILE_ID = /^[a-z0-9]{15}$/

export function current(): ActiveBrowser | null {
  return active
}

export function requireActive(): ActiveBrowser {
  if (!active) throw new Error("No browser is open. Open a profile first.")
  if (active.page.isClosed()) {
    const next = active.context.pages().at(-1)
    if (!next) throw new Error("The browser has no open tab.")
    active.page = next
  }
  return active
}

/** Opens a profile; an already open one is reused unless `reopen` (settings changed). */
export async function openProfile(
  settings: BrowserSettings,
  opts: { reopen?: boolean } = {},
): Promise<ActiveBrowser> {
  const profileId = settings.id
  if (!PROFILE_ID.test(profileId)) throw new Error("Invalid profile id")
  if (opening) await opening.catch(() => undefined)
  if (active?.profileId === profileId && !opts.reopen) return active
  if (active) await closeActive()

  const engine: Engine = settings.engine || "chromium"
  opening = (async () => {
    const dir = profileDir(profileId, engine)
    await mkdir(dir, { recursive: true })
    const type = engine === "firefox" ? firefox : engine === "webkit" ? webkit : chromium
    const context = await type.launchPersistentContext(dir, {
      headless: false,
      env: { ...process.env, DISPLAY: env.DISPLAY },
      ...contextOptions(settings, engine),
    })
    const page = context.pages()[0] ?? (await context.newPage())
    const browser: ActiveBrowser = { profileId, engine, context, page }
    // Follow popups opened by the page (target=_blank, window.open). Chrome also creates pages
    // with no opener, such as a prerendered new tab page, which must not steal the focus.
    context.on("page", (p) => {
      void p.opener().then((opener) => {
        if (opener) browser.page = p
      })
    })
    context.on("close", () => {
      if (active === browser) active = null
    })
    active = browser
    return browser
  })()

  try {
    return await opening
  } finally {
    opening = null
  }
}

export async function closeActive(): Promise<void> {
  const browser = active
  active = null
  if (browser) await browser.context.close().catch(() => undefined)
}

export function tabs(): { index: number; url: string; active: boolean }[] {
  const browser = requireActive()
  return browser.context.pages().map((p, index) => ({
    index,
    url: p.url(),
    active: p === browser.page,
  }))
}

export async function selectTab(index: number): Promise<Page> {
  const browser = requireActive()
  const page = browser.context.pages()[index]
  if (!page) throw new Error(`No tab at index ${index}`)
  await page.bringToFront()
  browser.page = page
  return page
}
