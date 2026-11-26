import { copyFile, mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { current, profileDir, type Engine } from "./manager.js"

/**
 * What a profile has saved: cookie metadata only. Values are never read or returned, so this
 * view cannot leak a session token. A profile that is open is read live from the browser; a
 * closed one from a copy of Chromium's cookie database (the original stays untouched).
 */
export type CookieInfo = {
  domain: string
  name: string
  /** Unix seconds, or null for a session cookie (gone when the browser closes). */
  expires: number | null
  httpOnly: boolean
  secure: boolean
}

export type CookieStatus = "valid" | "expiring" | "expired" | "session"

export type DomainSummary = {
  domain: string
  total: number
  /** Cookies whose names look like login or session tokens. */
  login: number
  expired: number
  /** Latest expiry among login-like cookies, else among all, in unix seconds. */
  latestExpiry: number | null
  status: CookieStatus
  cookies: (CookieInfo & { status: CookieStatus; loginLike: boolean })[]
}

const LOGIN_NAME =
  /sess|sid\b|^sid|auth|token|login|jwt|remember|user|account|NID_AUT|NID_SES|SAPISID|SSID|HSID|__Secure-|__Host-|_ga_/i
const EXPIRING_SECONDS = 3 * 24 * 3600
/** Chromium stores times as microseconds since 1601-01-01 (too large for a JS number, so the
 * query divides to seconds first). */
const WINDOWS_EPOCH_OFFSET = 11_644_473_600

export function cookieStatus(expires: number | null, now = Date.now() / 1000): CookieStatus {
  if (expires === null) return "session"
  if (expires <= now) return "expired"
  if (expires - now < EXPIRING_SECONDS) return "expiring"
  return "valid"
}

export function isLoginLike(name: string): boolean {
  return LOGIN_NAME.test(name) && !/^_ga|^_gid|^_fbp|^_gcl/i.test(name)
}

async function readDisk(profileId: string): Promise<CookieInfo[]> {
  const file = path.join(profileDir(profileId, "chromium"), "Default", "Cookies")
  if (!(await stat(file).catch(() => null))) return []
  const dir = await mkdtemp(path.join(os.tmpdir(), "rb-cookies-"))
  try {
    const copy = path.join(dir, "Cookies")
    await copyFile(file, copy)
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      const rows = db
        .prepare(
          "SELECT host_key, name, expires_utc / 1000000 AS expires_s, has_expires, is_httponly, is_secure FROM cookies",
        )
        .all() as {
        host_key: string
        name: string
        expires_s: number
        has_expires: number
        is_httponly: number
        is_secure: number
      }[]
      return rows.map((r) => ({
        domain: r.host_key.replace(/^\./, ""),
        name: r.name,
        expires: r.has_expires ? r.expires_s - WINDOWS_EPOCH_OFFSET : null,
        httpOnly: Boolean(r.is_httponly),
        secure: Boolean(r.is_secure),
      }))
    } finally {
      db.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export type CookieSource = "live" | "disk" | "closed"

/** Live from an open browser (any engine); from disk only for Chromium, else "closed". */
export async function profileCookies(profile: {
  id: string
  engine?: Engine | ""
}): Promise<{ source: CookieSource; cookies: CookieInfo[] }> {
  const profileId = profile.id
  const open = current()
  if (open?.profileId === profileId) {
    const cookies = await open.context.cookies()
    return {
      source: "live",
      cookies: cookies.map((c) => ({
        domain: c.domain.replace(/^\./, ""),
        name: c.name,
        expires: c.expires > 0 ? c.expires : null,
        httpOnly: c.httpOnly,
        secure: c.secure,
      })),
    }
  }
  if ((profile.engine || "chromium") !== "chromium") return { source: "closed", cookies: [] }
  return { source: "disk", cookies: await readDisk(profileId) }
}

const RANK: Record<CookieStatus, number> = { valid: 3, expiring: 2, session: 1, expired: 0 }

/** Groups cookies by site, login-like domains first. */
export function summarize(cookies: CookieInfo[], now = Date.now() / 1000): DomainSummary[] {
  const groups = new Map<string, DomainSummary>()
  for (const c of cookies) {
    const key = c.domain.replace(/^www\./, "")
    let g = groups.get(key)
    if (!g) {
      g = {
        domain: key,
        total: 0,
        login: 0,
        expired: 0,
        latestExpiry: null,
        status: "expired",
        cookies: [],
      }
      groups.set(key, g)
    }
    const status = cookieStatus(c.expires, now)
    const loginLike = isLoginLike(c.name)
    g.cookies.push({ ...c, status, loginLike })
    g.total++
    if (loginLike) g.login++
    if (status === "expired") g.expired++
  }
  for (const g of groups.values()) {
    const pool = g.cookies.some((c) => c.loginLike)
      ? g.cookies.filter((c) => c.loginLike)
      : g.cookies
    const live = pool.filter((c) => c.status !== "expired")
    const expiries = live.map((c) => c.expires).filter((e): e is number => e !== null)
    g.latestExpiry = expiries.length ? Math.max(...expiries) : null
    g.status = live.reduce<CookieStatus>(
      (best, c) => (RANK[c.status] > RANK[best] ? c.status : best),
      "expired",
    )
    g.cookies.sort(
      (a, b) => Number(b.loginLike) - Number(a.loginLike) || a.name.localeCompare(b.name),
    )
  }
  return [...groups.values()].sort(
    (a, b) => b.login - a.login || b.total - a.total || a.domain.localeCompare(b.domain),
  )
}
