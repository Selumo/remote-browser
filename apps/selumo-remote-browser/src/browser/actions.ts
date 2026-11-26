import type { Locator, Page } from "playwright"

export type Target = { ref?: string | undefined; selector?: string | undefined }

/**
 * Accessibility snapshot for an AI: `[ref=eN]` handles usable as `aria-ref=eN` locators, iframe
 * contents included. With `boxes`, every element also gets `[box=x,y,w,h]` in viewport CSS pixels,
 * which is what the mouse_* tools take.
 */
export async function snapshot(page: Page, opts: { boxes?: boolean } = {}): Promise<string> {
  return page.ariaSnapshot({ mode: "ai", boxes: opts.boxes ?? false, timeout: 15_000 })
}

export function locate(page: Page, target: Target): Locator {
  if (target.ref) return page.locator(`aria-ref=${target.ref}`)
  if (target.selector) return page.locator(target.selector)
  throw new Error("Give either ref (from a snapshot) or a selector")
}

export async function pageSummary(page: Page): Promise<string> {
  const title = await page.title().catch(() => "")
  return `url: ${page.url()}\ntitle: ${title}`
}

/**
 * Gives a click or key press time to start a navigation and lets it reach DOMContentLoaded, so
 * the summary returned to the AI describes the page it caused, not the one it left.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(400)
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined)
}
