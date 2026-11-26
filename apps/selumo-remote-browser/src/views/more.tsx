import { raw } from "hono/html"
import type { FC } from "hono/jsx"
import type { StoredFile } from "../browser/files.js"
import type { Doc } from "../docs.js"
import { docHref } from "../docs.js"
import type { ImageRecord } from "../images.js"
import type { CrawlItem } from "../pb.js"
import { Layout } from "./layout.js"

/** Pages for docs (markdown notes), crawl data across jobs, stored images and MCP setup. */

const TZ = process.env.SCHEDULE_TZ || "Asia/Seoul"
const clock = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
})
const when = (iso: string) => {
  const d = new Date(iso.replace(" ", "T"))
  return Number.isNaN(d.getTime()) ? iso : clock.format(d)
}

const ErrorLine: FC<{ error?: string | undefined }> = ({ error }) =>
  error ? <p class="error">{error}</p> : null

// ---------- docs ----------

export const DocsPage: FC<{
  user: string
  docs: Doc[]
  tags: { tag: string; count: number }[]
  q: string
  tag: string
  error?: string | undefined
}> = ({ user, docs, tags, q, tag, error }) => (
  <Layout title="문서 · Remote Browser" user={user} section="docs">
    <div class="grid">
      <section class="box">
        <h2>새 문서</h2>
        <form method="post" action="/docs">
          <label for="title">제목</label>
          <input id="title" name="title" required maxlength={200} />
          <label for="body">내용 (마크다운)</label>
          <textarea
            id="body"
            name="body"
            placeholder="[[다른 문서]] 링크, ![[이미지 제목]] 삽입, #태그"
          />
          <ErrorLine error={error} />
          <p>
            <button type="submit" class="primary">
              만들기
            </button>
          </p>
        </form>
        {tags.length ? (
          <>
            <h3>태그</h3>
            <p class="row">
              {tags.map((t) => (
                <a
                  class={`tag ${t.tag === tag ? "on" : ""}`}
                  href={t.tag === tag ? "/docs" : `/docs?tag=${encodeURIComponent(t.tag)}`}
                >
                  #{t.tag} {t.count}
                </a>
              ))}
            </p>
          </>
        ) : null}
      </section>
      <section class="box">
        <h2>문서</h2>
        <form method="get" action="/docs" class="row" style="flex-wrap:nowrap">
          <input name="q" value={q} placeholder="제목이나 내용 검색" />
          {tag ? <input type="hidden" name="tag" value={tag} /> : null}
          <button type="submit">검색</button>
        </form>
        {docs.length ? (
          <table style="margin-top:8px">
            <tr>
              <th>제목</th>
              <th>태그</th>
              <th style="width:150px">수정</th>
            </tr>
            {docs.map((d) => (
              <tr>
                <td>
                  <a href={docHref(d.title)}>{d.title}</a>
                </td>
                <td>{(d.tags ?? []).map((t) => `#${t}`).join(" ")}</td>
                <td>{when(d.updated)}</td>
              </tr>
            ))}
          </table>
        ) : (
          <p class="muted">{q || tag ? "찾는 문서가 없어요." : "아직 문서가 없어요."}</p>
        )}
      </section>
    </div>
  </Layout>
)

