import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { env } from "../env.js"

const run = promisify(execFile)

/**
 * Resolution of the noVNC stream. The browser always renders at SCREEN_WIDTH x SCREEN_HEIGHT;
 * x11vnc scales what it sends, and maps input back. Changed live through x11vnc remote control.
 */
export const RESOLUTIONS = [1080, 720, 480, 360] as const
export type Resolution = (typeof RESOLUTIONS)[number]

/** JPEG quality the viewer pairs with each resolution: smaller streams can afford sharper JPEG. */
export const QUALITY_FOR: Record<Resolution, number> = { 1080: 6, 720: 5, 480: 6, 360: 7 }

function initial(): number {
  const m = /^(\d+)x(\d+)$/.exec(process.env.VNC_SCALE ?? "1280x720")
  return m ? Number(m[2]) : env.SCREEN_HEIGHT
}

let current = initial()

export function available(): Resolution[] {
  return RESOLUTIONS.filter((h) => h <= env.SCREEN_HEIGHT)
}

export function currentResolution(): number {
  return current
}

export async function setResolution(height: number): Promise<number> {
  if (!available().includes(height as Resolution)) {
    throw new Error(`Resolution must be one of ${available().join(", ")}`)
  }
  const width = Math.round((height * env.SCREEN_WIDTH) / env.SCREEN_HEIGHT / 2) * 2
  const scale = height >= env.SCREEN_HEIGHT ? "1" : `${width}x${height}`
  await run("x11vnc", ["-display", env.DISPLAY, "-remote", `scale:${scale}`], { timeout: 10_000 })
  current = height
  return current
}
