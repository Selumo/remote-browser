/**
 * Stream quality of the remote view, as KasmVNC's own presets. The browser always renders at
 * SCREEN_WIDTH x SCREEN_HEIGHT; the preset decides how KasmVNC encodes what it sends (JPEG
 * quality, and how far it downscales while the screen moves a lot). The viewer reloads with it.
 * KasmVNC only honours them because the entrypoint allows them in -AllowOverride.
 */
export const QUALITIES = {
  low: { level: 1, label: "낮음" },
  medium: { level: 2, label: "보통" },
  high: { level: 3, label: "높음" },
  extreme: { level: 4, label: "최고" },
  lossless: { level: 5, label: "무손실" },
} as const
export type Quality = keyof typeof QUALITIES

export function isQuality(v: unknown): v is Quality {
  return typeof v === "string" && v in QUALITIES
}

let current: Quality = isQuality(process.env.VNC_QUALITY) ? process.env.VNC_QUALITY : "medium"

export function currentQuality(): Quality {
  return current
}

export function setQuality(q: string, by = "dashboard"): Quality {
  if (!isQuality(q)) throw new Error(`Quality must be one of ${Object.keys(QUALITIES).join(", ")}`)
  if (q !== current) console.log(`[viewer] quality ${current} -> ${q} (${by})`)
  current = q
  return current
}
