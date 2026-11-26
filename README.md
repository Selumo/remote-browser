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
4. **데이터:** 작업별 수집 건수를 한눈에 보고, 작업을 골라 최근 데이터를 표로 보거나 CSV로 받아요.
5. **이미지:** 지금 원격 화면을 캡처하거나 파일을 올려서 저장해요. 작업의 `screenshot` 단계와 MCP `image_capture`로 찍은 것도 여기 모여요.
6. **MCP 설정:** 상단 MCP 메뉴에서 주소, 토큰(누를 때만 보여요), `claude mcp add` 명령, `.mcp.json`을 복사할 수 있어요.
7. **MCP:** `https://<호스트>/mcp` (Streamable HTTP). `Authorization: Bearer <MCP_TOKEN>`이나 Cloudflare Access 인증으로 붙어요.
   - 브라우저: `browser_status`, `profile_open`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_press`, `browser_wait_for`, `browser_screenshot`, `browser_tabs`, `browser_select_tab`, `browser_close`
   - 가상 마우스·키보드: `mouse_click`, `mouse_move`, `mouse_drag`, `mouse_wheel`, `keyboard_type` (좌표는 `browser_screenshot` 기준)
   - 프로필: `profiles_list`, `profile_create`, `profile_delete`
   - 작업·스케줄: `jobs_list`, `job_get`, `job_create`, `job_update`, `job_delete`, `job_run`, `runs_list`, `run_get`
   - 데이터: `crawl_items`, `crawl_csv`
   - 문서: `docs_list`, `doc_read`, `doc_write`, `doc_append`, `doc_delete`
   - 이미지: `image_capture`, `images_list`, `image_get`, `image_delete`
   - 화면: `viewer_quality`, `browser_wait_for_human`

내부 Chrome은 1920x1080으로 고정되고, 원격 화면은 KasmVNC가 창 크기에 맞춰 보여 줘요. 상태줄의 화질 선택(낮음·보통·높음·최고·무손실)은 KasmVNC 자체 프리셋이고, 바꾸면 화면을 다시 불러와요(시작값은 `VNC_QUALITY`=medium). AI가 받는 스크린샷과 스냅샷은 원본 해상도 그대로예요.

영어와 단축키는 원격 화면을 클릭한 뒤 그대로 치면 돼요. 한국어는 VNC로 칠 수 없어요(이유는 `docs/remote-view.md`). AI는 MCP의 `browser_fill`, `keyboard_type`으로 한국어를 넣을 수 있어요.

브라우저는 한 번에 하나, 열린 프로필도 하나, 작업 실행도 한 번에 하나예요. MCP, 작업, 원격 화면이 같은 브라우저를 같이 써요. 예약 시각에 다른 작업이 돌고 있으면 그 회차는 건너뛰고 실패(skipped)로 기록돼요.

## 배포 (Dokploy)

Compose 서비스로 이 레포를 연결하고, Environment 탭에 `.env.example`의 값을 넣어요. `app` 서비스의 3000 포트에 도메인을 붙이고, 그 호스트 앞에 Cloudflare Access를 둬요. `/data` 볼륨에 PocketBase 데이터와 프로필이 저장돼요.

## 개발

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm lint && pnpm format
```
