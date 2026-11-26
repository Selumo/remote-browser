import { Cron } from "croner"
import { z } from "zod"
import { closeActive, current, openProfile } from "./browser/manager.js"
import { parseSteps, type Step } from "./jobs/steps.js"
import { ensureSuperuser, pb, type Job, type JobRun, type Profile } from "./pb.js"

/** Shared by the dashboard routes and the MCP tools so both behave the same. */

export async function listProfiles(): Promise<Profile[]> {
  await ensureSuperuser()
  return pb.collection("profiles").getFullList<Profile>({ sort: "name" })
}

/** Finds a profile by id or exact name. */
export async function findProfile(ref: string): Promise<Profile> {
  await ensureSuperuser()
  return pb
    .collection("profiles")
    .getFirstListItem<Profile>(pb.filter("id = {:v} || name = {:v}", { v: ref.trim() }))
    .catch(() => {
      throw new Error(`Profile not found: ${ref}`)
    })
}

/** Profile fields a person or the AI can set. Empty strings mean the app default. */
export const ProfileInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  notes: z.string().max(2000).optional(),
  engine: z.enum(["chromium", "firefox", "webkit"]).optional(),
  device: z.enum(["desktop", "mobile"]).optional(),
  locale: z
    .string()
    .trim()
    .regex(/^$|^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "locale like ko-KR")
    .optional(),
  timezone: z
    .string()
    .trim()
    .refine((tz) => !tz || isTimeZone(tz), "unknown time zone, e.g. Asia/Seoul")
    .optional(),
  color_scheme: z.enum(["light", "dark", ""]).optional(),
  stealth: z.boolean().optional(),
  proxy: z
    .string()
    .trim()
    .regex(/^$|^(https?|socks5?):\/\/[^\s]+$/, "proxy like http://host:port or socks5://host:port")
    .optional(),
})
export type ProfileInput = z.infer<typeof ProfileInput>

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const SETTING_KEYS = [
  "engine",
  "device",
  "locale",
  "timezone",
  "color_scheme",
  "stealth",
  "proxy",
] as const

export async function createProfile(input: ProfileInput & { name: string }): Promise<Profile> {
  const data = ProfileInput.parse(input)
  await ensureSuperuser()
  return pb.collection("profiles").create<Profile>({
    engine: "chromium",
    device: "desktop",
    stealth: true,
    ...data,
  })
}

/** Updates a profile; an open browser is reopened when a browser setting changed. */
export async function updateProfile(ref: string, input: ProfileInput): Promise<Profile> {
  const before = await findProfile(ref)
  const data = ProfileInput.parse(input)
  const updated = await pb.collection("profiles").update<Profile>(before.id, data)
  const changed = SETTING_KEYS.some((k) => before[k] !== updated[k])
  if (changed && current()?.profileId === updated.id) await openProfile(updated, { reopen: true })
  return updated
}

export async function deleteProfile(id: string): Promise<void> {
  if (current()?.profileId === id) await closeActive()
  await ensureSuperuser()
  // The user data directory stays on disk; remove DATA_DIR/profiles/<id> by hand if needed.
  await pb.collection("profiles").delete(id)
}

export type JobWithProfile = Job & { profileName: string }

export async function listJobs(): Promise<JobWithProfile[]> {
  await ensureSuperuser()
  const jobs = await pb
    .collection("jobs")
    .getFullList<Job & { expand?: { profile?: Profile } }>({ sort: "name", expand: "profile" })
  return jobs.map(({ expand, ...j }) => ({ ...j, profileName: expand?.profile?.name ?? "" }))
}

export async function findJob(ref: string): Promise<Job> {
  await ensureSuperuser()
  return pb
    .collection("jobs")
    .getFirstListItem<Job>(pb.filter("id = {:v} || name = {:v}", { v: ref.trim() }))
    .catch(() => {
      throw new Error(`Job not found: ${ref}`)
    })
}

/** Returns an error message for an invalid cron expression, or null. Empty means no schedule. */
export function cronError(expr: string): string | null {
  if (!expr.trim()) return null
  try {
    new Cron(expr.trim(), { paused: true }).stop()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

export type JobInput = {
  name?: string | undefined
  profile?: string | undefined
  steps?: unknown
  schedule?: string | undefined
  enabled?: boolean | undefined
}

async function normalize(input: JobInput): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  if (input.name !== undefined) out.name = input.name.trim()
  if (input.profile !== undefined) out.profile = (await findProfile(input.profile)).id
  if (input.steps !== undefined) out.steps = parseSteps(input.steps) satisfies Step[]
  if (input.schedule !== undefined) {
    const err = cronError(input.schedule)
    if (err) throw new Error(`Invalid cron schedule: ${err}`)
    out.schedule = input.schedule.trim()
  }
  if (input.enabled !== undefined) out.enabled = input.enabled
  return out
}

export async function createJob(
  input: JobInput & { name: string; profile: string; steps: unknown },
): Promise<Job> {
  const data = await normalize(input)
  const job = await pb.collection("jobs").create<Job>({ enabled: false, schedule: "", ...data })
  await onJobsChanged()
  return job
}

export async function updateJob(ref: string, input: JobInput): Promise<Job> {
  const job = await findJob(ref)
  const data = await normalize(input)
  const updated = await pb.collection("jobs").update<Job>(job.id, data)
  await onJobsChanged()
  return updated
}

export async function deleteJob(ref: string): Promise<void> {
  const job = await findJob(ref)
  await pb.collection("jobs").delete(job.id)
  await onJobsChanged()
}

export async function listRuns(
  opts: { jobId?: string | undefined; limit?: number } = {},
): Promise<(JobRun & { jobName: string })[]> {
  await ensureSuperuser()
  const res = await pb
    .collection("job_runs")
    .getList<JobRun & { expand?: { job?: Job } }>(1, Math.min(Math.max(opts.limit ?? 20, 1), 200), {
      sort: "-created",
      expand: "job",
      ...(opts.jobId ? { filter: pb.filter("job = {:job}", { job: opts.jobId }) } : {}),
    })
  return res.items.map(({ expand, ...r }) => ({ ...r, jobName: expand?.job?.name ?? r.job }))
}

// The scheduler registers itself here to avoid an import cycle.
let jobsChangedHook: () => Promise<void> = async () => undefined
export function onJobsChangedHook(fn: () => Promise<void>): void {
  jobsChangedHook = fn
}
async function onJobsChanged(): Promise<void> {
  await jobsChangedHook().catch((e: unknown) => console.error("[cron] reload failed", e))
}
