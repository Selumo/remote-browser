#!/usr/bin/env bash
# Starts every process of the container and exits as soon as any of them exits, so the container
# restart policy brings the whole set back together.
set -euo pipefail

: "${PB_SUPERUSER_EMAIL:?PB_SUPERUSER_EMAIL is required}"
: "${PB_SUPERUSER_PASSWORD:?PB_SUPERUSER_PASSWORD is required}"

DATA_DIR="${DATA_DIR:-/data}"
DISPLAY="${DISPLAY:-:99}"
SCREEN="${SCREEN:-1600x900x24}"
MIGRATIONS=/app/pocketbase/remote-browser/pb_migrations
export DISPLAY

mkdir -p "$DATA_DIR/pb_data" "$DATA_DIR/profiles" "$DATA_DIR/screenshots"
# Chromium leaves a lock per profile when the container is killed; stale locks block the next start.
find "$DATA_DIR/profiles" -maxdepth 2 -name 'Singleton*' -delete 2>/dev/null || true
rm -f "/tmp/.X${DISPLAY#:}-lock"

pocketbase superuser upsert "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" \
  --dir "$DATA_DIR/pb_data" --migrationsDir "$MIGRATIONS" >/dev/null

pocketbase serve --http 127.0.0.1:8090 --dir "$DATA_DIR/pb_data" --migrationsDir "$MIGRATIONS" \
  --automigrate=false &

Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp &
for _ in $(seq 1 50); do
  [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
  sleep 0.1
done

fluxbox >/dev/null 2>&1 &
x11vnc -display "$DISPLAY" -localhost -rfbport 5900 -forever -shared -nopw -quiet -xkb &
websockify 127.0.0.1:6080 127.0.0.1:5900 >/dev/null 2>&1 &

node /app/apps/selumo-remote-browser/dist/index.js &

wait -n
exit $?
