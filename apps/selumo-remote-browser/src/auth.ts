import { timingSafeEqual } from "node:crypto"
import type { Context, MiddlewareHandler } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import PocketBase from "pocketbase"
import { allowedEmails, env } from "./env.js"

export const SESSION_COOKIE = "rb_session"
const CACHE_MS = 60_000
const cache = new Map<string, { email: string; until: number }>()

export type AuthVars = { Variables: { user: string } }

/** Returns the user's email when the PocketBase user token is valid. */
export async function verifyToken(token: string): Promise<string | null> {
  const hit = cache.get(token)
  if (hit && hit.until > Date.now()) return hit.email
  const client = new PocketBase(env.PB_URL)
  client.authStore.save(token, null)
  try {
    const res = await client.collection("users").authRefresh()
    const email = String(res.record.email)
    cache.set(token, { email, until: Date.now() + CACHE_MS })
    return email
  } catch {
    cache.delete(token)
    return null
  }
}

export async function login(email: string, password: string): Promise<string> {
  const client = new PocketBase(env.PB_URL)
  const res = await client.collection("users").authWithPassword(email, password)
  return res.token
}

export function setSession(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE === "true",
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  })
}

export function clearSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" })
}

/** Dashboard pages: a valid PocketBase user session cookie is required. */
export const requireUser: MiddlewareHandler<AuthVars> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE)
  const email = token ? await verifyToken(token) : null
  if (!email) {
    if (c.req.header("hx-request")) {
      c.header("HX-Redirect", "/login")
      return c.body(null, 401)
    }
    return c.redirect("/login")
  }
  c.set("user", email)
  await next()
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * MCP endpoint: either the static bearer token, or an identity that Cloudflare Access already
 * authenticated (the origin is only reachable through the tunnel, so the header is trusted).
 */
export function mcpIdentity(headers: {
  get(name: string): string | null | undefined
}): string | null {
  const auth = headers.get("authorization") ?? ""
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : ""
  if (env.MCP_TOKEN && bearer && safeEqual(bearer, env.MCP_TOKEN)) return "token"
  const email = (headers.get("cf-access-authenticated-user-email") ?? "").toLowerCase()
  if (email && allowedEmails.has(email)) return email
  return null
}

/** Parses the session cookie out of a raw Cookie header (used for the VNC WebSocket upgrade). */
export function sessionFromCookieHeader(header: string | undefined): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=")
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="))
  }
  return null
}
