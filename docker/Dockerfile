# One container: PocketBase + Xvfb desktop + x11vnc/websockify (noVNC) + the Hono app driving
# Playwright Chromium. Only the app port (3000) is exposed; PocketBase and VNC stay on 127.0.0.1.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

ARG PB_VERSION=0.40.6
ARG NOVNC_VERSION=1.7.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tini xvfb x11vnc fluxbox websockify unzip curl ca-certificates fonts-noto-cjk fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

RUN arch="$(dpkg --print-architecture)" \
  && curl -fsSL -o /tmp/pb.zip \
    "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${arch}.zip" \
  && unzip -q /tmp/pb.zip pocketbase -d /usr/local/bin \
  && rm /tmp/pb.zip \
  && curl -fsSL "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" | tar xz -C /opt \
  && mv "/opt/noVNC-${NOVNC_VERSION}" /opt/novnc

# Node 26 in this base image ships without corepack
RUN npm install -g pnpm@12.4.2

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/selumo-remote-browser/package.json apps/selumo-remote-browser/
RUN pnpm install --frozen-lockfile

COPY apps apps
COPY pocketbase pocketbase
RUN pnpm --filter @selumo/remote-browser build

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
  && mkdir -p /data \
  && chown -R pwuser:pwuser /data

ENV NODE_ENV=production \
    DATA_DIR=/data \
    DISPLAY=:99 \
    NOVNC_DIR=/opt/novnc \
    PORT=3000

USER pwuser
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

# -g forwards SIGTERM to every process, so Chromium closes cleanly and profiles are not corrupted
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
