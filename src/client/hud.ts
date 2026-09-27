export function createHud() {
  const el = document.createElement("div");
  el.id = "status";
  el.style.cssText = [
    "position:fixed", "top:0", "left:0", "right:0", "z-index:2",
    "padding:8px 12px", "background:#12151ccc", "color:#d7dde8",
    "font:13px/1.4 ui-sans-serif, system-ui",
  ].join(";");
  document.body.appendChild(el);
  return {
    set(text: string) {
      el.textContent = text;
    },
  };
}
