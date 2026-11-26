import { readFile, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".oga": "audio/ogg",
  ".mp3": "audio/mpeg",
}

/** Serves a file from `root` without letting `rel` escape it. */
export async function serveFile(root: string, rel: string): Promise<Response> {
  const base = path.resolve(root)
  const file = path.resolve(base, `.${path.posix.normalize(`/${rel}`)}`)
  if (file !== base && !file.startsWith(`${base}${path.sep}`))
    return new Response("Not found", { status: 404 })
  try {
    const info = await stat(file)
    if (!info.isFile()) return new Response("Not found", { status: 404 })
    const body = await readFile(file)
    return new Response(body, {
      headers: {
        "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "public, max-age=3600",
      },
    })
  } catch {
    return new Response("Not found", { status: 404 })
  }
}

const require = createRequire(import.meta.url)

/** Front-end libraries served from node_modules, no CDN. */
export const vendorFiles: Record<string, string> = {
  "htmx.js": require.resolve("htmx.org/dist/htmx.min.js"),
  "htmx-sse.js": require.resolve("htmx-ext-sse/sse.js"),
  "alpine.js": require.resolve("alpinejs/dist/cdn.min.js"),
}
