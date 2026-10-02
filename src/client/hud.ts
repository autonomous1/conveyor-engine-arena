export function createHud() {
  const status = document.createElement("div");
  status.id = "status";
  status.style.cssText = [
    "position:fixed", "top:0", "left:0", "right:0", "z-index:2",
    "padding:8px 12px", "background:#12151ccc", "color:#d7dde8",
    "font:13px/1.4 ui-sans-serif, system-ui", "pointer-events:none",
  ].join(";");
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
  document.body.append(status, cross);
  return {
    setStatus(text: string) {
      status.textContent = text;
    },
  };
}
