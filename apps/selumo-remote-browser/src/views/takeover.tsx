import { raw } from "hono/html"
import type { FC } from "hono/jsx"

/**
 * Phone-friendly control of the remote browser, used when a person is asked to log in or step in.
 * Not VNC: a screenshot refreshed about once a second, taps sent as clicks, and text typed in the
 * phone's own input box (its keyboard, Korean and password autofill work) inserted by Playwright.
 */
const css = `
* { box-sizing: border-box; border-radius: 0 !important; }
html, body { margin: 0; background: #fff; color: #000; }
body { font: 14px/1.4 ui-monospace, "Noto Sans Mono CJK KR", monospace; display: flex; flex-direction: column; height: 100dvh; }
header { padding: 8px 10px; border-bottom: 2px solid #000; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
header .msg { flex: 1 1 100%; }
header .url { color: #666; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 0; min-width: 0; }
.req { background: #000; color: #fff; padding: 8px 10px; }
.req.done { background: #fff; color: #000; border-bottom: 1px solid #000; }
#view { flex: 1; overflow: auto; background: #222; -webkit-overflow-scrolling: touch; }
#shot { display: block; width: 100%; touch-action: manipulation; user-select: none; -webkit-user-select: none; }
#view.z2 #shot { width: 200%; } #view.z3 #shot { width: 300%; }
#dot { position: fixed; width: 22px; height: 22px; border: 3px solid #f0f; margin: -11px 0 0 -11px; pointer-events: none; display: none; }
footer { border-top: 2px solid #000; padding: 6px; display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; gap: 6px; align-items: center; }
input[type=text], input[type=password] { flex: 1; min-width: 0; font: inherit; font-size: 16px; padding: 10px; border: 1px solid #000; }
button, select { font: inherit; padding: 9px 10px; border: 1px solid #000; background: #fff; color: #000; }
button.primary { background: #000; color: #fff; }
.keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.keys button { padding: 9px 0; }
.muted { color: #666; font-size: 12px; }
label { display: flex; gap: 4px; align-items: center; white-space: nowrap; font-size: 13px; }
`

const script = `
const RB = window.RB
const view = document.getElementById("view"), shot = document.getElementById("shot")
const say = (t) => { document.getElementById("note").textContent = t || "" }
let busy = false, last = 0
async function refresh() {
  if (document.hidden) return
  last = Date.now()
  const next = new Image()
  next.onload = () => { shot.src = next.src; busy = false }
  next.onerror = () => { busy = false; say("화면을 못 받았어요 (브라우저가 닫혀 있을 수 있어요)") }
  busy = true
  next.src = "/takeover/shot.jpg?t=" + Date.now()
}
setInterval(() => { if (!busy && Date.now() - last > 900) refresh() }, 300)
refresh()

async function act(body) {
  const res = await fetch("/takeover/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null)
  const data = res ? await res.json().catch(() => ({})) : {}
  if (!res || !res.ok) say("실패: " + (data.error || "연결 오류"))
  else { say(""); if (data.url) document.getElementById("url").textContent = data.url }
  setTimeout(refresh, 250)
  return data
}

shot.addEventListener("click", (e) => {
  const r = shot.getBoundingClientRect()
  const x = (e.clientX - r.left) * (shot.naturalWidth / r.width)
  const y = (e.clientY - r.top) * (shot.naturalHeight / r.height)
  const dot = document.getElementById("dot")
  dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px"; dot.style.display = "block"
  setTimeout(() => { dot.style.display = "none" }, 600)
  act({ op: "click", x: Math.round(x), y: Math.round(y) })
})

document.getElementById("zoom").addEventListener("change", (e) => { view.className = e.target.value })

// Phone view: the remote tab renders at phone width (mobile layout) while this page is open.
const phone = document.getElementById("phone")
phone.addEventListener("change", () => act({ op: "phone", on: phone.checked }))
if (window.innerWidth < 700) { phone.checked = true; act({ op: "phone", on: true }) }
window.addEventListener("pagehide", () => {
  if (phone.checked) navigator.sendBeacon("/takeover/act", new Blob([JSON.stringify({ op: "phone", on: false })], { type: "application/json" }))
})

const field = document.getElementById("text")
document.getElementById("secret").addEventListener("change", (e) => {
  field.type = e.target.checked ? "password" : "text"
  field.autocomplete = e.target.checked ? "current-password" : "username"
  field.focus()
})
document.getElementById("send").addEventListener("submit", async (e) => {
  e.preventDefault()
  const text = field.value
  const enter = document.getElementById("enter").checked
  if (!text && !enter) return
  field.value = ""
  await act({ op: "type", text, enter })
})
for (const b of document.querySelectorAll("[data-key]")) b.addEventListener("click", () => act({ op: "key", key: b.dataset.key }))
for (const b of document.querySelectorAll("[data-op]")) b.addEventListener("click", () => act({ op: b.dataset.op, dy: Number(b.dataset.dy || 0) }))

async function answer(outcome) {
  if (!RB.id) return
  await fetch("/help/" + RB.id + "/" + outcome, { method: "POST" }).catch(() => null)
  status()
}
document.getElementById("done")?.addEventListener("click", () => answer("done"))
document.getElementById("decline")?.addEventListener("click", () => answer("cancelled"))

const OUT = { done: "끝났어요. 이 화면은 닫아도 돼요.", cancelled: "거절했어요.", timeout: "요청 시간이 지났어요." }
async function status() {
  const s = await fetch("/takeover/status.json" + (RB.id ? "?id=" + RB.id : "")).then((r) => r.json()).catch(() => null)
  if (!s) return
  if (s.url) document.getElementById("url").textContent = s.url
  const box = document.getElementById("req")
  if (box && s.outcome && s.outcome !== "pending") {
    box.className = "req done"
    box.querySelector(".msg").textContent = OUT[s.outcome] || s.outcome
    for (const b of box.querySelectorAll("button")) b.remove()
  }
}
setInterval(status, 3000)
status()
`

