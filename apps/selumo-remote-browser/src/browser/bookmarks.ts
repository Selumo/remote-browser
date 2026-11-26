import type { Page } from "playwright"
import { requireActive } from "./manager.js"

/**
 * Chromium bookmarks of the open profile, changed live through the chrome.bookmarks API that
 * Chromium exposes on its chrome://bookmarks page (opened in a short-lived background tab).
 * Firefox and WebKit profiles have no equivalent.
 */
export type Bookmark = { id: string; title: string; url?: string; folder: string }

type Node = { id: string; title: string; url?: string; children?: Node[] }

async function withBookmarks<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = requireActive()
  if (browser.engine !== "chromium") throw new Error("Bookmarks need a Chromium profile")
  const page = await browser.context.newPage()
  try {
    await page.goto("chrome://bookmarks/")
    await page.waitForFunction(() => typeof chrome !== "undefined" && !!chrome.bookmarks)
    return await fn(page)
  } finally {
    await page.close().catch(() => undefined)
    // Keep the AI's tab in front.
    await browser.page.bringToFront().catch(() => undefined)
  }
}

declare const chrome: {
  bookmarks: {
    getTree(): Promise<Node[]>
    create(b: { parentId?: string; title?: string; url?: string; index?: number }): Promise<Node>
    update(id: string, c: { title?: string; url?: string }): Promise<Node>
    move(id: string, d: { parentId?: string; index?: number }): Promise<Node>
    remove(id: string): Promise<void>
    removeTree(id: string): Promise<void>
    get(id: string): Promise<Node[]>
  }
}

function flatten(nodes: Node[], folder: string, out: Bookmark[]): void {
  for (const n of nodes) {
    const here = n.url ? folder : folder ? `${folder}/${n.title}` : n.title
    out.push({
      id: n.id,
      title: n.title,
      ...(n.url ? { url: n.url } : {}),
      folder: n.url ? folder : here,
    })
    if (n.children) flatten(n.children, here, out)
  }
}

/** Every bookmark and folder, with its folder path ("Bookmarks bar/News"). */
export async function listBookmarks(query?: string): Promise<Bookmark[]> {
  const tree = await withBookmarks((page) => page.evaluate(() => chrome.bookmarks.getTree()))
  const out: Bookmark[] = []
  flatten(tree[0]?.children ?? [], "", out)
  if (!query) return out
  const q = query.toLowerCase()
  return out.filter((b) => b.title.toLowerCase().includes(q) || b.url?.toLowerCase().includes(q))
}

/** A folder id from an id or a path such as "Bookmarks bar/News" (created when missing). */
async function resolveFolder(page: Page, folder: string | undefined): Promise<string> {
  return page.evaluate(async (folder) => {
    const tree = await chrome.bookmarks.getTree()
    const roots = tree[0]?.children ?? []
    if (!folder) return roots[0]?.id ?? "1"
    const byId = await chrome.bookmarks.get(folder).catch(() => null)
    if (byId?.[0] && !byId[0].url) return byId[0].id
    const parts = folder
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean)
    let level = roots
    let parent = roots.find((r) => r.title === parts[0] || r.id === parts[0])
    let i = parent ? 1 : 0
    if (!parent) parent = roots[0]
    for (; i < parts.length; i++) {
      level = parent?.children ?? []
      let next = level.find((n) => !n.url && n.title === parts[i])
      if (!next) next = await chrome.bookmarks.create({ parentId: parent!.id, title: parts[i] })
      parent = next
    }
    return parent!.id
  }, folder)
}

export async function addBookmark(input: {
  title: string
  url?: string | undefined
  folder?: string | undefined
}): Promise<Node> {
  return withBookmarks(async (page) => {
    const parentId = await resolveFolder(page, input.folder)
    return page.evaluate((b) => chrome.bookmarks.create(b), {
      parentId,
      title: input.title,
      ...(input.url ? { url: input.url } : {}),
    })
  })
}

export async function updateBookmark(
  id: string,
  change: {
    title?: string | undefined
    url?: string | undefined
    folder?: string | undefined
    index?: number | undefined
  },
): Promise<Node> {
  return withBookmarks(async (page) => {
    const fields = Object.fromEntries(
      Object.entries({ title: change.title, url: change.url }).filter(([, v]) => v !== undefined),
    )
    let node = await page.evaluate(([id, f]) => chrome.bookmarks.update(id, f), [
      id,
      fields,
    ] as const)
    if (change.folder !== undefined || change.index !== undefined) {
      const parentId =
        change.folder !== undefined ? await resolveFolder(page, change.folder) : undefined
      node = await page.evaluate(([id, d]) => chrome.bookmarks.move(id, d), [
        id,
        {
          ...(parentId ? { parentId } : {}),
          ...(change.index !== undefined ? { index: change.index } : {}),
        },
      ] as const)
    }
    return node
  })
}

export async function deleteBookmark(id: string): Promise<void> {
  await withBookmarks((page) => page.evaluate((id) => chrome.bookmarks.removeTree(id), id))
}
