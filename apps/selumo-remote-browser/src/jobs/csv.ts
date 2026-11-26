import type { CrawlItem } from "../pb.js"

export function columnsOf(rows: Record<string, unknown>[]): string[] {
  const cols = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) cols.add(k)
  return [...cols]
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  let s = typeof value === "object" ? JSON.stringify(value) : String(value)
  // Spreadsheet apps execute cells that start with these characters as formulas.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** CSV with a UTF-8 BOM so Excel opens Korean text correctly. */
export function toCsv(items: CrawlItem[]): string {
  const rows = items.map((i) => i.data ?? {})
  const cols = columnsOf(rows)
  const header = ["collected_at", ...cols]
  const lines = [header.map(csvCell).join(",")]
  for (const [i, item] of items.entries()) {
    const row = rows[i] ?? {}
    lines.push([item.created, ...cols.map((c) => row[c])].map(csvCell).join(","))
  }
  return `﻿${lines.join("\r\n")}\r\n`
}
