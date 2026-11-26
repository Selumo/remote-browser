/**
 * Minimal noVNC client: the remote screen scaled to fit its frame. The browser itself renders at
 * full size; x11vnc scales the stream to the chosen resolution and JPEG quality follows it.
 * No controls inside the frame: the dashboard status bar drives it through `window.viewer`
 * (same origin). No beforeunload prompt and no page scroll.
 */
export function viewerHtml(opts: {
  compression: number
  resolution: number
  qualityFor: Record<number, number>
}): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>viewer</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }
  #screen { position: absolute; inset: 0; }
  #status { position: absolute; right: 0; top: 0; padding: 2px 8px; background: #000; color: #fff;
    border: 1px solid #fff; display: none; z-index: 1;
    font: 12px ui-monospace, "Noto Sans Mono CJK KR", monospace; }
</style>
</head>
<body>
<div id="status"></div>
<div id="screen"></div>
<script type="module">
  import RFB from "/novnc/core/rfb.js"

  const QUALITY = ${JSON.stringify(opts.qualityFor)}
  const status = document.getElementById("status")
  const say = (t) => { status.textContent = t; status.style.display = t ? "block" : "none" }
  const readViewOnly = () => { try { return localStorage.getItem("viewer.viewOnly") === "true" } catch { return false } }

  const settings = { resolution: ${opts.resolution}, viewOnly: readViewOnly() }
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/websockify"
  let rfb = null
  let retry = 0

  function apply() {
    if (!rfb) return
    rfb.qualityLevel = QUALITY[settings.resolution] ?? 5
    rfb.viewOnly = settings.viewOnly
  }

  function connect() {
    say("연결 중…")
    rfb = new RFB(document.getElementById("screen"), url, { wsProtocols: ["binary"] })
    rfb.scaleViewport = true
    rfb.resizeSession = false
    rfb.compressionLevel = ${opts.compression}
    rfb.focusOnClick = true
    apply()
    rfb.addEventListener("connect", () => { retry = 0; say("") })
    rfb.addEventListener("disconnect", () => {
      rfb = null
      retry = Math.min(retry + 1, 5)
      say("연결 끊김, 다시 연결하는 중…")
      setTimeout(connect, retry * 1000)
    })
  }

  // Called by the dashboard status bar.
  window.viewer = {
    setResolution(height) { settings.resolution = height; apply() },
    setViewOnly(on) { settings.viewOnly = Boolean(on); apply() },
  }

  connect()
</script>
</body>
</html>`
}
