import { Marked, type Tokens } from "marked"
import { ensureSuperuser, pb } from "./pb.js"

/**
 * Markdown notes in the spirit of Obsidian: [[Title]] links between notes (missing targets are
 * created on first open), ![[image title]] embeds a stored image, #tags, and backlinks.
 */
export type Doc = {
  id: string
  title: string
  body: string
  tags: string[] | null
  created: string
  updated: string
}

const WIKI = /(!?)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g

export function wikiTargets(body: string): string[] {
  const out = new Set<string>()
  for (const m of body.matchAll(WIKI)) if (!m[1]) out.add(m[2]!.trim())
  return [...out]
}

export function hashTags(body: string): string[] {
  const out = new Set<string>()
  for (const m of body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]{1,40})/gu)) out.add(m[1]!)
  return [...out]
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  )

const SAFE_URL = /^(https?:|mailto:|\/|#)/i

const marked = new Marked({
  gfm: true,
  breaks: true,
  // Raw HTML in a note is shown as text, and only safe link targets survive.
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text)
    },
  },
  walkTokens(token) {
    if ((token.type === "link" || token.type === "image") && !SAFE_URL.test(token.href)) {
      token.href = "#"
    }
  },
})

export const docHref = (title: string) => `/docs/t/${encodeURIComponent(title)}`
export const imageHref = (ref: string) => `/images/t/${encodeURIComponent(ref)}`

/** Markdown to HTML with wiki links, image embeds and #tags turned into links. */
export function renderMarkdown(body: string): string {
  const linked = body
    .replace(WIKI, (_m, bang: string, target: string, label?: string) => {
      const t = target.trim()
      return bang
        ? `![${label ?? t}](${imageHref(t)})`
        : `[${(label ?? t).replace(/[[\]]/g, "")}](${docHref(t)})`
    })
    .replace(
      /(^|\s)#([\p{L}\p{N}_/-]{1,40})/gu,
      (_m, pre: string, tag: string) => `${pre}[#${tag}](/docs?tag=${encodeURIComponent(tag)})`,
    )
  return marked.parse(linked, { async: false })
}

export async function listDocs(
  opts: { q?: string | undefined; tag?: string | undefined } = {},
): Promise<Doc[]> {
  await ensureSuperuser()
  const parts: string[] = []
  const params: Record<string, string> = {}
  if (opts.q) {
    parts.push("(title ~ {:q} || body ~ {:q})")
    params.q = opts.q
  }
  if (opts.tag) {
    parts.push("tags ~ {:tag}")
    params.tag = `"${opts.tag}"`
  }
  return pb.collection("docs").getFullList<Doc>({
    sort: "title",
    fields: "id,title,tags,updated,created",
    ...(parts.length ? { filter: pb.filter(parts.join(" && "), params) } : {}),
  })
}

export async function findDoc(ref: string): Promise<Doc | null> {
  await ensureSuperuser()
  return pb
    .collection("docs")
    .getFirstListItem<Doc>(pb.filter("id = {:v} || title = {:v}", { v: ref.trim() }))
    .catch(() => null)
}

export async function getDoc(ref: string): Promise<Doc> {
  const doc = await findDoc(ref)
  if (!doc) throw new Error(`Document not found: ${ref}`)
  return doc
}

export async function saveDoc(input: {
  ref?: string | undefined
  title: string
  body: string
}): Promise<Doc> {
  await ensureSuperuser()
  const title = input.title.trim()
  if (!title) throw new Error("title is required")
  const data = { title, body: input.body, tags: hashTags(input.body) }
  const existing = input.ref ? await findDoc(input.ref) : await findDoc(title)
  if (existing) return pb.collection("docs").update<Doc>(existing.id, data)
  return pb.collection("docs").create<Doc>(data)
}

export async function appendDoc(ref: string, text: string): Promise<Doc> {
  const doc = await findDoc(ref)
  const body = doc ? `${doc.body.replace(/\s*$/, "")}\n\n${text}` : text
  return saveDoc({ ref: doc?.id, title: doc?.title ?? ref, body })
}

export async function deleteDoc(ref: string): Promise<void> {
  const doc = await getDoc(ref)
  await pb.collection("docs").delete(doc.id)
}

/** Notes that link to this title with [[title]]. */
export async function backlinks(title: string): Promise<Doc[]> {
  await ensureSuperuser()
  const candidates = await pb.collection("docs").getFullList<Doc>({
    filter: pb.filter("body ~ {:needle}", { needle: `[[${title}` }),
    fields: "id,title,body,updated",
  })
  return candidates.filter((d) => wikiTargets(d.body).includes(title))
}

export async function allTags(): Promise<{ tag: string; count: number }[]> {
  await ensureSuperuser()
  const docs = await pb.collection("docs").getFullList<Doc>({ fields: "tags" })
  const counts = new Map<string, number>()
  for (const d of docs) for (const t of d.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
}
