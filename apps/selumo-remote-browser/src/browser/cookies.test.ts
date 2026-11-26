import { describe, expect, it, vi } from "vitest"

vi.mock("../env.js", () => ({ env: { DATA_DIR: "/tmp" } }))
vi.mock("./manager.js", () => ({ current: () => null }))

const { cookieStatus, isLoginLike, summarize } = await import("./cookies.js")

const NOW = 1_800_000_000

describe("cookieStatus", () => {
  it("classifies by expiry", () => {
    expect(cookieStatus(null, NOW)).toBe("session")
    expect(cookieStatus(NOW - 1, NOW)).toBe("expired")
    expect(cookieStatus(NOW + 3600, NOW)).toBe("expiring")
    expect(cookieStatus(NOW + 30 * 86400, NOW)).toBe("valid")
  })
})

describe("isLoginLike", () => {
  it("spots session and auth cookies but not analytics", () => {
    expect(isLoginLike("NID_AUT")).toBe(true)
    expect(isLoginLike("sessionid")).toBe(true)
    expect(isLoginLike("__Secure-3PSID")).toBe(true)
    expect(isLoginLike("_ga")).toBe(false)
    expect(isLoginLike("theme")).toBe(false)
  })
})

describe("summarize", () => {
  it("groups by site, ranks login domains first and reports the best status", () => {
    const out = summarize(
      [
        {
          domain: "www.naver.com",
          name: "NID_AUT",
          expires: NOW + 40 * 86400,
          httpOnly: true,
          secure: true,
        },
        { domain: "naver.com", name: "NID_SES", expires: NOW - 10, httpOnly: true, secure: true },
        { domain: "example.com", name: "theme", expires: null, httpOnly: false, secure: false },
      ],
      NOW,
    )
    expect(out.map((g) => g.domain)).toEqual(["naver.com", "example.com"])
    expect(out[0]).toMatchObject({ total: 2, login: 2, expired: 1, status: "valid" })
    expect(out[0]!.latestExpiry).toBe(NOW + 40 * 86400)
    expect(out[1]).toMatchObject({ status: "session", latestExpiry: null })
  })
})
