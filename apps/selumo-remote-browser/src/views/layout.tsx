import type { Child, FC } from "hono/jsx"

// Black and white, square, no theme work: one font, 1px black lines, inverted buttons.
const css = `
* { box-sizing: border-box; border-radius: 0 !important; }
html { background: #fff; color: #000; }
body { margin: 0; font: 13px/1.5 ui-monospace, "SFMono-Regular", Menlo, "Noto Sans Mono CJK KR", monospace; }
a { color: #000; }
header { display: flex; gap: 16px; align-items: center; padding: 8px 16px; border-bottom: 2px solid #000; }
header nav { display: flex; gap: 0; }
header nav a { padding: 4px 10px; border: 1px solid #000; margin-right: -1px; text-decoration: none; }
header nav a.on { background: #000; color: #fff; }
header .spacer { flex: 1; }
main { padding: 16px; display: grid; gap: 16px; }
.grid { display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: 16px; align-items: start; }
@media (max-width: 960px) { .grid { grid-template-columns: 1fr; } }
.box { border: 1px solid #000; padding: 12px; min-width: 0; }
.box > h2 { margin: -12px -12px 12px; padding: 6px 12px; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; background: #000; color: #fff; }
.muted { color: #666; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #000; padding: 4px 6px; text-align: left; vertical-align: top; }
th { background: #000; color: #fff; font-weight: normal; }
td.wrap { max-width: 360px; overflow-wrap: anywhere; }
.scroll { overflow: auto; max-height: 520px; }
input, textarea, select { width: 100%; padding: 6px 8px; border: 1px solid #000; background: #fff; color: #000; font: inherit; }
textarea { min-height: 180px; }
label { display: block; margin: 10px 0 4px; }
input[type=checkbox] { width: auto; }
button, .btn { display: inline-block; padding: 4px 12px; border: 1px solid #000; background: #fff; color: #000; font: inherit; cursor: pointer; text-decoration: none; }
button:hover, .btn:hover, button.primary { background: #000; color: #fff; }
button.primary:hover { background: #fff; color: #000; }
.tag { display: inline-block; padding: 0 6px; border: 1px solid #000; }
.tag.on { background: #000; color: #fff; }
.tag.alert { background: #000; color: #fff; outline: 2px solid #000; outline-offset: 1px; animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { background: #fff; color: #000; } }
/* The viewer frame keeps the remote screen's aspect ratio (--sw/--sh) at the largest size that
   fits its box, so the remote screen never gets black side bars. */
.vnc-wrap { flex: 1; min-height: 0; container-type: size; display: flex; justify-content: center; align-items: flex-start; }
.vnc-frame { position: relative; outline: 1px solid #000; background: #000;
  width: min(100cqw, calc(100cqh * var(--sw) / var(--sh)));
  height: min(100cqh, calc(100cqw * var(--sh) / var(--sw))); }
.vnc-frame:fullscreen { width: 100vw; height: 100vh; outline: 0; }
.vnc { display: block; border: 0; width: 100%; height: 100%; background: #000; }
/* Full-height pages (the remote browser): the window never scrolls, panels fit the viewport. */
body.fill { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
body.fill main { flex: 1; min-height: 0; grid-template-rows: minmax(0, 1fr); }
body.fill .grid { height: 100%; grid-template-rows: minmax(0, 1fr); align-items: stretch; }
body.fill .grid > .box { overflow: auto; }
body.fill .grid > .box.screen { display: flex; flex-direction: column; overflow: hidden; }
.toolbar { margin-bottom: 8px; align-items: center; }
.toolbar .status { min-width: 0; flex: 0 1 auto; }
.toolbar .status .url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 36ch; }
.toolbar .controls { flex: 1 1 auto; }
.toolbar select { width: auto; padding: 3px 6px; }
@media (max-width: 960px) {
  body.fill { height: auto; overflow: auto; }
  body.fill .grid { height: auto; }
  body.fill .vnc-wrap { flex: none; container-type: inline-size; }
  body.fill .vnc-frame { width: 100%; height: auto; aspect-ratio: var(--sw) / var(--sh); }
}
.log { margin: 0; padding: 0; list-style: none; max-height: 380px; overflow: auto; }
.log li { padding: 1px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.log li.error, .error { font-weight: bold; text-decoration: underline; }
form p { margin: 10px 0 0; }
.cols { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0 16px; }
details.dom { border: 1px solid #000; margin-top: -1px; }
details.dom > summary { display: grid; grid-template-columns: minmax(0, 2fr) 70px 70px 50px 60px 150px;
  gap: 8px; padding: 4px 8px; cursor: pointer; list-style: none; }
tr.on td { background: #000; color: #fff; }
/* A request for a person, shown in the status bar above the remote screen. */
.help-request { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; width: 100%;
  padding: 8px 10px; border: 2px solid #000; background: #000; color: #fff; }
.help-request .muted { color: #ccc; }
.help-request button { border-color: #fff; }
tr.on td a { color: #fff; }
h3 { font-size: 13px; margin: 16px 0 6px; }
/* Markdown notes */
.md { overflow-wrap: anywhere; }
.md img { max-width: 100%; border: 1px solid #000; }
.md pre { border: 1px solid #000; padding: 8px; overflow: auto; }
.md code { background: #eee; padding: 0 3px; }
.md pre code { background: none; padding: 0; }
.md blockquote { margin: 0; padding-left: 10px; border-left: 3px solid #000; }
.md table { width: auto; }
.editor textarea { min-height: 60vh; }
/* Image grid */
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.gallery figure { margin: 0; border: 1px solid #000; display: flex; flex-direction: column; }
.gallery img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-bottom: 1px solid #000; }
.gallery figcaption { padding: 6px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.gallery .url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* MCP page guides */
details.guide { border: 1px solid #000; margin-top: -1px; padding: 0 10px; }
details.guide > summary { padding: 6px 0; cursor: pointer; font-weight: bold; }
details.guide[open] { padding-bottom: 10px; }
#mcp-tools dt { font-weight: bold; margin-top: 6px; }
#mcp-tools dd { margin: 0 0 0 12px; color: #444; }
/* Copyable values */
.copy { display: flex; gap: 8px; align-items: flex-start; }
.copy code, .copy pre { flex: 1; min-width: 0; margin: 0; padding: 6px 8px; border: 1px solid #000; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
details.dom > summary::-webkit-details-marker { display: none; }
details.dom[open] > summary, details.dom > summary:hover { background: #000; color: #fff; }
details.dom > summary.head { background: #000; color: #fff; cursor: default; }
details.dom table { border-top: 1px solid #000; }
details.dom table td, details.dom table th { border-left: 0; border-right: 0; }
`

