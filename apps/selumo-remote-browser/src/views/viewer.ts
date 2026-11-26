/**
 * Minimal noVNC client: the remote screen scaled to fit its frame, with lower JPEG quality and
 * higher compression than noVNC's defaults. The browser itself still renders at full size; only
 * what is sent to the viewer is reduced. No beforeunload prompt, no toolbar, no page scroll.
 */
export function viewerHtml(opts: { quality: number; compression: number }): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>viewer</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }
  #screen { position: absolute; inset: 0; }
  #status { position: absolute; left: 0; top: 0; padding: 2px 8px; background: #000; color: #fff;
    font: 12px ui-monospace, monospace; border: 1px solid #fff; display: none; z-index: 1; }
</style>
</head>
<body>
<div id="status"></div>
<div id="screen"></div>
<script type="module">
  import RFB from "/novnc/core/rfb.js"
  const status = document.getElementById("status")
  const say = (t) => { status.textContent = t; status.style.display = t ? "block" : "none" }
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/websockify"
  let retry = 0
  function connect() {
    say("연결 중…")
    const rfb = new RFB(document.getElementById("screen"), url, { wsProtocols: ["binary"] })
    rfb.scaleViewport = true
    rfb.resizeSession = false
    rfb.qualityLevel = ${opts.quality}
    rfb.compressionLevel = ${opts.compression}
    rfb.focusOnClick = true
    rfb.addEventListener("connect", () => { retry = 0; say("") })
    rfb.addEventListener("disconnect", () => {
      retry = Math.min(retry + 1, 5)
      say("연결 끊김, 다시 연결하는 중…")
      setTimeout(connect, retry * 1000)
    })
  }
  connect()
</script>
</body>
</html>`
}
