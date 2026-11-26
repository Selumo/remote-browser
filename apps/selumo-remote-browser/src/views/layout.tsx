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
.vnc { display: block; width: 100%; height: calc(100vh - 150px); min-height: 420px; border: 1px solid #000; background: #000; }
.log { margin: 0; padding: 0; list-style: none; max-height: 380px; overflow: auto; }
.log li { padding: 1px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.log li.error, .error { font-weight: bold; text-decoration: underline; }
form p { margin: 10px 0 0; }
`

export type Section = "browser" | "jobs" | null

export const Layout: FC<{ title: string; user?: string; section?: Section; children: Child }> = ({
  title,
  user,
  section,
  children,
}) => (
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
    <body>
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
