import PocketBase from "pocketbase"
import { env } from "./env.js"

export type Profile = {
  id: string
  name: string
  start_url: string
  notes: string
  created: string
  updated: string
}

export type Job = {
  id: string
  name: string
  profile: string
  steps: unknown
  schedule: string
  enabled: boolean
  created: string
  updated: string
}

export type RunTrigger = "manual" | "schedule" | "mcp"

export type JobRun = {
  id: string
  job: string
  status: "running" | "success" | "failed"
  trigger: RunTrigger | ""
  items: number
  started: string
  finished: string
  error: string
  created: string
}

export type CrawlItem = {
  id: string
  job: string
  run: string
  data: Record<string, unknown>
  created: string
}

export type JobLog = {
  id: string
  run: string
  level: "info" | "error"
  message: string
  created: string
}

/** Server-side client, authenticated as a PocketBase superuser. Never handed to a browser. */
export const pb = new PocketBase(env.PB_URL)
pb.autoCancellation(false)

export async function ensureSuperuser(): Promise<void> {
  if (pb.authStore.isValid) return
  await pb
    .collection("_superusers")
    .authWithPassword(env.PB_SUPERUSER_EMAIL, env.PB_SUPERUSER_PASSWORD, {
      autoRefreshThreshold: 30 * 60,
    })
}

/** Waits for PocketBase to come up after the container starts. */
export async function waitForPocketBase(attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await ensureSuperuser()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw new Error(`PocketBase is not reachable at ${env.PB_URL}`)
}

/** Creates the first dashboard user from ADMIN_EMAIL / ADMIN_PASSWORD when it does not exist. */
export async function ensureAdminUser(): Promise<void> {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) return
  await ensureSuperuser()
  const existing = await pb
    .collection("users")
    .getFirstListItem(pb.filter("email = {:email}", { email: env.ADMIN_EMAIL }))
    .catch(() => null)
  if (existing) return
  await pb.collection("users").create({
    email: env.ADMIN_EMAIL,
    password: env.ADMIN_PASSWORD,
    passwordConfirm: env.ADMIN_PASSWORD,
    verified: true,
  })
  console.log(`[pb] created dashboard user ${env.ADMIN_EMAIL}`)
}
