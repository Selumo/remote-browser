import type { Page } from "playwright"

/**
 * Notices when the browser is on a sign-in page: a known login URL, or a visible password field.
 * Used to tell the AI (page summaries), to pause jobs that were sent to a login page, and to tell
 * when a person has finished logging in.
 */
const LOGIN_URL: RegExp[] = [
  /accounts\.google\.com\/(v3\/)?signin|accounts\.google\.com\/ServiceLogin/i,
  /nid\.naver\.com\/nidlogin/i,
  /accounts\.kakao\.com\/login|kauth\.kakao\.com/i,
  /login\.microsoftonline\.com|login\.live\.com/i,
  /github\.com\/(login|session)/i,
  /appleid\.apple\.com\/auth/i,
  /[/.](login|signin|sign-in|sign_in|log-in|logon|auth\/login)([/?#._-]|$)/i,
]

export type LoginWall = { site: string; reason: "url" | "password field" }

export async function detectLogin(page: Page): Promise<LoginWall | null> {
  if (page.isClosed()) return null
  const url = page.url()
  let site = ""
  try {
    site = new URL(url).hostname
  } catch {
    return null
  }
  if (LOGIN_URL.some((re) => re.test(url))) return { site, reason: "url" }
  const hasPassword = await page
    .locator('input[type="password"]:visible')
    .count()
    .then((n) => n > 0)
    .catch(() => false)
  return hasPassword ? { site, reason: "password field" } : null
}

export function loginNote(wall: LoginWall | null): string {
  return wall
    ? `\n\n⚠ LOGIN PAGE (${wall.site}). If you were not given credentials, call browser ` +
        `ask_human with kind "login" so the person logs in through the remote view.`
    : ""
}
