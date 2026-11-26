import type { FC } from "hono/jsx"
import type { CookieStatus, DomainSummary } from "../browser/cookies.js"
import { STEP_HELP } from "../jobs/steps.js"
import type { CrawlItem, Job, JobRun, Profile } from "../pb.js"
import type { JobWithProfile } from "../services.js"
import { Layout } from "./layout.js"

const TZ = process.env.SCHEDULE_TZ || "Asia/Seoul"
const clock = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})

/** PocketBase ("2026-11-26 13:16:29.123Z") or ISO timestamps, shown in the schedule time zone. */
const fmt = (iso: string | null | undefined) => {
  if (!iso) return "-"
  const d = new Date(iso.replace(" ", "T"))
  return Number.isNaN(d.getTime()) ? iso : clock.format(d)
}

export const LoginPage: FC<{ error?: string }> = ({ error }) => (
  <Layout title="로그인 · Remote Browser">
    <div class="box" style="max-width:360px;margin:10vh auto">
      <h2>Remote Browser</h2>
      <form method="post" action="/login">
        <label for="email">이메일</label>
        <input id="email" name="email" type="email" autocomplete="username" required />
        <label for="password">비밀번호</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
        />
        {error ? <p class="error">{error}</p> : null}
        <p>
          <button class="primary" type="submit">
            로그인
          </button>
        </p>
      </form>
    </div>
  </Layout>
)

// ---------- browser ----------

/** Polled by htmx so the header follows what the AI and the jobs are doing. Text only: the
 * controls next to it live outside the polled element so their state is not reset. */
export const BrowserStatus: FC<{
  profile: Profile | null
  url: string | null
  running: string | null
}> = ({ profile, url, running }) => (
  <span
    id="browser-status"
    class="row status"
    hx-get="/partials/status"
    hx-trigger="every 5s"
    hx-swap="outerHTML"
  >
    {profile ? (
      <>
        <span class="tag on">OPEN</span> <strong>{profile.name}</strong>
        <span class="muted url" title={url ?? ""}>
          {url}
        </span>
      </>
    ) : (
      <span class="muted">
        열린 프로필 없음. 왼쪽에서 프로필을 열면 아래 화면에 브라우저가 떠요.
      </span>
    )}
    {running ? (
      <a class="tag on" href={`/runs/${running}`}>
        RUNNING {running}
      </a>
    ) : null}
  </span>
)

/**
 * Viewer controls on the status bar: stream resolution (server side, x11vnc), view only and
 * text insertion (handed to the viewer frame through window.viewer), fullscreen and close.
 */
export const BrowserControls: FC<{ resolution: number; resolutions: readonly number[] }> = ({
  resolution,
  resolutions,
}) => (
  <span class="row controls" x-data="{ text: false }">
    <select
      id="vnc-res"
      title="보이는 화면의 해상도 (브라우저는 원본 그대로)"
      onchange="rbSetResolution(this)"
    >
      {resolutions.map((h, i) => (
        <option value={String(h)} selected={h === resolution}>
          {h}p{i === 0 ? " 원본" : ""}
        </option>
      ))}
    </select>
    <label class="row" style="margin:0">
      <input type="checkbox" id="vnc-viewonly" onchange="rbSetViewOnly(this.checked)" /> 보기 전용
    </label>
    <button type="button" x-on:click="text = !text" x-text="text ? '텍스트 닫기' : '텍스트 보내기'">
      텍스트 보내기
    </button>
    <button
      type="button"
      onclick="document.querySelector('iframe.vnc')?.requestFullscreen()"
      title="Esc로 나가기"
    >
      전체화면
    </button>
    <button hx-post="/browser/close" hx-target="#browser-status" hx-swap="outerHTML">
      닫기
    </button>
    <span x-show="text" class="row" style="flex-basis:100%">
      <input
        id="vnc-text"
        placeholder="원격 화면의 입력칸을 클릭한 뒤 입력. 한글 가능"
        style="flex:1"
        onkeydown="if(event.key==='Enter' && !event.isComposing && event.keyCode!==229){event.preventDefault(); rbSendText()}"
      />
      <button type="button" class="primary" onclick="rbSendText()">
        넣기
      </button>
      <span id="vnc-msg" class="muted" />
    </span>
  </span>
)

