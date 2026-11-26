import { describe, expect, it } from "vitest"
import type { CrawlItem } from "../pb.js"
import { columnsOf, toCsv } from "./csv.js"

const item = (data: Record<string, unknown>, created = "2026-11-26 12:00:00.000Z"): CrawlItem => ({
  id: "x",
  job: "j",
  run: "r",
  data,
  created,
})

describe("toCsv", () => {
  it("unions columns, quotes special characters and starts with a BOM", () => {
    const csv = toCsv([
      item({ title: 'a "b", c', url: "https://x" }),
      item({ title: "줄\n바꿈", price: 3 }),
    ])
    expect(csv.startsWith("﻿")).toBe(true)
    const lines = csv.slice(1).split("\r\n")
    expect(lines[0]).toBe("collected_at,title,url,price")
    expect(lines[1]).toBe('2026-11-26 12:00:00.000Z,"a ""b"", c",https://x,')
    expect(csv).toContain('"줄\n바꿈"')
  })

  it("neutralises spreadsheet formulas", () => {
    const csv = toCsv([item({ v: "=HYPERLINK(1)" }), item({ v: "-5" })])
    expect(csv).toContain("'=HYPERLINK(1)")
    expect(csv).toContain("'-5")
  })

  it("handles no rows", () => {
    expect(toCsv([])).toBe("﻿collected_at\r\n")
  })
})

describe("columnsOf", () => {
  it("keeps first-seen order", () => {
    expect(
      columnsOf([
        { b: 1, a: 2 },
        { c: 3, a: 1 },
      ]),
    ).toEqual(["b", "a", "c"])
  })
})
