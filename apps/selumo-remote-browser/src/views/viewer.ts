/**
 * Minimal noVNC client: the remote screen scaled to fit its frame. The browser itself renders at
 * full size; x11vnc scales the stream to the chosen resolution and JPEG quality follows it.
 * No controls inside the frame: the dashboard status bar drives it through `window.viewer`
 * (same origin). Keyboard input supports the local IME, so Korean can be typed directly.
 * No beforeunload prompt and no page scroll.
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
  #status, #compose { position: absolute; padding: 2px 8px; background: #000; color: #fff;
    border: 1px solid #fff; display: none; z-index: 1;
    font: 12px ui-monospace, "Noto Sans Mono CJK KR", monospace; }
  #status { right: 0; top: 0; }
  #compose { left: 0; bottom: 0; font-size: 16px; }
  /* Receives the keyboard so the local IME (Korean) can compose; invisible and click-through. */
  #ime { position: absolute; left: 0; bottom: 0; width: 1px; height: 1px; opacity: 0; border: 0;
    padding: 0; resize: none; pointer-events: none; z-index: 0; }
</style>
</head>
<body>
<div id="status"></div>
<div id="compose"></div>
<textarea id="ime" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
<div id="screen"></div>
<script type="module">
  import RFB from "/novnc/core/rfb.js"
  import Keyboard from "/novnc/core/input/keyboard.js"
  import keysyms from "/novnc/core/input/keysymdef.js"

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
    // The hidden textarea takes focus instead of the canvas, see the keyboard section below.
    rfb.focusOnClick = false
    apply()
    rfb.addEventListener("connect", () => { retry = 0; say("") })
    rfb.addEventListener("disconnect", () => {
      rfb = null
      retry = Math.min(retry + 1, 5)
      say("연결 끊김, 다시 연결하는 중…")
      setTimeout(connect, retry * 1000)
    })
  }

  // ---------- keyboard with IME support ----------
  // noVNC ignores keys typed while an IME composes (keyCode 229), so Korean never reaches the
  // remote. Keys go to a hidden textarea instead: ordinary keys through noVNC's own Keyboard,
  // committed IME text as Unicode keysyms (x11vnc adds missing keysyms to the X keymap), so it
  // also works outside web pages, such as the address bar.
  const ime = document.getElementById("ime")
  const compose = document.getElementById("compose")
  const showCompose = (t) => { compose.textContent = t; compose.style.display = t ? "block" : "none" }
  const keyboard = new Keyboard(ime)
  keyboard.onkeyevent = (keysym, code, down) => {
    if (rfb && !settings.viewOnly) rfb.sendKey(keysym, code, down)
  }
  keyboard.grab()

  function sendText(text) {
    if (!rfb || settings.viewOnly || !text) return
    for (const ch of text) {
      const cp = ch.codePointAt(0)
      if (cp === 10) { rfb.sendKey(0xff0d, "Enter"); continue }
      rfb.sendKey(keysyms.lookup(cp), null)
    }
  }
  const clear = () => setTimeout(() => { ime.value = "" }, 0)

  // Live composition: the syllable being typed is mirrored on the remote as it changes (only
  // the part that differs is erased and rewritten), so text shows up without pressing space.
  let composing = false
  let sawProcessKey = false
  let mirrored = []
  function mirror(next) {
    if (!rfb || settings.viewOnly) { mirrored = [...next]; return }
    const want = [...next]
    let same = 0
    while (same < mirrored.length && same < want.length && mirrored[same] === want[same]) same++
    for (let i = same; i < mirrored.length; i++) rfb.sendKey(0xff08, "Backspace")
    sendText(want.slice(same).join(""))
    mirrored = want
  }
  ime.addEventListener("compositionstart", () => { composing = true; mirrored = [] })
  ime.addEventListener("compositionupdate", (e) => { showCompose(e.data); mirror(e.data) })
  ime.addEventListener("compositionend", (e) => {
    composing = false
    showCompose("")
    mirror(e.data ?? "")
    mirrored = []
    clear()
  })
  // Text the IME inserts outside a composition (a space or punctuation right after a syllable).
  ime.addEventListener("input", (e) => {
    if (composing || e.isComposing) return
    if (e.inputType === "insertText" && e.data) sendText(e.data)
    clear()
  })
  // Held keys: the browser repeats keydown, noVNC forwards it as another press of a key that is
  // already down, which X ignores. Send each repeat as release + press so it really repeats.
  ime.addEventListener("keydown", (e) => {
    if (!e.repeat || composing || e.keyCode === 229 || !rfb || settings.viewOnly) return
    const keysym = keyboard._keyDownList?.[e.code]
    if (!keysym) return
    rfb.sendKey(keysym, e.code, false)
    rfb.sendKey(keysym, e.code, true)
    e.preventDefault()
    e.stopImmediatePropagation()
  }, true)
  // Enter that also commits a syllable arrives as keyCode 229, which noVNC drops.
  ime.addEventListener("keydown", (e) => { if (e.keyCode === 229) sawProcessKey = true }, true)
  ime.addEventListener("keyup", (e) => {
    if (sawProcessKey && !composing && e.key === "Enter" && rfb && !settings.viewOnly) {
      rfb.sendKey(0xff0d, "Enter")
    }
    if (!composing) sawProcessKey = false
  })

  // Capture phase: noVNC stops mouse events on its canvas, so a bubbling listener never runs.
  const focusKeyboard = () => setTimeout(() => ime.focus({ preventScroll: true }), 0)
  const screenEl = document.getElementById("screen")
  for (const type of ["pointerdown", "mousedown", "touchstart"]) {
    screenEl.addEventListener(type, focusKeyboard, { capture: true, passive: true })
  }
  window.addEventListener("focus", focusKeyboard)
  focusKeyboard()

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
