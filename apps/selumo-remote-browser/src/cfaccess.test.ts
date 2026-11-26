import { generateKeyPairSync, sign } from "node:crypto"
import { beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("./env.js", () => ({
  env: { CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CF_ACCESS_AUD: "aud123" },
  allowedEmails: new Set(["me@example.com"]),
}))

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" }

function jwt(
  claims: Record<string, unknown>,
  opts: { kid?: string; key?: typeof privateKey } = {},
) {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const head = enc({ alg: "RS256", kid: opts.kid ?? "k1" })
  const body = enc(claims)
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), opts.key ?? privateKey).toString(
    "base64url",
  )
  return `${head}.${body}.${sig}`
}

const now = () => Math.floor(Date.now() / 1000)
const good = () => ({
  aud: ["aud123"],
  iss: "https://team.cloudflareaccess.com",
  exp: now() + 600,
  email: "Me@Example.com",
})
const headers = (token: string) => ({
  get: (n: string) => (n === "cf-access-jwt-assertion" ? token : null),
})

let accessIdentity: typeof import("./cfaccess.js").accessIdentity

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }))),
  )
  ;({ accessIdentity } = await import("./cfaccess.js"))
})

describe("Cloudflare Access JWT", () => {
  it("accepts a valid token for an allowed email", async () => {
    expect(await accessIdentity(headers(jwt(good())))).toBe("me@example.com")
  })
  it("rejects a token signed by another key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    expect(await accessIdentity(headers(jwt(good(), { key: other })))).toBeNull()
  })
  it("rejects wrong audience, issuer, expiry and emails", async () => {
    expect(await accessIdentity(headers(jwt({ ...good(), aud: ["other"] })))).toBeNull()
    expect(
      await accessIdentity(headers(jwt({ ...good(), iss: "https://evil.cloudflareaccess.com" }))),
    ).toBeNull()
    expect(await accessIdentity(headers(jwt({ ...good(), exp: now() - 120 })))).toBeNull()
    expect(await accessIdentity(headers(jwt({ ...good(), email: "x@example.com" })))).toBeNull()
    expect(await accessIdentity(headers(jwt({ ...good(), email: undefined })))).toBeNull()
  })
  it("rejects missing or garbage headers", async () => {
    expect(await accessIdentity(headers(""))).toBeNull()
    expect(await accessIdentity(headers("a.b.c"))).toBeNull()
  })
})
