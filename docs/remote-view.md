# Remote view (KasmVNC) notes

Findings from 2026-11-26/27 while replacing Xvfb + x11vnc + noVNC with KasmVNC. Keep them in mind
before changing the viewer again.

## Setup that works

- `Xkasmvnc` is both the X server and the VNC server. It listens on 127.0.0.1:6080 with no VNC
  auth and no TLS; the app checks the dashboard session and proxies `/kasm/websockify` to it.
- The dashboard frame loads Kasm's stock web client (`/usr/share/kasmvnc/www/vnc.html`) through
  `/viewer`, which redirects to `/kasm/vnc.html?v=<build>#<settings>`. Kasm reads its settings from
  the URL hash. The page is served with `Cache-Control: no-store` and a per-build `?v=`, and the
  WebSocket path carries the same build id; an old page that reconnects after a restart is refused
  with 409 until it is reloaded. A cached copy from an earlier build caused hours of confusion.
- Kasm's control bar, status and monitor badges are hidden with injected CSS (`views/kasm.ts`).

## Stream quality

- The quality select uses Kasm's own presets through the `video_quality` setting: 1 Low,
  2 Medium, 3 High, 4 Extreme, 5 Lossless (0 Static behaves like Medium in this client build;
  10 is Custom, where the individual settings apply).
- KasmVNC ignores every quality setting a client sends unless the server allows it in
  `-AllowOverride`. The default list only has desktop and clipboard items, so the entrypoint adds
  MaxVideoResolution, VideoTime, VideoArea, VideoOutTime, VideoScaling, DynamicQualityMin/Max,
  TreatLossless, JpegVideoQuality, WebpVideoQuality and FrameRate.
- Any preset other than Custom overwrites the individual settings (max_video_resolution,
  jpeg_video_quality, ...). Passing those alone does nothing.
- Measured on a Wikipedia page scrolled for 8 seconds, 1920x1080, same machine:
  Low 6.9 MB, Medium 5.6 MB, High 16.6 MB, Lossless 29.6 MB. Before AllowOverride was set, every
  setting gave about the same numbers.
- Real downscaling only happens in Kasm's video mode (Low and Medium cap video at 960x540).
  Custom mode with `video_time=0` forces video mode; it was tried and dropped in favour of the
  presets.
- Quality changes are logged by the app as `[viewer] quality <old> -> <new> (<dashboard|mcp>)`.

## Korean input: not supported through VNC

Everything tried, and why it failed:

1. noVNC + x11vnc keysym mirroring: x11vnc maps each new Unicode keysym to a spare keycode;
   typing fast produced stray jamo ("한ㄱ국ㅇ어").
2. Kasm's IME mode: it diffs the composition and sends Backspace + Unicode keysyms. The X keymap
   has only a few spare keycodes and Hangul has 11,172 syllables, so after a few characters
   `Input: Failure adding new keysym 0x100ac00` is logged, the character is dropped and the
   Backspaces still land: typed text disappears.
3. Mirroring the composition into the page through DevTools (`Input.imeSetComposition` /
   `insertText`) while ordinary keys go through VNC: correct in tests at human speed, but two
   input channels (VNC and DevTools) race, Kasm reuses its send buffer, and it sends keys on
   animation frames, so ordering needed queueing hacks. Dropped as too fragile.
4. A text box beside the screen that inserts text with Playwright: reliable, removed at the
   user's request.

Korean can still be entered by AI agents with `act` (fill, type) or `input` (type), which go through
Playwright, not VNC.
