import { z } from "zod"

/**
 * A field of an `extract` step. A string is a CSS selector inside the row whose text is taken.
 * An object can name an attribute instead (href and src come back as absolute URLs).
 * An empty selector means the row element itself.
 */
export const ExtractField = z.union([
  z.string(),
  z.object({ selector: z.string().optional(), attr: z.string().min(1).optional() }),
])

export type ExtractField = z.infer<typeof ExtractField>

/** A job is a list of steps run in order against one profile. */
export const Step = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), url: z.string().url() }),
  z.object({ action: z.literal("click"), selector: z.string().min(1) }),
  z.object({ action: z.literal("fill"), selector: z.string().min(1), value: z.string() }),
  z.object({ action: z.literal("press"), key: z.string().min(1), selector: z.string().optional() }),
  z.object({ action: z.literal("wait"), ms: z.number().int().min(0).max(120_000) }),
  z.object({
    action: z.literal("waitFor"),
    selector: z.string().min(1),
    timeoutMs: z.number().int().min(0).max(120_000).optional(),
  }),
  z.object({ action: z.literal("text"), selector: z.string().min(1) }),
  z.object({ action: z.literal("screenshot") }),
  z.object({
    action: z.literal("extract"),
    /** CSS selector matching one element per row. */
    selector: z.string().min(1),
    fields: z
      .record(z.string().min(1).max(64), ExtractField)
      .refine((f) => Object.keys(f).length > 0, {
        message: "fields must name at least one column",
      }),
    limit: z.number().int().min(1).max(5000).optional(),
  }),
  z.object({
    action: z.literal("scroll"),
    /** Pixels to scroll down, or "bottom". */
    to: z.union([z.number().int(), z.literal("bottom")]),
  }),
])

export type Step = z.infer<typeof Step>

export const Steps = z.array(Step).min(1).max(200)

export function parseSteps(raw: unknown): Step[] {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw
  return Steps.parse(value)
}

export function describeStep(step: Step): string {
  switch (step.action) {
    case "goto":
      return `goto ${step.url}`
    case "click":
      return `click ${step.selector}`
    case "fill":
      return `fill ${step.selector}`
    case "press":
      return `press ${step.key}${step.selector ? ` on ${step.selector}` : ""}`
    case "wait":
      return `wait ${step.ms}ms`
    case "waitFor":
      return `waitFor ${step.selector}`
    case "text":
      return `text ${step.selector}`
    case "screenshot":
      return "screenshot"
    case "extract":
      return `extract ${step.selector} → ${Object.keys(step.fields).join(", ")}`
    case "scroll":
      return `scroll ${step.to}`
  }
}

export const STEP_HELP = `[
  {"action": "goto", "url": "https://news.ycombinator.com"},
  {"action": "extract", "selector": "tr.athing", "limit": 30,
   "fields": {"title": ".titleline > a", "url": {"selector": ".titleline > a", "attr": "href"}}}
]`
