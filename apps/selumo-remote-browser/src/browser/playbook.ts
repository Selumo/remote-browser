import { ensureSuperuser, pb } from "../pb.js"

/**
 * Site playbooks: notes titled "플레이북: <host>" that tell the AI how a site works (where the
 * buttons are, what fails, what to watch for). Page summaries point at the playbook the first time
 * the AI arrives on a host, and suggest writing one when there is none, so knowledge from one
 * session is not lost in the next.
 */
export const PLAYBOOK_PREFIX = "플레이북: "
export const playbookTitle = (host: string) => `${PLAYBOOK_PREFIX}${host}`

/** "m.blog.naver.com" -> blog.naver.com, naver.com (the most specific playbook wins). */
export function hostCandidates(host: string): string[] {
  const parts = host.replace(/^www\./, "").split(".")
  const out: string[] = []
  for (let i = 0; i <= parts.length - 2; i++) out.push(parts.slice(i).join("."))
  return out
}

let cache: { at: number; titles: Set<string> } | null = null

async function playbookTitles(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < 15_000) return cache.titles
  await ensureSuperuser()
  const docs = await pb.collection("docs").getFullList<{ title: string }>({
    fields: "title",
    filter: pb.filter("title ~ {:p}", { p: PLAYBOOK_PREFIX }),
  })
  cache = { at: Date.now(), titles: new Set(docs.map((d) => d.title)) }
  return cache.titles
}

export async function findPlaybook(
  url: string,
): Promise<{ host: string; title: string | null } | null> {
  let host: string
  try {
    const u = new URL(url)
    if (!/^https?:$/.test(u.protocol)) return null
    host = u.hostname.replace(/^www\./, "")
  } catch {
    return null
  }
  const titles = await playbookTitles().catch(() => new Set<string>())
  const hit =
    hostCandidates(host)
      .map(playbookTitle)
      .find((t) => titles.has(t)) ?? null
  return { host, title: hit }
}

let lastHost = ""

/** A note for the page summary, only when the AI arrives on a new host (keeps tokens down). */
export async function playbookNote(url: string): Promise<string> {
  const found = await findPlaybook(url)
  if (!found || found.host === lastHost) return ""
  lastHost = found.host
  return found.title
    ? `\n\n📘 PLAYBOOK: docs read "${found.title}" before working here; append what you learn.`
    : `\n\n📘 No playbook for ${found.host} yet. When you finish, docs write title "${playbookTitle(found.host)}" with the steps that worked and pitfalls.`
}

/** Starting text for a new playbook made from the dashboard. */
export function playbookTemplate(host: string): string {
  return `# ${host} 플레이북 #playbook

## 자주 하는 일
1. (예: 게시물 올리기) 어디를 누르고, 무엇을 입력하고, 무엇이 보이면 성공인지

## 주의할 점
- 팝업, 느린 로딩, 로그인 만료되면 어디로 튕기는지, 제한

## 선택자 메모
- 이름: 선택자
`
}
