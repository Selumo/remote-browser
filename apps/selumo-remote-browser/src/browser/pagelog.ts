import type { Dialog, Page } from "playwright"

/**
 * Recent page events for the AI: console messages, uncaught errors, failed requests, HTTP errors
 * and dialogs (alert, confirm, prompt). Dialogs are answered by the current policy; without a
 * listener Playwright would dismiss them silently and the AI would never know.
 */
export type LogKind = "console" | "error" | "request" | "dialog"
export type LogEntry = { t: string; kind: LogKind; text: string }

const MAX = 300
const entries: LogEntry[] = []
let dialogPolicy: { action: "accept" | "dismiss"; promptText?: string | undefined } = {
  action: "dismiss",
}

function push(kind: LogKind, text: string): void {
  entries.push({ t: new Date().toISOString().slice(11, 19), kind, text: text.slice(0, 500) })
  if (entries.length > MAX) entries.splice(0, entries.length - MAX)
}

async function answer(dialog: Dialog): Promise<void> {
  const { action, promptText } = dialogPolicy
  push("dialog", `${dialog.type()} "${dialog.message()}" -> ${action}`)
  if (action === "accept") await dialog.accept(promptText).catch(() => undefined)
  else await dialog.dismiss().catch(() => undefined)
}

export function watchPage(page: Page): void {
  page.on("console", (m) => {
    const type = m.type()
    if (type === "debug" || type === "trace") return
    push("console", `${type}: ${m.text()}`)
  })
  page.on("pageerror", (e) => push("error", e.message))
  page.on("requestfailed", (r) =>
    push("request", `FAILED ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ""}`),
  )
  page.on("response", (r) => {
    if (r.status() >= 400) push("request", `${r.status()} ${r.request().method()} ${r.url()}`)
  })
  page.on("dialog", (d) => void answer(d))
}

export function readLog(opts: { kinds?: LogKind[] | undefined; limit?: number; clear?: boolean }) {
  const list = opts.kinds?.length ? entries.filter((e) => opts.kinds!.includes(e.kind)) : entries
  const out = list.slice(-(opts.limit ?? 50))
  if (opts.clear) entries.length = 0
  return out
}

export function setDialogPolicy(action: "accept" | "dismiss", promptText?: string): void {
  dialogPolicy = { action, promptText }
}

export function getDialogPolicy() {
  return dialogPolicy
}
