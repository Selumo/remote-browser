import type { Page } from "playwright"
import { ensureSuperuser, pb, type CrawlItem } from "../pb.js"
import type { ExtractField } from "./steps.js"

type Row = Record<string, string | null>

/** Extracts one record per element matching `selector`, in a single round trip to the page. */
export async function extractRows(
  page: Page,
  selector: string,
  fields: Record<string, ExtractField>,
  limit: number,
): Promise<Row[]> {
  return page.locator(selector).evaluateAll(
    (rows, arg) =>
      rows.slice(0, arg.limit).map((row) => {
        const out: Record<string, string | null> = {}
        for (const [key, spec] of Object.entries(arg.fields)) {
          const s = typeof spec === "string" ? { selector: spec } : spec
          const el = s.selector ? row.querySelector(s.selector) : row
          if (!el) {
            out[key] = null
            continue
          }
          if (!s.attr) {
            out[key] = ((el as HTMLElement).innerText ?? el.textContent ?? "").trim()
          } else if (s.attr === "href" || s.attr === "src") {
            const prop = (el as unknown as Record<string, unknown>)[s.attr]
            out[key] = typeof prop === "string" ? prop : el.getAttribute(s.attr)
          } else {
            out[key] = el.getAttribute(s.attr)
          }
        }
        return out
      }),
    { fields, limit },
  )
}

export async function saveRows(jobId: string, runId: string, rows: Row[]): Promise<number> {
  await ensureSuperuser()
  // Sequential on purpose: readers sort by insertion order (@rowid), so rows keep page order.
  let saved = 0
  for (const data of rows) {
    await pb.collection("crawl_items").create({ job: jobId, run: runId, data })
    saved++
  }
  return saved
}

export async function listItems(
  jobId: string,
  opts: { runId?: string | undefined; limit?: number; offset?: number } = {},
): Promise<{ items: CrawlItem[]; total: number }> {
  await ensureSuperuser()
  const filter = opts.runId
    ? pb.filter("job = {:job} && run = {:run}", { job: jobId, run: opts.runId })
    : pb.filter("job = {:job}", { job: jobId })
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const page = Math.floor((opts.offset ?? 0) / limit) + 1
  const res = await pb
    .collection("crawl_items")
    .getList<CrawlItem>(page, limit, { filter, sort: "-@rowid" })
  return { items: res.items, total: res.totalItems }
}

export async function allItems(jobId: string, runId?: string): Promise<CrawlItem[]> {
  await ensureSuperuser()
  const filter = runId
    ? pb.filter("job = {:job} && run = {:run}", { job: jobId, run: runId })
    : pb.filter("job = {:job}", { job: jobId })
  return pb.collection("crawl_items").getFullList<CrawlItem>({ filter, sort: "@rowid", batch: 500 })
}

export { columnsOf, toCsv } from "./csv.js"
