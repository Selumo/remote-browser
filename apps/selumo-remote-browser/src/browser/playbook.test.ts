import { describe, expect, it, vi } from "vitest"

vi.mock("../pb.js", () => ({ ensureSuperuser: vi.fn(), pb: {} }))

const { hostCandidates, playbookTitle } = await import("./playbook.js")

describe("playbook hosts", () => {
  it("tries the most specific host first, without www", () => {
    expect(hostCandidates("www.instagram.com")).toEqual(["instagram.com"])
    expect(hostCandidates("m.blog.naver.com")).toEqual([
      "m.blog.naver.com",
      "blog.naver.com",
      "naver.com",
    ])
  })
  it("titles playbooks by host", () => {
    expect(playbookTitle("instagram.com")).toBe("플레이북: instagram.com")
  })
})