export const DocPage: FC<{ user: string; doc: Doc; html: string; backlinks: Doc[] }> = ({
  user,
  doc,
  html,
  backlinks,
}) => (
  <Layout title={`${doc.title} · 문서`} user={user} section="docs">
    <div class="grid">
      <section class="box">
        <h2>문서 정보</h2>
        <p>
          <a href="/docs">← 목록</a>
        </p>
        <p class="muted">수정 {when(doc.updated)}</p>
        <div class="row">
          <a class="btn primary" href={`/docs/${doc.id}/edit`}>
            편집
          </a>
          <form
            method="post"
            action={`/docs/${doc.id}/delete`}
            onsubmit="return confirm('이 문서를 지울까요?')"
          >
            <button type="submit">삭제</button>
          </form>
        </div>
        <h3>이 문서를 링크한 문서</h3>
        {backlinks.length ? (
          <ul>
            {backlinks.map((b) => (
              <li>
                <a href={docHref(b.title)}>{b.title}</a>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">없어요.</p>
        )}
      </section>
      <section class="box">
        <h2>{doc.title}</h2>
        <article class="md">{raw(html)}</article>
      </section>
    </div>
  </Layout>
)

export const DocEditPage: FC<{
  user: string
  doc: { id?: string; title: string; body: string }
  preview: string
  error?: string | undefined
}> = ({ user, doc, preview, error }) => (
  <Layout title={`${doc.title || "새 문서"} 편집 · 문서`} user={user} section="docs">
    <form method="post" action={doc.id ? `/docs/${doc.id}` : "/docs"} class="grid editor">
      <section class="box">
        <h2>편집</h2>
        <label for="title">제목</label>
        <input id="title" name="title" value={doc.title} required maxlength={200} />
        <label for="body">내용 (마크다운)</label>
        <textarea
          id="body"
          name="body"
          hx-post="/docs/preview"
          hx-trigger="input changed delay:300ms"
          hx-target="#preview"
          hx-swap="innerHTML"
        >
          {doc.body}
        </textarea>
        <ErrorLine error={error} />
        <p class="row">
          <button type="submit" class="primary">
            저장
          </button>
          <a class="btn" href={doc.id ? docHref(doc.title) : "/docs"}>
            취소
          </a>
        </p>
        <p class="muted">[[문서 제목]] 링크 · [[제목|보이는 글]] · ![[이미지 제목]] 삽입 · #태그</p>
      </section>
      <section class="box">
        <h2>미리보기</h2>
        <article class="md" id="preview">
          {raw(preview)}
        </article>
      </section>
    </form>
  </Layout>
)

// ---------- data ----------

export type JobData = { id: string; name: string; total: number }

export const DataPage: FC<{
  user: string
  jobs: JobData[]
  selected: JobData | null
  items: CrawlItem[]
  columns: string[]
  files: StoredFile[]
}> = ({ user, jobs, selected, items, columns, files }) => (
  <Layout title="데이터 · Remote Browser" user={user} section="data">
    <div class="grid">
      <section class="box">
        <h2>작업별 데이터</h2>
        {jobs.length ? (
          <table>
            <tr>
              <th>작업</th>
              <th style="width:70px">건수</th>
              <th style="width:60px">CSV</th>
            </tr>
            {jobs.map((j) => (
              <tr class={selected?.id === j.id ? "on" : ""}>
                <td>
                  <a href={`/data?job=${j.id}`}>{j.name}</a>
                </td>
                <td>{j.total}</td>
                <td>{j.total ? <a href={`/jobs/${j.id}/items.csv`}>받기</a> : null}</td>
              </tr>
            ))}
          </table>
        ) : (
          <p class="muted">아직 작업이 없어요.</p>
        )}
      </section>
      <section class="box">
        <h2>{selected ? `${selected.name} 데이터` : "데이터"}</h2>
        {selected ? (
          <>
            <p class="row">
              <span>
                전체 {selected.total}건 중 최근 {items.length}건
              </span>
              <a class="btn" href={`/jobs/${selected.id}/items.csv`}>
                CSV 다운로드
              </a>
              <a class="btn" href={`/jobs/${selected.id}`}>
                작업 열기
              </a>
            </p>
            {items.length ? (
              <div class="scroll">
                <table>
                  <tr>
                    <th style="width:150px">수집</th>
                    {columns.map((c) => (
                      <th>{c}</th>
                    ))}
                  </tr>
                  {items.map((it) => (
                    <tr>
                      <td>{when(it.created)}</td>
                      {columns.map((c) => (
                        <td class="wrap">{String((it.data ?? {})[c] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </table>
              </div>
            ) : (
              <p class="muted">수집된 데이터가 없어요.</p>
            )}
          </>
        ) : (
          <p class="muted">왼쪽에서 작업을 고르세요.</p>
        )}
      </section>
      <section class="box" id="files" style="grid-column: 1 / -1">
        <h2>파일 {files.length}개</h2>
        <p class="muted">
          내려받음: 원격 브라우저가 다운로드한 파일. 올림: 브라우저 화면의 "파일 올리기"로 내 PC에서
          보낸 파일. AI는 files 도구로 읽고 act upload로 페이지에 넣어요.
        </p>
        {files.length ? (
          <table>
            <tr>
              <th style="width:80px">종류</th>
              <th>파일</th>
              <th style="width:100px">크기</th>
              <th style="width:150px">저장</th>
              <th style="width:60px" />
            </tr>
            {files.map((f) => (
              <tr>
                <td>{f.store === "upload" ? "올림" : "내려받음"}</td>
                <td class="wrap">
                  <a href={`/files/${f.store}/${encodeURIComponent(f.name)}`}>{f.name}</a>
                </td>
                <td>
                  {f.size < 1024 * 1024
                    ? `${Math.ceil(f.size / 1024)} KB`
                    : `${(f.size / 1048576).toFixed(1)} MB`}
                </td>
                <td>{when(f.saved)}</td>
                <td>
                  <form
                    method="post"
                    action={`/files/${f.store}/${encodeURIComponent(f.name)}/delete`}
                    onsubmit="return confirm('이 파일을 지울까요?')"
                  >
                    <button type="submit">삭제</button>
                  </form>
                </td>
              </tr>
            ))}
          </table>
        ) : (
          <p class="muted">아직 파일이 없어요.</p>
        )}
      </section>
    </div>
  </Layout>
)

// ---------- images ----------

export const ImagesPage: FC<{
  user: string
  images: ImageRecord[]
  browserOpen: boolean
  error?: string | undefined
}> = ({ user, images, browserOpen, error }) => (
  <Layout title="이미지 · Remote Browser" user={user} section="images">
    <div class="grid">
      <section class="box">
        <h2>이미지 추가</h2>
        <form method="post" action="/images/capture">
          <label for="cap-title">현재 화면 캡처</label>
          <input
            id="cap-title"
            name="title"
            placeholder="제목 (비우면 페이지 제목)"
            maxlength={200}
          />
          <p class="row">
            <label class="row" style="margin:0">
              <input type="checkbox" name="full" value="1" /> 페이지 전체
            </label>
            <button type="submit" class="primary" disabled={!browserOpen}>
              캡처
            </button>
          </p>
          {browserOpen ? null : <p class="muted">열린 브라우저가 없어요.</p>}
        </form>
        <form method="post" action="/images/upload" enctype="multipart/form-data">
          <label for="up-file">파일 올리기 (PNG, JPEG, WebP, GIF, 20MB까지)</label>
          <input
            id="up-file"
            type="file"
            name="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            required
          />
          <label for="up-title">제목</label>
          <input id="up-title" name="title" placeholder="비우면 파일 이름" maxlength={200} />
          <p>
            <button type="submit">올리기</button>
          </p>
        </form>
        <ErrorLine error={error} />
        <p class="muted">문서에는 ![[이미지 제목]]으로 넣을 수 있어요.</p>
      </section>
      <section class="box">
        <h2>이미지 {images.length}개</h2>
        {images.length ? (
          <div class="gallery">
            {images.map((img) => (
              <figure>
                <a href={`/images/${img.id}/file`} target="_blank" rel="noopener">
                  <img src={`/images/${img.id}/file`} alt={img.title} loading="lazy" />
                </a>
                <figcaption>
                  <strong>{img.title || "(제목 없음)"}</strong>
                  <span class="muted">
                    {when(img.created)} · {img.source}
                  </span>
                  {img.page_url ? (
                    <a
                      class="muted url"
                      href={img.page_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {img.page_url}
                    </a>
                  ) : null}
                  <form
                    method="post"
                    action={`/images/${img.id}/delete`}
                    onsubmit="return confirm('이 이미지를 지울까요?')"
                  >
                    <button type="submit">삭제</button>
                  </form>
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <p class="muted">아직 이미지가 없어요.</p>
        )}
      </section>
    </div>
  </Layout>
)

// ---------- MCP setup ----------

export const McpPage: FC<{ user: string; url: string; hasToken: boolean; emails: string[] }> = ({
  user,
  url,
  hasToken,
  emails,
}) => {
  const add = `claude mcp add --transport http remote-browser ${url} --header "Authorization: Bearer $MCP_TOKEN"`
  const json = JSON.stringify(
    {
      mcpServers: {
        "remote-browser": {
          type: "http",
          url,
          headers: { Authorization: "Bearer ${MCP_TOKEN}" },
        },
      },
    },
    null,
    2,
  )
  return (
    <Layout title="MCP · Remote Browser" user={user} section="mcp">
      <div class="grid">
        <section class="box">
          <h2>접속 정보</h2>
          <label>MCP 주소</label>
          <div class="copy">
            <code id="mcp-url">{url}</code>
            <button type="button" onclick="rbCopy('mcp-url', this)">
              복사
            </button>
          </div>
          <label>토큰 (MCP_TOKEN)</label>
          {hasToken ? (
            <div class="copy">
              <code id="mcp-token">••••••••</code>
              <button type="button" onclick="rbToken(this)">
                보기
              </button>
              <button type="button" onclick="rbCopyToken(this)">
                복사
              </button>
            </div>
          ) : (
            <p class="muted">MCP_TOKEN이 설정되지 않았어요. 서버 환경 변수에 넣어 주세요.</p>
          )}
          {emails.length ? (
            <p class="muted">
              Cloudflare Access로 로그인한 {emails.join(", ")} 계정은 토큰 없이도 접속할 수 있어요.
            </p>
          ) : null}
          <p class="muted">
            Cloudflare Access가 앞에 있으면 서비스 토큰 헤더(CF-Access-Client-Id,
            CF-Access-Client-Secret)도 함께 보내야 해요.
          </p>
        </section>
        <section class="box">
          <h2>설정 복사</h2>
          <label>Claude Code (터미널)</label>
          <div class="copy">
            <pre id="mcp-add">{add}</pre>
            <button type="button" onclick="rbCopy('mcp-add', this)">
              복사
            </button>
          </div>
          <label>.mcp.json</label>
          <div class="copy">
            <pre id="mcp-json">{json}</pre>
            <button type="button" onclick="rbCopy('mcp-json', this)">
              복사
            </button>
          </div>
          <p class="muted">$MCP_TOKEN 자리에 토큰을 넣거나, 같은 이름의 환경 변수로 두고 쓰세요.</p>
        </section>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: `
async function rbCopyText(text, btn) {
  try { await navigator.clipboard.writeText(text); btn.textContent = "복사됨" }
  catch { btn.textContent = "복사 실패" }
  setTimeout(() => { btn.textContent = "복사" }, 1500)
}
function rbCopy(id, btn) { rbCopyText(document.getElementById(id).textContent, btn) }
async function rbFetchToken() {
  const res = await fetch("/mcp-setup/token", { method: "POST" })
  return res.ok ? (await res.json()).token : null
}
async function rbToken(btn) {
  const el = document.getElementById("mcp-token")
  if (btn.textContent === "숨기기") { el.textContent = "••••••••"; btn.textContent = "보기"; return }
  const t = await rbFetchToken(); if (!t) return
  el.textContent = t; btn.textContent = "숨기기"
}
async function rbCopyToken(btn) { const t = await rbFetchToken(); if (t) rbCopyText(t, btn) }
`,
        }}
      />
    </Layout>
  )
}
