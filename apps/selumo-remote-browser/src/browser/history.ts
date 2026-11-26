import { copyFile, mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { profileDir } from "./manager.js"

/**
 * Chromium browsing history of a profile, read from a copy of its History database (the live
 * file is locked while the browser runs). Recent visits may lag a few seconds behind.
 */
export type HistoryEntry = { url: string; title: string; visits: number; last_visit: string }

const WINDOWS_EPOCH_OFFSET = 11_644_473_600

export async function readHistory(
  profileId: string,
  opts: { query?: string | undefined; limit?: number },
): Promise<HistoryEntry[]> {
  const dir = profileDir(profileId, "chromium")
  const file = path.join(dir, "Default", "History")
  if (!(await stat(file).catch(() => null))) return []
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rb-history-"))
  try {
    const copy = path.join(tmp, "History")
    await copyFile(file, copy)
    await copyFile(`${file}-wal`, `${copy}-wal`).catch(() => undefined)
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      const like = `%${opts.query ?? ""}%`
      const rows = db
        .prepare(
          `SELECT url, title, visit_count AS visits,
                  CAST(last_visit_time / 1000000 - ${WINDOWS_EPOCH_OFFSET} AS INTEGER) AS ts
           FROM urls WHERE url LIKE ? OR title LIKE ?
           ORDER BY last_visit_time DESC LIMIT ?`,
        )
        .all(like, like, Math.min(opts.limit ?? 50, 500)) as {
        url: string
        title: string
        visits: number
        ts: number
      }[]
      return rows.map((r) => ({
        url: r.url,
        title: r.title,
        visits: r.visits,
        last_visit: new Date(r.ts * 1000).toISOString(),
      }))
    } finally {
      db.close()
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
