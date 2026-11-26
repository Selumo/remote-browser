#!/usr/bin/env bash
# Starts every process of the container and exits as soon as any of them exits, so the container
# restart policy brings the whole set back together.
set -euo pipefail

: "${PB_SUPERUSER_EMAIL:?PB_SUPERUSER_EMAIL is required}"
: "${PB_SUPERUSER_PASSWORD:?PB_SUPERUSER_PASSWORD is required}"

DATA_DIR="${DATA_DIR:-/data}"
DISPLAY="${DISPLAY:-:99}"
# The browser always renders at this size; the viewer only scales and compresses what it sends.
SCREEN_SIZE="${SCREEN_WIDTH:-1920}x${SCREEN_HEIGHT:-1080}"
MIGRATIONS=/app/pocketbase/remote-browser/pb_migrations
export DISPLAY

mkdir -p "$DATA_DIR/pb_data" "$DATA_DIR/profiles"
# Chromium leaves a lock per profile when the container is killed; stale locks block the next start.
find "$DATA_DIR/profiles" -maxdepth 2 -name 'Singleton*' -delete 2>/dev/null || true
rm -f "/tmp/.X${DISPLAY#:}-lock"

pocketbase superuser upsert "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" \
  --dir "$DATA_DIR/pb_data" --migrationsDir "$MIGRATIONS" >/dev/null

pocketbase serve --http 127.0.0.1:8090 --dir "$DATA_DIR/pb_data" --migrationsDir "$MIGRATIONS" \
  --automigrate=false &

# KasmVNC is the X server and serves VNC over WebSocket on 127.0.0.1:6080 (the app proxies it,
# after its own login). No VNC auth or TLS of its own: nothing outside the container reaches it.
# The viewer's stream presets set these per connection; KasmVNC ignores them unless allowed.
KASM_OVERRIDE=desktop,AcceptPointerEvents,SendCutText,AcceptCutText,SendPrimary,SetPrimary
KASM_OVERRIDE="$KASM_OVERRIDE,MaxVideoResolution,VideoTime,VideoArea,VideoOutTime,VideoScaling"
KASM_OVERRIDE="$KASM_OVERRIDE,DynamicQualityMin,DynamicQualityMax,TreatLossless,JpegVideoQuality"
KASM_OVERRIDE="$KASM_OVERRIDE,WebpVideoQuality,FrameRate"
Xkasmvnc "$DISPLAY" -geometry "$SCREEN_SIZE" -depth 24 -nolisten tcp \
  -interface 127.0.0.1 -websocketPort 6080 -rfbport 0 \
  -DisableBasicAuth 1 -SecurityTypes None -sslOnly 0 \
  -FrameRate "${VNC_FRAME_RATE:-24}" -Log '*:stderr:0' \
  -AllowOverride "$KASM_OVERRIDE" &
for _ in $(seq 1 50); do
  [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
  sleep 0.1
done

# No fluxbox toolbar, so the maximized Chromium window covers the whole screen.
mkdir -p "$HOME/.fluxbox"
printf 'session.screen0.toolbar.visible: false\n' > "$HOME/.fluxbox/init"
fluxbox >/dev/null 2>&1 &

node /app/apps/selumo-remote-browser/dist/index.js &

wait -n
exit $?
