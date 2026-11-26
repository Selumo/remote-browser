import { Cron } from "croner"
import { env } from "../env.js"
import { ensureSuperuser, pb, type Job } from "../pb.js"
import { onJobsChangedHook } from "../services.js"
import { recordSkipped, startRun } from "./runner.js"

/** One croner instance per enabled job with a schedule, rebuilt whenever jobs change. */
const crons = new Map<string, Cron>()

export async function reloadSchedules(): Promise<void> {
  await ensureSuperuser()
  const jobs = await pb
    .collection("jobs")
    .getFullList<Job>({ filter: 'enabled = true && schedule != ""' })
  for (const cron of crons.values()) cron.stop()
  crons.clear()
  for (const job of jobs) {
    try {
      const cron = new Cron(
        job.schedule,
        { timezone: env.SCHEDULE_TZ, protect: true, name: job.id },
        () => {
          void trigger(job.id)
        },
      )
      crons.set(job.id, cron)
    } catch (e) {
      console.error(`[cron] invalid schedule "${job.schedule}" on job ${job.name}`, e)
    }
  }
  console.log(`[cron] ${crons.size} scheduled job(s)`)
}

async function trigger(jobId: string): Promise<void> {
  try {
    await startRun(jobId, "schedule")
  } catch (e) {
    await recordSkipped(jobId, "schedule", e instanceof Error ? e.message : String(e))
  }
}

export function nextRun(jobId: string): Date | null {
  return crons.get(jobId)?.nextRun() ?? null
}

export async function startScheduler(): Promise<void> {
  onJobsChangedHook(reloadSchedules)
  await reloadSchedules()
}
