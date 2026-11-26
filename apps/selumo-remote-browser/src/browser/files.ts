import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type { FileChooser, Page } from "playwright"
import { env } from "../env.js"

/**
 * Files moving between the remote browser and people:
 * - download: what the remote browser downloaded (DATA_DIR/downloads)
 * - upload: what a person sent from their own computer through the dashboard (DATA_DIR/uploads)
 * Names are stored as "<timestamp>-<original name>". When a page opens a file chooser
 * (an "upload" button), it is intercepted instead of showing the remote desktop's file dialog,
 * and filled with uploaded files.
 */
export type Store = "download" | "upload"
export type StoredFile = { store: Store; name: string; size: number; saved: string }

const DIRS: Record<Store, string> = {
  download: path.join(env.DATA_DIR, "downloads"),
  upload: path.join(env.DATA_DIR, "uploads"),
}

const stampName = (name: string) => {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")
  const safe =
    name
      .replace(/[/\\\0]/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 180) || "file"
  return `${stamp}-${safe}`
}

/** The name without the timestamp prefix, as the file should appear to a website. */
export const originalName = (name: string) => name.replace(/^\d{8}T\d{6}-/, "")

export function filePath(store: Store, name: string): string {
  const base = path.basename(name)
  if (!base || base !== name) throw new Error(`Invalid file name: ${name}`)
  return path.join(DIRS[store], base)
}

export async function listFiles(store?: Store): Promise<StoredFile[]> {
  const stores: Store[] = store ? [store] : ["upload", "download"]
  const all = await Promise.all(
    stores.map(async (s) => {
      const names = await readdir(DIRS[s]).catch(() => [] as string[])
      return Promise.all(
        names.map(async (name) => {
          const st = await stat(path.join(DIRS[s], name)).catch(() => null)
          return st?.isFile()
            ? { store: s, name, size: st.size, saved: st.mtime.toISOString() }
            : null
        }),
      )
    }),
  )
  return all
    .flat()
    .filter((f): f is StoredFile => f !== null)
    .sort((a, b) => (a.saved < b.saved ? 1 : -1))
}

/** The newest file whose name equals or contains `ref`. */
export async function findFile(store: Store, ref: string): Promise<StoredFile> {
  const files = await listFiles(store)
  const hit = files.find((f) => f.name === ref) ?? files.find((f) => f.name.includes(ref))
  if (!hit) throw new Error(`No ${store} file matching: ${ref}`)
  return hit
}

export async function readStored(store: Store, ref: string) {
  const file = await findFile(store, ref)
  return { file, data: await readFile(filePath(store, file.name)) }
}

export async function deleteStored(store: Store, ref: string): Promise<string> {
  const file = await findFile(store, ref)
  await rm(filePath(store, file.name))
  return file.name
}

export async function saveUpload(name: string, data: Uint8Array): Promise<StoredFile> {
  await mkdir(DIRS.upload, { recursive: true })
  const stored = stampName(name)
  await writeFile(path.join(DIRS.upload, stored), data)
  return { store: "upload", name: stored, size: data.byteLength, saved: new Date().toISOString() }
}

// ---------- downloads ----------

const pending = new Set<string>()
let lastError: string | null = null

export function watchDownloads(page: Page): void {
  page.on("download", (download) => {
    void (async () => {
      const name = stampName(download.suggestedFilename())
      pending.add(name)
      try {
        await mkdir(DIRS.download, { recursive: true })
        await download.saveAs(path.join(DIRS.download, name))
        lastError = null
      } catch (e) {
        lastError = `${name}: ${e instanceof Error ? e.message : String(e)}`
      } finally {
        pending.delete(name)
      }
    })()
  })
}

export function pendingDownloads() {
  return { in_progress: [...pending], last_error: lastError }
}

// ---------- file chooser ----------

/** The page's open file chooser, waiting for files from a person or the AI. */
let chooser: { fc: FileChooser; multiple: boolean; site: string; since: string } | null = null

export function watchFileChooser(page: Page): void {
  page.on("filechooser", (fc) => {
    let site = ""
    try {
      site = new URL(page.url()).hostname
    } catch {
      // about:blank
    }
    chooser = { fc, multiple: fc.isMultiple(), site, since: new Date().toISOString() }
    console.log(`[files] ${site} opened a file chooser${chooser.multiple ? " (multiple)" : ""}`)
  })
  page.on("close", () => {
    if (chooser?.fc.page() === page) chooser = null
  })
}

export function pendingChooser() {
  if (chooser?.fc.page().isClosed()) chooser = null
  return chooser ? { multiple: chooser.multiple, site: chooser.site, since: chooser.since } : null
}

export type UploadPayload = { name: string; mimeType: string; buffer: Buffer }

/** Fills the waiting file chooser. Returns false when no page is waiting for files. */
export async function fillChooser(files: UploadPayload[]): Promise<boolean> {
  const c = chooser
  if (!c || c.fc.page().isClosed()) return false
  chooser = null
  await c.fc.setFiles(c.multiple ? files : files.slice(0, 1))
  return true
}

export function cancelChooser(): void {
  const c = chooser
  chooser = null
  void c?.fc.setFiles([]).catch(() => undefined)
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
export function mimeOf(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream"
}

/** Payload for a stored file, as a website should see it. */
export async function payload(store: Store, ref: string): Promise<UploadPayload> {
  const { file, data } = await readStored(store, ref)
  return { name: originalName(file.name), mimeType: mimeOf(file.name), buffer: data }
}