export type Section = "browser" | "jobs" | "profiles" | "docs" | "data" | "images" | "mcp" | null

export const Layout: FC<{
  title: string
  user?: string
  section?: Section
  fill?: boolean
  children: Child
}> = ({ title, user, section, fill, children }) => (
  <html lang="ko">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <script src="/vendor/htmx.js" defer />
      <script src="/vendor/htmx-sse.js" defer />
      <script src="/vendor/alpine.js" defer />
    </head>
    <body class={fill ? "fill" : ""}>
      {user ? (
        <header>
          <strong>REMOTE BROWSER</strong>
          <nav>
            <a href="/" class={section === "browser" ? "on" : ""}>
              브라우저
            </a>
            <a href="/jobs" class={section === "jobs" ? "on" : ""}>
              작업
            </a>
            <a href="/profiles" class={section === "profiles" ? "on" : ""}>
              프로필
            </a>
            <a href="/docs" class={section === "docs" ? "on" : ""}>
              문서
            </a>
            <a href="/data" class={section === "data" ? "on" : ""}>
              데이터
            </a>
            <a href="/images" class={section === "images" ? "on" : ""}>
              이미지
            </a>
            <a href="/mcp-setup" class={section === "mcp" ? "on" : ""}>
              MCP
            </a>
          </nav>
          <span class="spacer" />
          <span class="muted">{user}</span>
          <form method="post" action="/logout">
            <button type="submit">로그아웃</button>
          </form>
        </header>
      ) : null}
      <main>{children}</main>
    </body>
  </html>
)
