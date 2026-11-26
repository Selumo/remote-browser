import { describe, expect, it } from "vitest"
import { describeStep, parseSteps } from "./steps.js"

describe("parseSteps", () => {
  it("accepts a JSON string of valid steps", () => {
    const steps = parseSteps(
      '[{"action":"goto","url":"https://example.com"},{"action":"wait","ms":500}]',
    )
    expect(steps).toHaveLength(2)
    expect(describeStep(steps[0]!)).toBe("goto https://example.com")
  })

  it("rejects unknown actions and empty lists", () => {
    expect(() => parseSteps([{ action: "eval", code: "1" }])).toThrow()
    expect(() => parseSteps([])).toThrow()
  })

  it("rejects waits over two minutes", () => {
    expect(() => parseSteps([{ action: "wait", ms: 200_000 }])).toThrow()
  })
})
