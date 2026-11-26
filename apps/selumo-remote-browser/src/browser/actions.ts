import type { Locator, Page } from "playwright"
import { challengeNote, checkChallenge } from "./challenge.js"
import { pendingChooser } from "./files.js"
import { detectLogin, loginNote } from "./login.js"
import { playbookNote } from "./playbook.js"

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

/** URL and title, plus a warning when the page is a bot check (every MCP action reports it). */
export async function pageSummary(page: Page): Promise<string> {
  const title = await page.title().catch(() => "")
  const challenge = await checkChallenge(page).catch(() => null)
  const login = challenge ? null : await detectLogin(page).catch(() => null)
  const url = page.url()
  const shown = url.length > 300 ? `${url.slice(0, 300)}…` : url
  const chooser = pendingChooser()
  const fileNote = chooser
    ? `\n\n📎 FILE CHOOSER open (${chooser.multiple ? "multiple files" : "one file"}): act upload with files ` +
      `and no ref. Files from the person's computer arrive as "upload:<name>" (files list); ask_human ` +
      `kind "input" to ask them to send one through the dashboard.`
    : ""
  const playbook = await playbookNote(url).catch(() => "")
  return `url: ${shown}\ntitle: ${title}${challengeNote(challenge)}${loginNote(login)}${fileNote}${playbook}`
}

/**
 * Gives a click or key press time to start a navigation and lets it reach DOMContentLoaded, so
 * the summary returned to the AI describes the page it caused, not the one it left.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(400)
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined)
}
