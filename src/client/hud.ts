// ARCHITECTURE: The status, profile, pad, stats, and info DOM; QA can start
//   hidden.
// Wiring: boot.ts creates it and writes it in the frame and on snapshots.
import { MAX_HP, MIN_HP } from "../shared/health.ts";

function shortPadId(id: string): string {
  const trimmed = id.trim();
  const paren = trimmed.indexOf("(");
  const cut = (paren > 0 ? trimmed.slice(0, paren) : trimmed).trim();
  return cut.length > 0 ? cut : trimmed;
}

/**
 * Local health from a `{ t: "health" }` frame.
 * @post Dead stays until a respawn frame clears it.
 */
export function localHealthLabel(vital: { hp: number; dead: boolean } | undefined): string {
  if (!vital || !Number.isFinite(vital.hp)) return "";
  const hp = Math.min(MAX_HP, Math.max(MIN_HP, vital.hp));
  if (vital.dead) return `hp ${hp} dead`;
  return `hp ${hp}`;
}

/** Status, crosshair, inspect line, and stats, appended to document.body. Hidden creation ignores F3. */
export interface Hud {
  /** Status text. Still written when the bar is hidden. */
  setStatus(text: string): void;
  /** Gamepad profile button label. */
  setProfile(name: string): void;
  /** Clear when `pad` is null. A non-standard pad on the standard profile is a warning. */
  setPad(pad: { id: string; mapping: string } | null, profile: string): void;
  /** Replace the profile button's click handler. */
  onProfileToggle(handler: () => void): void;
  /** F3 flips this unless the HUD was created hidden. The key listener stays on window. */
  readonly statsVisible: boolean;
  /** Stats text. No-op while the panel is hidden. */
  setStats(text: string): void;
  /** Crosshair inspect. Empty hides the line. Does not touch status or stats. */
  setInfo(text: string): void;
  /**
   * Copy an inspect hit id. Empty does nothing. A missing clipboard leaves the line up.
   * The copied hint uses Date.now and lasts one second.
   */
  copyInfo(id: string): void;
}

