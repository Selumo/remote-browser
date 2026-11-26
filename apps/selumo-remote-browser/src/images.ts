import type { Page } from "playwright"
import { ensureSuperuser, pb } from "./pb.js"

/** Stored images: page captures, uploads, job screenshots. Files live in PocketBase. */
export type ImageSource = "capture" | "upload" | "job" | "mcp"

export type ImageRecord = {
  id: string
  collectionId: string
  file: string
  title: string
  source: ImageSource
  page_url: string
  job: string
  run: string
  created: string
}

export async function saveImage(input: {
  data: Uint8Array
  filename: string
  mime: string
  title?: string | undefined
  source: ImageSource
  pageUrl?: string | undefined
  job?: string | undefined
  run?: string | undefined
}): Promise<ImageRecord> {
  await ensureSuperuser()
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(input.data)], { type: input.mime }), input.filename)
  form.append("title", (input.title ?? "").slice(0, 200))
  form.append("source", input.source)
  if (input.pageUrl) form.append("page_url", input.pageUrl.slice(0, 2000))
  if (input.job) form.append("job", input.job)
  if (input.run) form.append("run", input.run)
  return pb.collection("images").create<ImageRecord>(form)
}

/** Screenshot of the page's viewport, stored as an image. */
export async function captureImage(
  page: Page,
  opts: {
    title?: string | undefined
    source: ImageSource
    job?: string
    run?: string
    fullPage?: boolean
  },
): Promise<ImageRecord> {
  const png = await page.screenshot({ type: "png", fullPage: opts.fullPage ?? false })
  const title = opts.title || (await page.title().catch(() => "")) || page.url()
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return saveImage({
    data: png,
    filename: `capture-${stamp}.png`,
    mime: "image/png",
    title,
    source: opts.source,
    pageUrl: page.url(),
    job: opts.job,
    run: opts.run,
  })
}

export async function listImages(
  opts: { limit?: number; job?: string | undefined } = {},
): Promise<ImageRecord[]> {
  await ensureSuperuser()
  const res = await pb
    .collection("images")
    .getList<ImageRecord>(1, Math.min(opts.limit ?? 60, 500), {
      sort: "-created",
      ...(opts.job ? { filter: pb.filter("job = {:job}", { job: opts.job }) } : {}),
    })
  return res.items
}

/** By id, or the newest image with this exact title (for ![[title]] embeds). */
export async function findImage(ref: string): Promise<ImageRecord | null> {
  await ensureSuperuser()
  return pb
    .collection("images")
    .getFirstListItem<ImageRecord>(pb.filter("id = {:v} || title = {:v}", { v: ref.trim() }), {
      sort: "-created",
    })
    .catch(() => null)
}

/** Fetches the protected file from PocketBase with a short-lived file token. */
export async function imageFile(record: ImageRecord): Promise<Response> {
  await ensureSuperuser()
  const token = await pb.files.getToken()
  const url = pb.files.getURL(record, record.file, { token })
  return fetch(url)
}

export async function deleteImage(ref: string): Promise<void> {
  const image = await findImage(ref)
  if (!image) throw new Error(`Image not found: ${ref}`)
  await pb.collection("images").delete(image.id)
}
