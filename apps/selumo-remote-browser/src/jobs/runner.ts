import { EventEmitter } from "node:events"
import type { Page } from "playwright"
import { checkChallenge, waitForHuman } from "../browser/challenge.js"
import { openProfile, requireActive } from "../browser/manager.js"
import { env } from "../env.js"
import { captureImage } from "../images.js"
import {
  ensureSuperuser,
  pb,
  type Job,
  type JobLog,
  type JobRun,
  type Profile,
  type RunTrigger,
} from "../pb.js"
import { extractRows, saveRows } from "./crawl.js"
import { describeStep, parseSteps, type Step } from "./steps.js"

export type RunEvent =
  | { type: "log"; id: string; level: JobLog["level"]; message: string; created: string }
  | { type: "end"; status: JobRun["status"] }

/** Live log fan-out for SSE. Event name is the run id. */
export const runEvents = new EventEmitter()
runEvents.setMaxListeners(100)

let runningRun: string | null = null

export function runningRunId(): string | null {
  return runningRun
}

export async function startRun(jobId: string, trigger: RunTrigger): Promise<JobRun> {
  if (runningRun) throw new Error(`Another job run (${runningRun}) is still running`)
  await ensureSuperuser()
  const job = await pb.collection("jobs").getOne<Job>(jobId)
  const steps = parseSteps(job.steps)
  const profile = await pb.collection("profiles").getOne<Profile>(job.profile)
  runningRun = "starting"
  try {
    const run = await pb.collection("job_runs").create<JobRun>({
      job: job.id,
      status: "running",
      trigger,
      items: 0,
      started: new Date().toISOString(),
    })
    runningRun = run.id
    void execute(job, run.id, profile, steps).finally(() => {
      runningRun = null
    })
    return run
  } catch (e) {
    runningRun = null
    throw e
  }
}

/** Keeps a visible record when a scheduled run could not start (busy browser, bad steps...). */
export async function recordSkipped(
  jobId: string,
  trigger: RunTrigger,
  reason: string,
): Promise<void> {
  await ensureSuperuser()
  const now = new Date().toISOString()
  await pb
    .collection("job_runs")
    .create({
      job: jobId,
      status: "failed",
      trigger,
      items: 0,
      started: now,
      finished: now,
      error: `skipped: ${reason}`.slice(0, 5000),
    })
    .catch((e: unknown) => console.error("[jobs] could not record skipped run", e))
}

async function log(runId: string, level: JobLog["level"], message: string): Promise<void> {
  const created = new Date().toISOString()
  const record = await pb
    .collection("job_logs")
    .create<JobLog>({ run: runId, level, message: message.slice(0, 10_000) })
    .catch((e: unknown) => {
      console.error("[jobs] log write failed", e)
      return null
    })
  runEvents.emit(runId, {
    type: "log",
    id: record?.id ?? `${runId}-${created}`,
    level,
    message,
    created: record?.created ?? created,
  } satisfies RunEvent)
}

type StepContext = { page: Page; job: Job; runId: string; index: number; items: number }

async function runStep(step: Step, ctx: StepContext): Promise<string | null> {
  const { page } = ctx
  switch (step.action) {
    case "goto":
      await page.goto(step.url)
      return `→ ${page.url()}`
    case "click":
      await page.locator(step.selector).first().click()
      return null
    case "fill":
      await page.locator(step.selector).first().fill(step.value)
      return null
    case "press":
      if (step.selector) await page.locator(step.selector).first().press(step.key)
      else await page.keyboard.press(step.key)
      return null
    case "wait":
      await page.waitForTimeout(step.ms)
      return null
    case "waitFor":
      await page
        .locator(step.selector)
        .first()
        .waitFor({ timeout: step.timeoutMs ?? 30_000 })
      return null
    case "text": {
      const text = await page.locator(step.selector).first().innerText()
      return text.trim()
    }
    case "screenshot": {
      const image = await captureImage(page, {
        title: `${ctx.job.name} #${ctx.index + 1}`,
        source: "job",
        job: ctx.job.id,
        run: ctx.runId,
      })
      return `saved image ${image.id}`
    }
    case "scroll":
      if (step.to === "bottom")
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      else await page.mouse.wheel(0, step.to)
      await page.waitForTimeout(300)
      return null
    case "extract": {
      const rows = await extractRows(page, step.selector, step.fields, step.limit ?? 500)
      const saved = await saveRows(ctx.job.id, ctx.runId, rows)
      ctx.items += saved
      const sample = rows[0] ? ` e.g. ${JSON.stringify(rows[0]).slice(0, 300)}` : ""
      return `extracted ${saved} row(s)${sample}`
    }
  }
}

async function execute(job: Job, runId: string, profile: Profile, steps: Step[]): Promise<void> {
  let status: JobRun["status"] = "success"
  const ctx: StepContext = { page: undefined as unknown as Page, job, runId, index: 0, items: 0 }
  try {
    const browser = await openProfile(profile)
    await log(runId, "info", `profile "${profile.name}" opened`)
    for (const [index, step] of steps.entries()) {
      ctx.page = browser.page
      ctx.index = index
      await log(runId, "info", `#${index + 1} ${describeStep(step)}`)
      const result = await runStep(step, ctx)
      if (result) await log(runId, "info", result)
      // A bot check pauses the run until a person clears it in the remote screen.
      if (["goto", "click", "press", "fill"].includes(step.action)) {
        const challenge = await checkChallenge(browser.page).catch(() => null)
        if (challenge) {
          const minutes = env.CHALLENGE_WAIT_MINUTES
          await log(
            runId,
            "error",
            `bot check: ${challenge.kind}. 대시보드 원격 화면에서 직접 해결해 주세요 (최대 ${minutes}분 대기)`,
          )
          const cleared = await waitForHuman(() => requireActive().page, minutes * 60_000)
          if (!cleared)
            throw new Error(`bot check not cleared within ${minutes} min: ${challenge.kind}`)
          await log(runId, "info", "bot check cleared, continuing")
        }
      }
    }
    await log(runId, "info", `done, ${ctx.items} item(s) collected`)
    await pb
      .collection("job_runs")
      .update(runId, { status, items: ctx.items, finished: new Date().toISOString() })
  } catch (e) {
    status = "failed"
    const message = e instanceof Error ? e.message : String(e)
    await log(runId, "error", message)
    await pb
      .collection("job_runs")
      .update(runId, {
        status,
        items: ctx.items,
        finished: new Date().toISOString(),
        error: message.slice(0, 5000),
      })
      .catch(() => undefined)
  } finally {
    runEvents.emit(runId, { type: "end", status } satisfies RunEvent)
  }
}