export function createHud(opts?: { hidden?: boolean }): Hud {
  const status = document.createElement("div");
  status.id = "status";
  status.style.cssText = [
    "position:fixed", "top:0", "left:0", "right:0", "z-index:2",
    "padding:8px 12px", "background:#12151ccc", "color:#ffffff",
    "font:13px/1.4 ui-sans-serif, system-ui", "pointer-events:none",
  ].join(";");
  const label = document.createElement("span");
  label.id = "status-text";
  const profileButton = document.createElement("button");
  profileButton.id = "gamepad-profile";
  profileButton.type = "button";
  profileButton.title = "Gamepad profile (F10)";
  profileButton.textContent = "standard";
  profileButton.style.cssText = [
    "pointer-events:auto", "margin-left:12px", "padding:0 6px",
    "border:1px solid #3c4454", "border-radius:4px", "background:#1c2230",
    "color:inherit", "font:inherit", "cursor:pointer", "vertical-align:baseline",
  ].join(";");
  const padLabel = document.createElement("span");
  padLabel.id = "gamepad-pad";
  padLabel.style.cssText = "margin-left:12px;";
  status.append(label, profileButton, padLabel);
  const cross = document.createElement("div");
  cross.id = "crosshair";
  cross.style.cssText = [
    "position:fixed", "left:50%", "top:50%", "width:16px", "height:16px",
    "transform:translate(-50%,-50%)", "z-index:3", "pointer-events:none",
  ].join(";");
  const vert = document.createElement("div");
  vert.style.cssText = "position:absolute;left:7px;top:0;width:2px;height:16px;background:#f2f6fb";
  const horz = document.createElement("div");
  horz.style.cssText = "position:absolute;left:0;top:7px;width:16px;height:2px;background:#f2f6fb";
  cross.append(vert, horz);
  const info = document.createElement("div");
  info.id = "info-probe";
  let shown = "";
  let copiedUntil = 0;
  const hidden = opts?.hidden === true;
  const paintInfo = () => {
    if (hidden) {
      info.style.display = "none";
      return;
    }
    const visible = shown.length > 0;
    const hint = visible && Date.now() < copiedUntil ? "\ncopied" : "";
    info.textContent = shown + hint;
    info.style.cssText = [
      "position:fixed", "left:50%", "top:calc(50% + 18px)", "transform:translateX(-50%)",
      "z-index:3", "max-width:42rem", "padding:6px 8px", "background:#12151ccc", "color:#ffffff",
      "font:13px/1.4 ui-sans-serif, system-ui", "white-space:pre", "text-align:center",
      `pointer-events:${visible ? "auto" : "none"}`,
      `user-select:${visible ? "text" : "none"}`,
      `display:${visible ? "block" : "none"}`,
    ].join(";");
    info.style.display = visible ? "block" : "none";
    info.style.pointerEvents = visible ? "auto" : "none";
    info.style.userSelect = visible ? "text" : "none";
  };
  paintInfo();
  // A press on the readout must not become use or fire. preventDefault would
  // also cancel text selection, so the event is only stopped.
  const stopOverlayPress = (ev: Event) => {
    ev.stopPropagation();
  };
  info.addEventListener("pointerdown", stopOverlayPress);
  info.addEventListener("mousedown", stopOverlayPress);
  info.addEventListener("click", stopOverlayPress);
  let onProfileToggle = () => {};
  profileButton.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onProfileToggle();
  });
  const stats = document.createElement("pre");
  stats.id = "stats";
  stats.style.cssText = [
    "position:fixed", "left:12px", "bottom:12px", "z-index:2", "margin:0",
    "background:#12151c88", "color:#ffffffff", "padding:8px 10px", "border-radius:6px",
    "white-space:pre",
    "font-family: \"DejaVu Sans Mono\", \"Liberation Mono\", \"Noto Sans Mono\", monospace;",
    "font-weight: 400; font-size: 14px; line-height: 1.35;text-shadow: 0 1px 0 #000;",
    "pointer-events:none",
  ].join(";");
  let statsVisible = true;
  const onStatsKey = (ev: KeyboardEvent) => {
    if (hidden || ev.repeat || ev.code !== "F3") return;
    ev.preventDefault();
    statsVisible = !statsVisible;
    stats.style.display = statsVisible ? "block" : "none";
  };
  window.addEventListener("keydown", onStatsKey);
  if (hidden) {
    status.style.display = "none";
    cross.style.display = "none";
    stats.style.display = "none";
    info.style.display = "none";
  }
  document.body.append(status, stats, cross, info);
  return {
    setStatus(text: string) {
      label.textContent = text;
    },
    setProfile(name: string) {
      profileButton.textContent = name;
    },
    setPad(pad: { id: string; mapping: string } | null, profile: string) {
      if (!pad) {
        padLabel.textContent = "";
        padLabel.style.color = "";
        return;
      }
      if (pad.mapping !== "standard" && profile === "standard") {
        padLabel.textContent = "⚠ pad not in standard mapping (set F310 switch to X)";
        padLabel.style.color = "#ffb020";
        return;
      }
      padLabel.textContent = `pad: ${shortPadId(pad.id)}`;
      padLabel.style.color = "";
    },
    onProfileToggle(handler: () => void) {
      onProfileToggle = handler;
    },
    get statsVisible() {
      return statsVisible;
    },
    setStats(text: string) {
      if (!statsVisible) return;
      stats.textContent = text;
    },
    /** Crosshair inspect. Empty hides the line. Does not touch status or stats. */
    setInfo(text: string) {
      shown = text;
      paintInfo();
    },
    /**
     * Copy an inspect hit id. Refresh must not call this.
     * A missing clipboard or a rejected write leaves the overlay up.
     */
    copyInfo(id: string) {
      if (id.length === 0) return;
      const markCopied = () => {
        copiedUntil = Date.now() + 1000;
        paintInfo();
      };
      try {
        const clip = navigator.clipboard;
        if (!clip || typeof clip.writeText !== "function") return;
        void Promise.resolve(clip.writeText(id)).then(markCopied, () => {});
      } catch {
        // Clipboard can throw when the document is not focused. The readout stays.
      }
    },
  };
}
