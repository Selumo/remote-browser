import type { Page } from "playwright"

/**
 * Bot checks (CAPTCHA, "unusual traffic", Cloudflare interstitials). They are never solved
 * automatically: the app notices them, tells the AI and the dashboard, and waits for a person
 * to clear them through noVNC.
 */
export type Challenge = { kind: string; url: string; since: string }

const URL_RULES: [RegExp, string][] = [
  [/google\.[a-z.]+\/sorry\//i, "Google unusual traffic"],
  [/challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform/i, "Cloudflare check"],
  [/nid\.naver\.com\/.*captcha|captcha\.naver/i, "Naver captcha"],
  [/[/?&.]captcha/i, "CAPTCHA page"],
]

const FRAME_RULES: [RegExp, string][] = [
  [/google\.com\/recaptcha|recaptcha\.net/i, "reCAPTCHA"],
  [/hcaptcha\.com/i, "hCaptcha"],
  [/challenges\.cloudflare\.com/i, "Cloudflare Turnstile"],
  [/arkoselabs|funcaptcha/i, "Arkose captcha"],
]

const TEXT_RULES: [RegExp, string][] = [
  [/unusual traffic|automated queries/i, "unusual traffic"],
  [/verify (that )?you are (a )?human|are you a robot|i'?m not a robot/i, "human check"],
  [/just a moment|checking your browser|attention required/i, "Cloudflare check"],
  [/자동입력\s*방지|로봇이 아닙니다|자동 접속|비정상적인 접근|보안문자/i, "자동입력 방지"],
]

let current: Challenge | null = null

export function currentChallenge(): Challenge | null {
  return current
}

/** Looks at the page's URL, frames, title and the start of its text. Cheap enough to poll. */
export async function detectChallenge(page: Page): Promise<string | null> {
  if (page.isClosed()) return null
  const url = page.url()
  for (const [re, kind] of URL_RULES) if (re.test(url)) return kind
  for (const frame of page.frames()) {
    const f = frame.url()
    for (const [re, kind] of FRAME_RULES) {
      // A visible reCAPTCHA anchor or challenge frame, not just an invisible badge script.
      if (re.test(f) && /anchor|challenge|bframe|turnstile|hcaptcha/i.test(f)) return kind
    }
  }
  const sample = await page
    .evaluate(() => `${document.title}\n${(document.body?.innerText ?? "").slice(0, 3000)}`)
    .catch(() => "")
  for (const [re, kind] of TEXT_RULES) if (re.test(sample)) return kind
  return null
}

/** Updates the shared challenge state from the page and returns it. */
export async function checkChallenge(page: Page): Promise<Challenge | null> {
  const kind = await detectChallenge(page)
  if (!kind) {
    current = null
    return null
  }
  if (!current || current.kind !== kind)
    current = { kind, url: page.url(), since: new Date().toISOString() }
  return current
}

export function clearChallenge(): void {
  current = null
}

/** Waits until a person clears the check (polls every 2 s). Returns false on timeout. */
export async function waitForHuman(
  getPage: () => Page,
  timeoutMs: number,
  onWait?: (c: Challenge) => void,
): Promise<boolean> {
  const until = Date.now() + timeoutMs
  let announced = false
  while (Date.now() < until) {
    const c = await checkChallenge(getPage()).catch(() => null)
    if (!c) return true
    if (!announced) {
      onWait?.(c)
      announced = true
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

export function challengeNote(c: Challenge | null): string {
  return c
    ? `\n\n⚠ BOT CHECK: ${c.kind} at ${c.url}. Do not try to solve it. Ask the person to clear it in the ` +
        `dashboard's remote screen (noVNC), then call browser_wait_for_human.`
    : ""
}
