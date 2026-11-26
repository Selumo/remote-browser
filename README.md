# remote-browser

로그인이 유지되는 원격 브라우저예요. AI는 MCP로 조작하고, 사람은 KasmVNC로 화면을 보면서 직접 로그인하거나 이어받을 수 있어요. 작업은 크론으로 예약 실행되고, 크롤링한 데이터는 대시보드에서 보거나 CSV로 받을 수 있어요. 대시보드에서 하는 일은 전부 MCP로도 할 수 있어요.

## 구성

- Hono(Node) + `hono/jsx` + htmx(SSE 확장) + Alpine.js
- PocketBase: 대시보드 로그인, 프로필, 작업, 실행 로그, 크롤링 데이터
- croner: 작업 크론 스케줄
- Playwright Chromium + KasmVNC
- 컨테이너 하나, Dokploy 배포, Cloudflare Tunnel + Access

## 로컬 실행 (컨테이너)

```bash
cp .env.example .env   # 값 채우기, COOKIE_SECURE=false
docker build -f docker/Dockerfile -t selumo-remote-browser:dev .
docker run --rm -p 3000:3000 --shm-size 2g --env-file .env -v rb-data:/data selumo-remote-browser:dev
```

`http://localhost:3000`에서 `ADMIN_EMAIL`로 로그인해요.

## 사용

1. **프로필:** 대시보드에서 프로필을 만들고 열면 아래 원격 화면에 브라우저가 떠요. 거기서 사이트에 직접 로그인하면, 그 프로필의 쿠키와 저장소가 `/data/profiles/<id>`에 남아요.
2. **작업과 크롤링:** JSON 단계로 작업을 만들어요. `extract` 단계가 행마다 데이터를 뽑아 PocketBase(`crawl_items`)에 저장해요. 크론 스케줄(`0 9 * * *` 등, 기본 시간대 `Asia/Seoul`)을 켜면 자동으로 돌아요. 실행 로그는 SSE로 실시간으로 보이고, 작업 화면에서 수집 데이터를 표로 보거나 CSV로 받을 수 있어요.
   ```json
   [
     {"action": "goto", "url": "https://news.ycombinator.com"},
     {"action": "extract", "selector": "tr.athing", "limit": 30,
      "fields": {"title": ".titleline > a", "url": {"selector": ".titleline > a", "attr": "href"}}}
   ]
   ```
   단계: `goto`, `click`, `fill`, `press`, `wait`, `waitFor`, `text`, `screenshot`(이미지 메뉴에 저장), `scroll`, `extract`
3. **문서:** 옵시디언처럼 마크다운 노트를 써요. `[[제목]]`으로 다른 노트를 링크하고(없는 제목은 누르면 새로 만들어요), `![[이미지 제목]]`으로 저장한 이미지를 넣고, `#태그`로 묶어요. 편집할 때 오른쪽에 미리보기가 바로 보이고, 노트마다 자기를 링크한 노트(백링크)가 나와요.
   - **사이트 플레이북:** 제목이 `플레이북: <사이트>`(예: `플레이북: instagram.com`)인 노트예요. 그 사이트에서 일하는 요령(누를 곳, 성공 표시, 함정, 선택자)을 적어 두면, AI가 그 사이트에 처음 들어갈 때 페이지 요약에 안내가 붙어 먼저 읽어요. 플레이북이 없으면 끝난 뒤 만들라는 안내가 붙어요. AI가 배운 것을 덧붙이니까 쓸수록 나아져요. 문서 메뉴의 "사이트 플레이북" 칸에 주소를 넣으면 열리거나 틀이 채워진 새 노트가 열리고, `#playbook` 태그로 모아 볼 수 있어요.
