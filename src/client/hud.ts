import { MAX_HP, MIN_HP } from "../shared/health.ts";

/** Local health from a `{ t: "health" }` frame. Dead stays until a respawn frame clears it. */
export function localHealthLabel(vital: { hp: number; dead: boolean } | undefined): string {
  if (!vital || !Number.isFinite(vital.hp)) return "";
  const hp = Math.min(MAX_HP, Math.max(MIN_HP, vital.hp));
  if (vital.dead) return `hp ${hp} dead`;
  return `hp ${hp}`;
}

export function createHud() {
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
  status.append(label, profileButton);
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
    if (ev.repeat || ev.code !== "F3") return;
    ev.preventDefault();
    statsVisible = !statsVisible;
    stats.style.display = statsVisible ? "block" : "none";
  };
  window.addEventListener("keydown", onStatsKey);
  document.body.append(status, stats, cross);
  return {
    setStatus(text: string) {
      label.textContent = text;
    },
    setProfile(name: string) {
      profileButton.textContent = name;
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
  };
}
