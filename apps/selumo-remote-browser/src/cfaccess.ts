import { createPublicKey, verify, type JsonWebKey } from "node:crypto"
import { allowedEmails, env } from "./env.js"

/**
 * Cloudflare Access in front of /mcp-oauth (claude.ai connectors sign in through Access's managed
 * OAuth). Access forwards each request with a signed JWT in Cf-Access-Jwt-Assertion; it is
 * verified against the team's public keys, so a forged email header is useless.
 */
type Jwk = JsonWebKey & { kid?: string }

let keys: { at: number; byKid: Map<string, Jwk> } | null = null

async function publicKeys(): Promise<Map<string, Jwk>> {
  if (keys && Date.now() - keys.at < 3600_000) return keys.byKid
  const res = await fetch(`https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`)
  const body = (await res.json()) as { keys: Jwk[] }
  keys = { at: Date.now(), byKid: new Map(body.keys.map((k) => [k.kid ?? "", k])) }
  return keys.byKid
}

const b64url = (s: string) => Buffer.from(s, "base64url")

export function accessConfigured(): boolean {
  return Boolean(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD)
}

/** The signed-in person's email, or null when the JWT is missing, invalid or not allowed. */
export async function accessIdentity(headers: {
  get(name: string): string | null | undefined
}): Promise<string | null> {
  if (!accessConfigured()) return null
  const jwt = headers.get("cf-access-jwt-assertion") ?? ""
  const [h, p, s] = jwt.split(".")
  if (!h || !p || !s) return null
  try {
    const header = JSON.parse(b64url(h).toString()) as { alg?: string; kid?: string }
    if (header.alg !== "RS256") return null
    let jwk = (await publicKeys()).get(header.kid ?? "")
    if (!jwk) {
      keys = null // keys rotated
      jwk = (await publicKeys()).get(header.kid ?? "")
    }
    if (!jwk) return null
    const ok = verify(
      "RSA-SHA256",
      Buffer.from(`${h}.${p}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      b64url(s),
    )
    if (!ok) return null
    const claims = JSON.parse(b64url(p).toString()) as {
      aud?: string | string[]
      iss?: string
      exp?: number
      nbf?: number
      email?: string
    }
    const now = Date.now() / 1000
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.includes(env.CF_ACCESS_AUD)) return null
    if (claims.iss !== `https://${env.CF_ACCESS_TEAM_DOMAIN}`) return null
    if (!claims.exp || claims.exp < now - 30 || (claims.nbf && claims.nbf > now + 30)) return null
    const email = (claims.email ?? "").toLowerCase()
    if (!email) return null // service tokens have no email; this path is for people
    // Access policies decide who may sign in; ALLOWED_EMAILS, when set, narrows it further.
    if (allowedEmails.size && !allowedEmails.has(email)) return null
    return email
  } catch {
    return null
  }
}