const controlsScript = `
const rbFrame = () => document.querySelector("iframe.vnc")?.contentWindow?.viewer
function rbMsg(t) { const m = document.getElementById("vnc-msg"); if (m) { m.textContent = t; setTimeout(() => { if (m.textContent === t) m.textContent = "" }, 2000) } }
async function rbSetResolution(sel) {
  const prev = sel.dataset.prev || sel.value
  const res = await fetch("/viewer/resolution", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ height: Number(sel.value) }) }).catch(() => null)
  if (res && res.ok) { sel.dataset.prev = sel.value; rbFrame()?.setResolution(Number(sel.value)) }
  else { sel.value = prev; alert("해상도를 바꾸지 못했어요") }
}
function rbSetViewOnly(on) { try { localStorage.setItem("viewer.viewOnly", String(on)) } catch {} ; rbFrame()?.setViewOnly(on) }
async function rbSendText() {
  const input = document.getElementById("vnc-text"); const text = input.value
  if (!text) return
  const res = await fetch("/browser/insert-text", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).catch(() => null)
  const data = res ? await res.json().catch(() => ({})) : {}
  if (res && res.ok) { input.value = ""; rbMsg("넣었어요") } else rbMsg("실패: " + (data.error || "연결 오류"))
}
document.addEventListener("DOMContentLoaded", () => {
  const sel = document.getElementById("vnc-res"); if (sel) sel.dataset.prev = sel.value
  try { document.getElementById("vnc-viewonly").checked = localStorage.getItem("viewer.viewOnly") === "true" } catch {}
})
`

