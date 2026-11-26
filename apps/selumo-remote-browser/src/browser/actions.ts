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

/** Value of the focused editable element in any frame, for checking what an insertion did. */
export async function focusedValue(page: Page): Promise<string | null> {
  for (const frame of page.frames()) {
    const v = await frame
      .evaluate(() => {
        if (!document.hasFocus()) return null
        const el = document.activeElement as HTMLInputElement | HTMLElement | null
        if (!el) return null
        if ("value" in el && typeof el.value === "string") return el.value
        return el.isContentEditable ? (el.textContent ?? "") : null
      })
      .catch(() => null)
    if (v !== null) return v
  }
  return null
}

/**
 * Inserts text at the focused element the way a person's typing would: execCommand("insertText")
 * fires beforeinput/input with inputType insertText, which React and other frameworks handle like
 * keyboard input. Falls back to CDP insertText when the focus is not an editable element.
 */
export async function insertAtFocus(page: Page, text: string): Promise<void> {
  for (const frame of page.frames()) {
    const done = await frame
      .evaluate((t) => {
        if (!document.hasFocus()) return false
        const el = document.activeElement as HTMLElement | null
        if (!el) return false
        const editable =
          el.isContentEditable ||
          el instanceof HTMLTextAreaElement ||
          (el instanceof HTMLInputElement &&
            /^(text|search|email|url|tel|password|number|)$/.test(el.type))
        if (!editable) return false
        return document.execCommand("insertText", false, t)
      }, text)
      .catch(() => false)
    if (done) return
  }
  await page.keyboard.insertText(text)
}
