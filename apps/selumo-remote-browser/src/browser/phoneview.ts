import type { CDPSession, Page } from "playwright"
import { current } from "./manager.js"

/**
 * While someone controls the browser from a phone (takeover page), the open tab can be rendered
 * at phone width so the site switches to its mobile layout and stays readable. It is undone when
 * they turn it off, and automatically a few minutes after the takeover page stops polling, so the
 * AI and the remote view get the normal desktop page back. Chromium only (DevTools emulation).
 */
const WIDTH = 412
const HEIGHT = 860
const IDLE_MS = 3 * 60_000

let state: { page: Page; cdp: CDPSession; lastSeen: number } | null = null
let timer: NodeJS.Timeout | null = null

export function phoneViewOn(): boolean {
  return Boolean(state && !state.page.isClosed() && state.page === current()?.page)
}

export async function setPhoneView(on: boolean): Promise<boolean> {
  const browser = current()
  if (!on || !browser || browser.engine !== "chromium") {
    await clear()
    return false
  }
  if (state && state.page !== browser.page) await clear()
  if (!state) {
    const cdp = await browser.context.newCDPSession(browser.page)
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 2,
      mobile: true,
    })
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
    state = { page: browser.page, cdp, lastSeen: Date.now() }
    timer ??= setInterval(() => {
      if (state && Date.now() - state.lastSeen > IDLE_MS) void clear()
    }, 30_000)
  }
  state.lastSeen = Date.now()
  return true
}

/** The takeover page polls screenshots; each one keeps the phone view alive. */
export function touchPhoneView(): void {
  if (state) state.lastSeen = Date.now()
}

async function clear(): Promise<void> {
  const s = state
  state = null
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (!s || s.page.isClosed()) return
  await s.cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined)
  await s.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => undefined)
  await s.cdp.detach().catch(() => undefined)
}