4. **데이터:** 작업별 수집 건수를 한눈에 보고, 작업을 골라 최근 데이터를 표로 보거나 CSV로 받아요. 원격 브라우저가 내려받은 파일과 내 PC에서 올린 파일도 여기서 받거나 지울 수 있어요.
5. **이미지:** 지금 원격 화면을 캡처하거나 파일을 올려서 저장해요. 작업의 `screenshot` 단계와 MCP `images`(capture)로 찍은 것도 여기 모여요.
6. **MCP 설정:** 상단 MCP 메뉴에 클라이언트별 안내가 있어요. Claude Code와 Claude Desktop은 한 줄 설치 명령(토큰을 물어보고 `~/.config/remote-browser`에만 저장), 클라우드 세션은 네트워크 시크릿 값과 넣을 파일, claude.ai 웹·폰은 커넥터 주소를 보여 줘요. "지금 확인"으로 연결과 도구 목록을 바로 확인할 수 있어요.
7. **MCP:** 주소가 두 개예요(같은 서버, Streamable HTTP).
   - `https://<호스트>/mcp`: `Authorization: Bearer <MCP_TOKEN>`. Claude Code, Desktop, 클라우드 세션, 기타 클라이언트용
   - `https://<호스트>/mcp-oauth`: Cloudflare Access(관리형 OAuth) 뒤에 두고, Access가 서명한 JWT를 앱이 검증해요. claude.ai 웹·폰 커넥터용. `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`를 넣어야 켜지고, `ALLOWED_EMAILS`를 넣으면 그 이메일만 받아요
   도구는 주제별로 18개로 묶여 있고, 각 도구는 `action` 인자로 세부 동작을 골라요. 도구 설명 전체가 약 4,500토큰이에요.

   | 도구 | 하는 일 |
   |---|---|
   | `browser` | status, open(프로필), close, goto, back, forward, reload, tabs, tab_new, tab_select, tab_close, ask_human, quality |
   | `snapshot` | 접근성 트리와 요소 ref (boxes로 좌표 포함) |
   | `screenshot` | 화면 PNG |
   | `extract` | 선택자와 필드로 DOM을 표로 읽기 |
   | `evaluate` | 페이지에서 JS 실행 (ref나 selector를 주면 그 요소가 `el`) |
   | `act` | click, dblclick, fill, type, press, select, check, uncheck, hover, focus, scroll, upload |
   | `wait` | selector, text, url, load 상태, ms |
   | `input` | 좌표 기반 마우스와 키보드: click, move, drag, wheel, type, key |
   | `page_log` | 콘솔, 페이지 오류, 실패한 요청, alert/confirm 기록과 처리 방식(수락/거절) |
   | `files` | 내려받은 파일과 사람이 올린 파일 list, read, delete (`act upload`로 페이지에 넣기) |
   | `bookmarks` | Chromium 북마크 list, add, update, delete, open |
   | `history` | 방문 기록 |
   | `profiles` | list, create, update, delete, cookies |
   | `jobs` / `runs` / `crawl_data` | 작업 관리와 실행, 실행 기록, 수집 데이터(items, csv) |
   | `docs` / `images` | 문서(사이트 플레이북 포함: `docs playbook`)와 이미지 |

8. **내 PC 파일 올리기:** 원격 페이지가 파일 선택창을 열면(인스타그램의 "컴퓨터에서 선택" 같은 버튼), 원격 컴퓨터의 파일 창 대신 대시보드에 "파일 선택" 배너가 떠요. 브라우저 화면 위의 **파일 올리기**로 내 PC의 파일을 고르면 그대로 페이지에 들어가요. 선택창이 없을 때 올린 파일은 보관만 되고, AI가 `act`의 upload로 `upload:<이름>`을 넣을 수 있어요. 파일 하나당 200MB까지예요(Cloudflare 무료 요금제는 요청 하나에 100MB까지라서 실제 한도는 그쪽이에요).
9. **사람에게 요청:** 로그인 페이지나 봇 확인을 만나면 AI는 `browser`의 `ask_human`(kind: login, captcha, input, confirm)으로 사람을 불러요. 작업도 로그인 페이지로 튕기거나 봇 확인을 만나면 멈춰서 기다려요(`CHALLENGE_WAIT_MINUTES`, 기본 10분).
   - 대시보드 브라우저 화면 위에 요청 배너가 뜨고, 탭 제목에 `(!)`가 붙고, 허용하면 데스크톱 알림도 와요.
   - 원격 화면에서 처리한 뒤 **완료**를 누르거나, 로그인 폼이나 봇 확인이 사라지면 자동으로 이어서 진행해요. **거절**하면 AI나 작업이 그 사실을 받아요.
   - `NOTIFY_URL`에 Discord나 Slack 웹훅, 또는 ntfy 주소를 넣으면 그쪽으로도 알려요.

내부 Chrome은 1920x1080으로 고정되고, 원격 화면은 KasmVNC가 창 크기에 맞춰 보여 줘요. 상태줄의 화질 선택(낮음·보통·높음·최고·무손실)은 KasmVNC 자체 프리셋이고, 바꾸면 화면을 다시 불러와요(시작값은 `VNC_QUALITY`=medium). AI가 받는 스크린샷과 스냅샷은 원본 해상도 그대로예요.

영어와 단축키는 원격 화면을 클릭한 뒤 그대로 치면 돼요. 한국어는 VNC로 칠 수 없어요(이유는 `docs/remote-view.md`). AI는 MCP의 `act`(fill, type)나 `input`(type)으로 한국어를 넣을 수 있어요.

브라우저는 한 번에 하나, 열린 프로필도 하나, 작업 실행도 한 번에 하나예요. MCP, 작업, 원격 화면이 같은 브라우저를 같이 써요. 예약 시각에 다른 작업이 돌고 있으면 그 회차는 건너뛰고 실패(skipped)로 기록돼요.

## 배포 (Dokploy)

Compose 서비스로 이 레포를 연결하고, Environment 탭에 `.env.example`의 값을 넣어요. `app` 서비스의 3000 포트에 도메인을 붙이고, 그 호스트 앞에 Cloudflare Access를 둬요. `/data` 볼륨에 PocketBase 데이터와 프로필이 저장돼요.

## 개발

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm lint && pnpm format
```
