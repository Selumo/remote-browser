import type { Page } from "playwright"
import { env } from "../env.js"
import { checkChallenge } from "./challenge.js"
import { detectLogin } from "./login.js"

/**
 * Requests for a person: log in, clear a bot check, enter something only they know, or confirm.
 * One request at a time. It shows as a banner on the dashboard (with 완료 / 취소 buttons) and,
 * when NOTIFY_URL is set, is posted there too (Discord, Slack or ntfy style webhook). The request
 * ends when the person presses 완료 or 취소, when the page shows the problem is gone (login form
 * or bot check no longer there), or on timeout.
 */
export type HelpKind = "login" | "captcha" | "input" | "confirm"
export type HelpOutcome = "done" | "cancelled" | "timeout"
export type HelpRequest = {
  id: string
  kind: HelpKind
  message: string
  site: string
  from: string
  since: string
}

let open: (HelpRequest & { outcome?: HelpOutcome }) | null = null

export function currentHelp(): HelpRequest | null {
  return open && !open.outcome ? open : null
}

/** Called by the dashboard buttons. */
export function answerHelp(id: string, outcome: "done" | "cancelled"): boolean {
  if (!open || open.id !== id || open.outcome) return false
  open.outcome = outcome
  return true
}

const LABEL: Record<HelpKind, string> = {
  login: "로그인이 필요해요",
  captcha: "봇 확인을 풀어 주세요",
  input: "직접 입력이 필요해요",
  confirm: "확인이 필요해요",
}

export function helpLabel(kind: HelpKind): string {
  return LABEL[kind]
}

async function notify(req: HelpRequest): Promise<void> {
  if (!env.NOTIFY_URL) return
  const text = `[remote-browser] ${LABEL[req.kind]}${req.site ? ` (${req.site})` : ""}: ${req.message}`
  await fetch(env.NOTIFY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text, text }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e) => console.error("[help] notify failed", e))
}

/** Has the page moved past what the person was asked to do? */
async function solved(kind: HelpKind, page: Page): Promise<boolean> {
  if (kind === "login") return !(await detectLogin(page).catch(() => null))
  if (kind === "captcha") return !(await checkChallenge(page).catch(() => null))
  return false
}

export async function askHuman(
  getPage: () => Page,
  input: { kind: HelpKind; message?: string | undefined; from: string; timeoutMs: number },
): Promise<HelpOutcome> {
  if (currentHelp()) throw new Error("Another request is already waiting for a person")
  let site = ""
  try {
    site = new URL(getPage().url()).hostname
  } catch {
    // about:blank and similar
  }
  const req: HelpRequest = {
    id: Math.random().toString(36).slice(2, 10),
    kind: input.kind,
    message: input.message || LABEL[input.kind],
    site,
    from: input.from,
    since: new Date().toISOString(),
  }
  open = req
  console.log(`[help] ${req.kind} requested by ${req.from}: ${req.message}`)
  void notify(req)
  // Auto-detection only counts after the problem was actually seen, so asking before the login
  // page has loaded does not end the request at once.
  let seen = !(await solved(req.kind, getPage()).catch(() => true))
  const until = Date.now() + input.timeoutMs
  try {
    while (Date.now() < until) {
      if (open?.id === req.id && open.outcome) return open.outcome as HelpOutcome
      const ok = await solved(req.kind, getPage()).catch(() => false)
      if (!ok) seen = true
      else if (seen && (req.kind === "login" || req.kind === "captcha")) return "done"
      await new Promise((r) => setTimeout(r, 2000))
    }
    return "timeout"
  } finally {
    if (open?.id === req.id) open = null
    console.log(`[help] ${req.kind} request ${req.id} ended`)
  }
}
