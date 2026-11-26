/**
 * Injected into KasmVNC's web client page so the dashboard frame shows only the remote screen.
 * Korean is not typed through VNC (the X keymap has a few spare keycodes, Hangul has thousands of
 * characters); the dashboard's text box inserts it through the app instead.
 */
export const KASM_STYLE = `<style>
  /* Only the screen: no Kasm control bar, display badge or connection overlays. */
  #noVNC_control_bar_anchor, #noVNC_control_bar_hint, #noVNC_status, #noVNC_identify_monitors_container,
  .noVNC_monitor_identify, #noVNC_transition { display: none !important; }
</style>`
