/**
 * One-line installers shown on the dashboard's MCP page. They hold no secrets (only this server's
 * address), so they are served without login; the token is typed in by the person when the
 * script asks for it and kept in ~/.config/remote-browser/mcp-token (mode 600).
 */
const TOKEN_STEP = `DIR="$HOME/.config/remote-browser"
mkdir -p "$DIR" && chmod 700 "$DIR"
if [ ! -s "$DIR/mcp-token" ] || [ "\${1:-}" = "--new-token" ]; then
  printf 'MCP_TOKEN (대시보드 MCP 메뉴에서 복사해 붙여 넣기, 화면에 안 보여요): '
  read -rs t </dev/tty; echo
  [ -n "$t" ] || { echo "토큰이 비어 있어요"; exit 1; }
  printf '%s' "$t" > "$DIR/mcp-token" && chmod 600 "$DIR/mcp-token"; unset t
fi
`

export function claudeCodeScript(origin: string): string {
  return `#!/usr/bin/env bash
# remote-browser MCP -> Claude Code (user scope). Re-run with --new-token to replace the token.
set -euo pipefail
command -v claude >/dev/null || { echo "claude 명령이 없어요. Claude Code를 먼저 설치하세요."; exit 1; }
${TOKEN_STEP}
cat > "$DIR/headers.sh" <<'EOS'
#!/bin/sh
set -e
token=$(tr -d '\\r\\n' < "$HOME/.config/remote-browser/mcp-token")
printf '{"Authorization":"Bearer %s"}\\n' "$token"
EOS
chmod 700 "$DIR/headers.sh"
claude mcp remove remote-browser -s user >/dev/null 2>&1 || true
claude mcp add-json -s user remote-browser "{\\"type\\":\\"http\\",\\"url\\":\\"${origin}/mcp\\",\\"headersHelper\\":\\"$DIR/headers.sh\\"}"
claude mcp get remote-browser
echo "끝났어요. 새로 시작한 Claude Code 대화부터 remote-browser 도구를 쓸 수 있어요."
`
}

export function claudeDesktopScript(origin: string): string {
  return `#!/usr/bin/env bash
# remote-browser MCP -> Claude Desktop (macOS, Linux) through mcp-remote. Re-run with --new-token.
set -euo pipefail
NODE="$(command -v node || true)"
[ -n "$NODE" ] && command -v npx >/dev/null || { echo "Node.js(npx)가 없어요. 먼저 설치하세요."; exit 1; }
# Version managers (fnm, nvm) put node in per-shell temp dirs; keep the real install folder,
# which also holds npx.
NODE_DIR="$(dirname "$(readlink -f "$NODE" 2>/dev/null || echo "$NODE")")"
${TOKEN_STEP}
cat > "$DIR/desktop-bridge.sh" <<EOS
#!/bin/sh
# Claude Desktop starts this; it adds the token header and relays to the remote server.
set -e
export PATH="$NODE_DIR:\\$PATH"
token=\\$(tr -d '\\r\\n' < "\\$HOME/.config/remote-browser/mcp-token")
exec npx -y mcp-remote@latest ${origin}/mcp --transport http-only --header "Authorization:Bearer \\$token"
EOS
chmod 700 "$DIR/desktop-bridge.sh"
case "$(uname)" in
  Darwin) CONF="$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
  *) CONF="\${XDG_CONFIG_HOME:-$HOME/.config}/Claude/claude_desktop_config.json" ;;
esac
mkdir -p "$(dirname "$CONF")"
[ -f "$CONF" ] && cp "$CONF" "$CONF.bak-$(date +%Y%m%d%H%M%S)"
CONF="$CONF" BRIDGE="$DIR/desktop-bridge.sh" node -e '
const fs = require("fs"); const p = process.env.CONF
let c = {}; try { c = JSON.parse(fs.readFileSync(p, "utf8")) } catch {}
c.mcpServers = c.mcpServers || {}
c.mcpServers["remote-browser"] = { command: process.env.BRIDGE }
fs.writeFileSync(p, JSON.stringify(c, null, 2))'
echo "등록했어요: $CONF"
echo "Claude Desktop을 완전히 종료했다가 다시 열면 remote-browser가 보여요."
`
}
