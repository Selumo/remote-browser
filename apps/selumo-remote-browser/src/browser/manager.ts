import { mkdir } from "node:fs/promises"
import path from "node:path"
import { chromium, type BrowserContext, type Page } from "playwright"
import { env } from "../env.js"

/**
 * One headful Chromium on the shared Xvfb display, so noVNC shows exactly what the AI and the jobs
 * are driving. Each profile has its own user data directory under DATA_DIR/profiles, which keeps
 * cookies and storage (logins) across restarts.
 */
export type ActiveBrowser = {
  profileId: string
  context: BrowserContext
  page: Page
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

export async function openProfile(profileId: string, startUrl?: string): Promise<ActiveBrowser> {
  if (!PROFILE_ID.test(profileId)) throw new Error("Invalid profile id")
  if (opening) await opening.catch(() => undefined)
  if (active?.profileId === profileId) return active
  if (active) await closeActive()

  opening = (async () => {
    const dir = path.join(env.DATA_DIR, "profiles", profileId)
    await mkdir(dir, { recursive: true })
    const context = await chromium.launchPersistentContext(dir, {
      headless: false,
      viewport: null,
      args: [
        "--start-maximized",
        "--window-position=0,0",
        `--window-size=${env.SCREEN_WIDTH},${env.SCREEN_HEIGHT}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-crash-restore-bubble",
      ],
      env: { ...process.env, DISPLAY: env.DISPLAY },
    })
    const page = context.pages()[0] ?? (await context.newPage())
    const browser: ActiveBrowser = { profileId, context, page }
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
    if (startUrl) await page.goto(startUrl).catch(() => undefined)
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