export const TakeoverPage: FC<{
  id: string | null
  label: string | null
  message: string | null
}> = ({ id, label, message }) => (
  <html lang="ko">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>{label ? `${label} · Remote Browser` : "원격 조작 · Remote Browser"}</title>
      <style dangerouslySetInnerHTML={{ __html: css }} />
    </head>
    <body>
      {id ? (
        <div class="req" id="req">
          <div class="row">
            <span class="msg" style="flex:1">
              <strong>{label}</strong> {message}
            </span>
            <button type="button" class="primary" id="done" style="border-color:#fff">
              완료
            </button>
            <button type="button" id="decline">
              거절
            </button>
          </div>
        </div>
      ) : null}
      <header>
        <span id="url" class="url">
          …
        </span>
        <label>
          <input type="checkbox" id="phone" /> 폰 화면
        </label>
        <select id="zoom" aria-label="확대">
          <option value="">맞춤</option>
          <option value="z2">2배</option>
          <option value="z3">3배</option>
        </select>
        <button type="button" data-op="back" aria-label="뒤로">
          ←
        </button>
        <button type="button" data-op="reload" aria-label="새로고침">
          ↻
        </button>
      </header>
      <div id="view">
        <img id="shot" alt="원격 브라우저 화면 (누르면 그 위치를 클릭)" />
      </div>
      <div id="dot" />
      <footer>
        <form id="send" class="row">
          <input
            id="text"
            type="text"
            autocomplete="username"
            placeholder="입력칸을 누른 뒤 여기에 입력"
          />
          <button type="submit" class="primary">
            넣기
          </button>
        </form>
        <div class="row">
          <label>
            <input type="checkbox" id="secret" /> 비밀번호 칸
          </label>
          <label>
            <input type="checkbox" id="enter" /> 넣고 Enter
          </label>
          <span id="note" class="muted" />
        </div>
        <div class="keys">
          <button type="button" data-key="Enter">
            Enter
          </button>
          <button type="button" data-key="Tab">
            Tab
          </button>
          <button type="button" data-key="Backspace">
            ⌫
          </button>
          <button type="button" data-key="Escape">
            Esc
          </button>
          <button type="button" data-op="scroll" data-dy="-600">
            ▲ 위로
          </button>
          <button type="button" data-op="scroll" data-dy="600">
            ▼ 아래로
          </button>
          <button type="button" data-key="Control+A">
            전체선택
          </button>
          <button type="button" data-op="tabs">
            탭 전환
          </button>
        </div>
      </footer>
      <script>{raw(`window.RB = ${JSON.stringify({ id })}`)}</script>
      <script dangerouslySetInnerHTML={{ __html: script }} />
    </body>
  </html>
)
