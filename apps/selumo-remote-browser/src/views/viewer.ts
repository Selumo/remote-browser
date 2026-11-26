/**
 * Minimal noVNC client: the remote screen scaled to fit its frame, with lower JPEG quality and
 * higher compression than noVNC's defaults. The browser itself still renders at full size; only
 * what is sent to the viewer is reduced. No beforeunload prompt and no page scroll.
 *
 * A small square control panel floats on the left edge (like noVNC's own control bar): resolution
 * (1080p/720p/480p/360p), view only, full screen, and inserting text at the remote focus. Choices are kept
 * per viewer in localStorage.
 */
export function viewerHtml(opts: {
  compression: number
  resolution: number
  resolutions: readonly number[]
  qualityFor: Record<number, number>
}): string {
  const options = opts.resolutions
    .map(
      (h, i) =>
        `<option value="${h}"${h === opts.resolution ? " selected" : ""}>${h}p${i === 0 ? " (원본)" : ""}</option>`,
    )
    .join("")
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>viewer</title>
<style>
  * { box-sizing: border-box; border-radius: 0; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }
  body { font: 12px/1.4 ui-monospace, "Noto Sans Mono CJK KR", monospace; }
  #screen { position: absolute; inset: 0; }
  #status { position: absolute; right: 0; top: 0; padding: 2px 8px; background: #000; color: #fff;
    border: 1px solid #fff; display: none; z-index: 3; }
  /* Settings: a small square tab in the top-left corner, faded until hovered; drops down. */
  #panel { position: absolute; left: 0; top: 0; z-index: 2; display: flex; flex-direction: column;
    align-items: flex-start; }
  #bar { display: flex; opacity: .55; transition: opacity .15s; }
  #panel:hover #bar, #panel.open #bar { opacity: 1; }
  #bar button { border: 1px solid #fff; border-top: 0; border-left: 0; background: #000; color: #fff;
    padding: 3px 10px; font: inherit; cursor: pointer; }
  #bar button:hover, #panel.open #handle { background: #fff; color: #000; border-color: #000; }
  #body { display: none; width: 240px; background: #fff; color: #000; border: 1px solid #000;
    border-top: 0; padding: 8px; }
  #panel.open #body { display: block; }
  #body h3 { margin: -8px -8px 8px; padding: 4px 8px; background: #000; color: #fff; font-size: 12px; }
  #body label { display: block; margin: 8px 0 4px; }
  #body label.row { display: flex; gap: 6px; align-items: center; }
  #body select, #body textarea { width: 100%; border: 1px solid #000; background: #fff; color: #000;
    font: inherit; padding: 4px; }
  #body textarea { height: 64px; resize: vertical; }
  #body button { margin-top: 6px; width: 100%; padding: 4px; border: 1px solid #000; background: #fff;
    color: #000; font: inherit; cursor: pointer; }
  #body button:hover { background: #000; color: #fff; }
</style>
</head>
<body>
<div id="status"></div>
<div id="panel">
  <div id="bar">
    <button id="handle" type="button" title="화면 설정">설정 ▾</button>
    <button id="fullscreen" type="button" title="전체화면 (Esc로 나가기)">전체화면</button>
  </div>
  <div id="body">
    <h3>화면 설정</h3>
    <label for="resolution">해상도 (보이는 화면만, 브라우저는 원본 그대로)</label>
    <select id="resolution">${options}</select>
    <label class="row"><input type="checkbox" id="viewonly" /> 보기 전용 (조작 막기)</label>
    <label for="clip">텍스트 보내기</label>
    <textarea id="clip" placeholder="원격 화면의 입력칸을 클릭한 뒤 여기 붙여넣고 보내기. 한글 가능"></textarea>
    <button id="sendclip" type="button">원격 입력칸에 넣기</button>
  </div>
</div>
<div id="screen"></div>
<script type="module">
  import RFB from "/novnc/core/rfb.js"

  const $ = (id) => document.getElementById(id)
  const store = {
    get(k, d) { try { const v = localStorage.getItem("viewer." + k); return v === null ? d : v } catch { return d } },
    set(k, v) { try { localStorage.setItem("viewer." + k, String(v)) } catch {} },
  }
  const say = (t) => { $("status").textContent = t; $("status").style.display = t ? "block" : "none" }

  const QUALITY = ${JSON.stringify(opts.qualityFor)}
  const settings = {
    resolution: ${opts.resolution},
    viewOnly: store.get("viewOnly", "false") === "true",
  }
  $("viewonly").checked = settings.viewOnly
  if (store.get("panel", "closed") === "open") {
    $("panel").classList.add("open")
    $("handle").textContent = "설정 ▴"
  }

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
    rfb = new RFB($("screen"), url, { wsProtocols: ["binary"] })
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

  $("handle").addEventListener("click", () => {
    const open = $("panel").classList.toggle("open")
    $("handle").textContent = open ? "설정 ▴" : "설정 ▾"
    store.set("panel", open ? "open" : "closed")
  })
  // Resolution is set on the server (x11vnc scales the stream), so it applies to every viewer.
  $("resolution").addEventListener("change", async (e) => {
    const height = Number(e.target.value)
    say(height + "p로 바꾸는 중…")
    const res = await fetch("/viewer/resolution", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ height }),
    }).catch(() => null)
    if (res && res.ok) {
      settings.resolution = height
      apply()
      say(height + "p")
    } else {
      e.target.value = String(settings.resolution)
      say("해상도를 바꾸지 못했어요")
    }
    setTimeout(() => say(""), 1500)
  })
  $("viewonly").addEventListener("change", (e) => {
    settings.viewOnly = e.target.checked
    store.set("viewOnly", settings.viewOnly)
    apply()
  })
  $("fullscreen").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else document.documentElement.requestFullscreen().catch(() => say("전체화면을 쓸 수 없어요"))
  })
  document.addEventListener("fullscreenchange", () => {
    $("fullscreen").textContent = document.fullscreenElement ? "전체화면 끝" : "전체화면"
  })
  // Goes through the app (Playwright insertText): VNC clipboard is Latin-1 and breaks Korean.
  $("sendclip").addEventListener("click", async () => {
    const text = $("clip").value
    if (!text) return
    const res = await fetch("/browser/insert-text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => null)
    const data = res ? await res.json().catch(() => ({})) : {}
    say(res && res.ok ? "넣었어요" : "실패: " + (data.error || "연결 오류"))
    if (res && res.ok) $("clip").value = ""
    setTimeout(() => say(""), 2500)
  })

  connect()
</script>
</body>
</html>`
}