export const ProfileList: FC<{ profiles: Profile[]; openId: string | null }> = ({
  profiles,
  openId,
}) => (
  <table id="profile-list">
    <tbody>
      {profiles.length === 0 ? (
        <tr>
          <td class="muted">프로필 없음</td>
        </tr>
      ) : null}
      {profiles.map((p) => (
        <tr>
          <td class="wrap">
            <strong>{p.name}</strong> {p.id === openId ? <span class="tag on">OPEN</span> : null}
            <br />
            <span class="muted">{p.start_url}</span>
          </td>
          <td style="white-space:nowrap">
            <button
              hx-post={`/profiles/${p.id}/open`}
              hx-target="#browser-status"
              hx-swap="outerHTML"
            >
              열기
            </button>{" "}
            <button
              hx-delete={`/profiles/${p.id}`}
              hx-target="#profile-list"
              hx-swap="outerHTML"
              hx-confirm={`"${p.name}" 프로필과 그 작업을 삭제할까요?`}
            >
              삭제
            </button>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
)

export const BrowserPage: FC<{
  user: string
  profiles: Profile[]
  openProfile: Profile | null
  url: string | null
  running: string | null
  screen: { width: number; height: number }
  resolution: number
  resolutions: readonly number[]
}> = ({ user, profiles, openProfile, url, running, screen, resolution, resolutions }) => (
  <Layout title="브라우저 · Remote Browser" user={user} section="browser" fill>
    <div class="grid">
      <section class="box">
        <h2>프로필</h2>
        <p class="muted">프로필마다 쿠키와 로그인이 따로 저장돼요. 한 번에 하나만 열려요.</p>
        <ProfileList profiles={profiles} openId={openProfile?.id ?? null} />
        <div x-data="{ open: false }">
          <p>
            <button x-on:click="open = !open" x-text="open ? '닫기' : '+ 새 프로필'">
              + 새 프로필
            </button>
          </p>
          <form
            x-show="open"
            hx-post="/profiles"
            hx-target="#profile-list"
            hx-swap="outerHTML"
            hx-on--after-request="if (event.detail.successful) this.reset()"
          >
            <label>이름</label>
            <input name="name" required maxlength={100} placeholder="naver-main" />
            <label>시작 URL (선택)</label>
            <input name="start_url" type="url" placeholder="https://" />
            <label>메모 (선택)</label>
            <input name="notes" maxlength={2000} />
            <p>
              <button class="primary" type="submit">
                만들기
              </button>
            </p>
          </form>
        </div>
      </section>
      <section class="box screen">
        <h2>원격 브라우저</h2>
        <div class="row toolbar">
          <BrowserStatus profile={openProfile} url={url} running={running} />
          <BrowserControls resolution={resolution} resolutions={resolutions} />
        </div>
        <script dangerouslySetInnerHTML={{ __html: controlsScript }} />
        <div class="vnc-wrap" style={`--sw:${screen.width};--sh:${screen.height}`}>
          <iframe
            class="vnc"
            src="/viewer"
            title="원격 브라우저 화면"
            allow="fullscreen; clipboard-read; clipboard-write"
          />
        </div>
      </section>
    </div>
  </Layout>
)

// ---------- jobs ----------

export const StatusTag: FC<{ status: string }> = ({ status }) => (
  <span class={`tag ${status === "running" ? "on" : ""}`}>{status.toUpperCase()}</span>
)

/**
 * Polls while the run is running. The response that sees it finished carries an HX-Trigger
 * (`run-finished`) so the data table refreshes itself.
 */
export const RunStatus: FC<{ run: JobRun }> = ({ run }) =>
  run.status === "running" ? (
    <span hx-get={`/runs/${run.id}/status`} hx-trigger="every 2s" hx-swap="outerHTML">
      <StatusTag status={run.status} />
    </span>
  ) : (
    <span>
      <StatusTag status={run.status} /> {run.items ?? 0}건
    </span>
  )

export const RunPanel: FC<{ run: JobRun | null; error?: string }> = ({ run, error }) => (
  <section id="run-panel" class="box">
    <h2>실행 로그</h2>
    {error ? <p class="error">{error}</p> : null}
    {run ? (
      <>
        <p class="row">
          <RunStatus run={run} /> <span>{run.id}</span>
          <span class="muted">
            {run.trigger || "manual"} · {fmt(run.started)}
          </span>
        </p>
        <div hx-ext="sse" sse-connect={`/runs/${run.id}/stream`} sse-close="end">
          <ul class="log" sse-swap="log" hx-swap="beforeend" />
        </div>
      </>
    ) : !error ? (
      <p class="muted">실행하면 여기에 로그가 실시간으로 나와요.</p>
    ) : null}
  </section>
)

const JobForm: FC<{ job?: Job; profiles: Profile[] }> = ({ job, profiles }) => (
  <form method="post" action={job ? `/jobs/${job.id}` : "/jobs"}>
    <label>이름</label>
    <input name="name" required maxlength={100} value={job?.name ?? ""} />
    <label>프로필</label>
    <select name="profile" required>
      {profiles.map((p) => (
        <option value={p.id} selected={job?.profile === p.id}>
          {p.name}
        </option>
      ))}
    </select>
    <label>크론 스케줄 (비우면 수동 실행만)</label>
    <input name="schedule" value={job?.schedule ?? ""} placeholder="0 9 * * *  (매일 09:00)" />
    <label class="row">
      <input type="checkbox" name="enabled" value="1" checked={job?.enabled ?? false} /> 스케줄 켜기
    </label>
    <label>단계 (JSON)</label>
    <textarea name="steps" required>
      {job ? JSON.stringify(job.steps, null, 2) : STEP_HELP}
    </textarea>
    <p class="muted">
      goto · click · fill · press · wait · waitFor · text · screenshot · scroll · extract
    </p>
    <p>
      <button class="primary" type="submit">
        {job ? "저장" : "만들기"}
      </button>
    </p>
  </form>
)

export const JobsPage: FC<{
  user: string
  jobs: (JobWithProfile & { nextRun: string | null })[]
  profiles: Profile[]
  runs: (JobRun & { jobName: string })[]
  error?: string | undefined
}> = ({ user, jobs, profiles, runs, error }) => (
  <Layout title="작업 · Remote Browser" user={user} section="jobs">
    <div class="grid">
      <section class="box">
        <h2>새 작업</h2>
        {error ? <p class="error">{error}</p> : null}
        {profiles.length === 0 ? (
          <p class="muted">먼저 프로필을 만들어 주세요.</p>
        ) : (
          <JobForm profiles={profiles} />
        )}
      </section>
      <div style="display:grid;gap:16px;min-width:0">
        <section class="box">
          <h2>작업</h2>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>이름</th>
                  <th>프로필</th>
                  <th>스케줄</th>
                  <th>다음 실행</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobs.length === 0 ? (
                  <tr>
                    <td colspan={5} class="muted">
                      작업 없음
                    </td>
                  </tr>
                ) : null}
                {jobs.map((j) => (
                  <tr>
                    <td>
                      <a href={`/jobs/${j.id}`}>{j.name}</a>
                    </td>
                    <td>{j.profileName}</td>
                    <td>
                      {j.schedule ? (
                        <>
                          <span class={`tag ${j.enabled ? "on" : ""}`}>
                            {j.enabled ? "ON" : "OFF"}
                          </span>{" "}
                          {j.schedule}
                        </>
                      ) : (
                        <span class="muted">수동</span>
                      )}
                    </td>
                    <td>{fmt(j.nextRun)}</td>
                    <td style="white-space:nowrap">
                      <button
                        hx-post={`/jobs/${j.id}/run`}
                        hx-target="#run-panel"
                        hx-swap="outerHTML"
                      >
                        실행
                      </button>{" "}
                      <a class="btn" href={`/jobs/${j.id}/items.csv`}>
                        CSV
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <RunPanel run={null} />
        <RunsTable runs={runs} showJob />
      </div>
    </div>
  </Layout>
)

export const RunsTable: FC<{ runs: (JobRun & { jobName?: string })[]; showJob?: boolean }> = ({
  runs,
  showJob,
}) => (
  <section class="box">
    <h2>최근 실행</h2>
    <div class="scroll">
      <table>
        <thead>
          <tr>
            {showJob ? <th>작업</th> : null}
            <th>상태</th>
            <th>트리거</th>
            <th>시작</th>
            <th>수집</th>
            <th>오류</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 ? (
            <tr>
              <td colspan={7} class="muted">
                실행 기록 없음
              </td>
            </tr>
          ) : null}
          {runs.map((r) => (
            <tr>
              {showJob ? (
                <td>
                  <a href={`/jobs/${r.job}`}>{r.jobName}</a>
                </td>
              ) : null}
              <td>
                <StatusTag status={r.status} />
              </td>
              <td>{r.trigger || "manual"}</td>
              <td>{fmt(r.started)}</td>
              <td>{r.items ?? 0}</td>
              <td class="wrap">{r.error}</td>
              <td style="white-space:nowrap">
                <button hx-get={`/runs/${r.id}/panel`} hx-target="#run-panel" hx-swap="outerHTML">
                  로그
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
)

export const ItemsTable: FC<{
  jobId: string
  items: CrawlItem[]
  total: number
  columns: string[]
  runId?: string | undefined
}> = ({ jobId, items, total, columns, runId }) => (
  <section
    class="box"
    id="items"
    hx-get={`/jobs/${jobId}/items${runId ? `?run=${runId}` : ""}`}
    hx-trigger="run-finished from:body"
    hx-swap="outerHTML"
  >
    <h2>수집 데이터</h2>
    <p class="row">
      <span>
        {runId ? `실행 ${runId}의 ` : "전체 "}
        {total}건 중 최근 {items.length}건
      </span>
      <a class="btn" href={`/jobs/${jobId}/items.csv${runId ? `?run=${runId}` : ""}`}>
        CSV 다운로드
      </a>
      {runId ? (
        <a class="btn" href={`/jobs/${jobId}`}>
          전체 보기
        </a>
      ) : null}
    </p>
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>수집 시각</th>
            {columns.map((c) => (
              <th>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colspan={columns.length + 1} class="muted">
                데이터 없음. 단계에 extract를 넣어 실행해 보세요.
              </td>
            </tr>
          ) : null}
          {items.map((i) => (
            <tr>
              <td style="white-space:nowrap">{fmt(i.created)}</td>
              {columns.map((c) => {
                const v = i.data?.[c]
                const s =
                  v === null || v === undefined
                    ? ""
                    : typeof v === "object"
                      ? JSON.stringify(v)
                      : String(v)
                return (
                  <td class="wrap">
                    {/^https?:\/\//.test(s) ? (
                      <a href={s} target="_blank" rel="noreferrer noopener">
                        {s}
                      </a>
                    ) : (
                      s
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
)

export const JobDetailPage: FC<{
  user: string
  job: Job
  profiles: Profile[]
  nextRun: string | null
  runs: JobRun[]
  items: CrawlItem[]
  total: number
  columns: string[]
  runId?: string | undefined
  panelRun?: JobRun | null | undefined
  error?: string | undefined
}> = (p) => (
  <Layout title={`${p.job.name} · Remote Browser`} user={p.user} section="jobs">
    <div class="grid">
      <section class="box">
        <h2>작업 설정</h2>
        {p.error ? <p class="error">{p.error}</p> : null}
        <p class="row">
          <button
            class="primary"
            hx-post={`/jobs/${p.job.id}/run`}
            hx-target="#run-panel"
            hx-swap="outerHTML"
          >
            지금 실행
          </button>
          <span class="muted">다음 실행: {fmt(p.nextRun)}</span>
        </p>
        <JobForm job={p.job} profiles={p.profiles} />
        <form
          method="post"
          action={`/jobs/${p.job.id}/delete`}
          onsubmit="return confirm('이 작업과 실행 기록, 수집 데이터를 삭제할까요?')"
        >
          <p>
            <button type="submit">작업 삭제</button>
          </p>
        </form>
      </section>
      <div style="display:grid;gap:16px;min-width:0">
        <RunPanel run={p.panelRun ?? null} />
        <ItemsTable
          jobId={p.job.id}
          items={p.items}
          total={p.total}
          columns={p.columns}
          runId={p.runId}
        />
        <RunsTable runs={p.runs} />
      </div>
    </div>
  </Layout>
)

// ---------- profiles ----------

const STATUS_LABEL: Record<CookieStatus, string> = {
  valid: "유효",
  expiring: "곧 만료",
  expired: "만료",
  session: "세션",
}

const fmtUnix = (sec: number | null) =>
  sec === null ? "-" : fmt(new Date(sec * 1000).toISOString())

export const ProfilesPage: FC<{
  user: string
  profiles: Profile[]
  openId: string | null
  selected: Profile | null
  source: "live" | "disk" | null
  summary: DomainSummary[]
}> = ({ user, profiles, openId, selected, source, summary }) => (
  <Layout title="프로필 · Remote Browser" user={user} section="profiles">
    <div class="grid">
      <section class="box">
        <h2>프로필</h2>
        <table>
          <tbody>
            {profiles.length === 0 ? (
              <tr>
                <td class="muted">프로필 없음</td>
              </tr>
            ) : null}
            {profiles.map((p) => (
              <tr>
                <td class="wrap" style={p.id === selected?.id ? "background:#000;color:#fff" : ""}>
                  <a
                    href={`/profiles?id=${p.id}`}
                    style={p.id === selected?.id ? "color:#fff" : ""}
                  >
                    <strong>{p.name}</strong>
                  </a>{" "}
                  {p.id === openId ? <span class="tag on">OPEN</span> : null}
                  <br />
                  <span class={p.id === selected?.id ? "" : "muted"}>{p.start_url}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2 style="margin-top:16px">새 프로필</h2>
        <form method="post" action="/profiles/new">
          <label>이름</label>
          <input name="name" required maxlength={100} placeholder="naver-main" />
          <label>시작 URL (선택)</label>
          <input name="start_url" type="url" placeholder="https://" />
          <label>메모 (선택)</label>
          <input name="notes" maxlength={2000} />
          <p>
            <button class="primary" type="submit">
              만들기
            </button>
          </p>
        </form>
      </section>
      <section class="box">
        <h2>저장된 로그인</h2>
        {!selected ? (
          <p class="muted">왼쪽에서 프로필을 고르세요.</p>
        ) : (
          <>
            <p class="row">
              <strong>{selected.name}</strong>
              <span class="muted">
                {source === "live"
                  ? "열린 브라우저에서 실시간으로 읽음"
                  : "저장된 쿠키 파일에서 읽음"}{" "}
                · 쿠키 값은 표시하지 않아요
              </span>
              <button hx-post={`/profiles/${selected.id}/open`} hx-swap="none">
                브라우저에서 열기
              </button>
            </p>
            {selected.notes ? <p class="muted">{selected.notes}</p> : null}
            {summary.length === 0 ? (
              <p class="muted">
                저장된 쿠키가 없어요. 브라우저에서 열고 사이트에 로그인하면 여기에 나와요.
              </p>
            ) : (
              <div class="scroll" style="max-height:none">
                <details class="dom" open={false}>
                  <summary class="head">
                    <span>사이트</span>
                    <span>상태</span>
                    <span>로그인</span>
                    <span>전체</span>
                    <span>만료됨</span>
                    <span>가장 늦은 만료</span>
                  </summary>
                </details>
                {summary.map((g) => (
                  <details class="dom">
                    <summary>
                      <span class="wrap">{g.domain}</span>
                      <span>
                        <span class={`tag ${g.status === "valid" ? "on" : ""}`}>
                          {STATUS_LABEL[g.status]}
                        </span>
                      </span>
                      <span>{g.login}</span>
                      <span>{g.total}</span>
                      <span>{g.expired}</span>
                      <span>{fmtUnix(g.latestExpiry)}</span>
                    </summary>
                    <table>
                      <thead>
                        <tr>
                          <th>쿠키</th>
                          <th>상태</th>
                          <th>만료</th>
                          <th>속성</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.cookies.map((c) => (
                          <tr>
                            <td class="wrap">
                              {c.loginLike ? <strong>{c.name}</strong> : c.name}
                              {c.domain !== g.domain ? (
                                <span class="muted"> ({c.domain})</span>
                              ) : null}
                            </td>
                            <td>{STATUS_LABEL[c.status]}</td>
                            <td>{fmtUnix(c.expires)}</td>
                            <td class="muted">
                              {[c.httpOnly ? "HttpOnly" : "", c.secure ? "Secure" : ""]
                                .filter(Boolean)
                                .join(" ")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                ))}
              </div>
            )}
            <p class="muted">
              로그인 쿠키는 이름(session, auth, token, NID_AUT 등)으로 추정해요. 사이트마다 실제
              로그인 유지 여부는 다를 수 있어요. 일부 사이트는 쿠키 대신 localStorage에 토큰을
              두는데, 그건 여기 나오지 않아요.
            </p>
          </>
        )}
      </section>
    </div>
  </Layout>
)
