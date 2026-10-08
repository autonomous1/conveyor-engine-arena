/**
 * Options dialog. F2 or the Options button toggles the panel.
 * The button is not the canvas click, so it does not request pointer lock.
 * Escape is not handled here; the browser still unlocks the pointer.
 * Show collision stays in localStorage and is not part of the input message.
 */

export const SHOW_COLLISION_STORAGE_KEY = "arena.showCollision.v1";

export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type OptionsModel = {
  readonly open: boolean;
  readonly showCollision: boolean;
  toggleDialog(): void;
  toggleShowCollision(): void;
  /** F2 toggles the dialog. Every other key, including Escape, is left alone. */
  onKey(code: string): boolean;
};

export function loadShowCollision(storage: KeyValueStorage | null | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(SHOW_COLLISION_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function saveShowCollision(storage: KeyValueStorage | null | undefined, on: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(SHOW_COLLISION_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // The in-memory switch still applies for this session.
  }
}

export function createOptionsModel(
  storage: KeyValueStorage | null | undefined,
  onShowCollision: (on: boolean) => void,
): OptionsModel {
  let open = false;
  let showCollision = loadShowCollision(storage);
  onShowCollision(showCollision);
  return {
    get open() {
      return open;
    },
    get showCollision() {
      return showCollision;
    },
    toggleDialog() {
      open = !open;
    },
    toggleShowCollision() {
      showCollision = !showCollision;
      saveShowCollision(storage, showCollision);
      onShowCollision(showCollision);
    },
    onKey(code: string) {
      if (code !== "F2") return false;
      open = !open;
      return true;
    },
  };
}

function browserStorage(): KeyValueStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * HTML panel. Call once the status bar exists. The returned model is the
 * same state the panel paints.
 */
export function createOptionsDialog(
  onShowCollision: (on: boolean) => void,
  storage: KeyValueStorage | null = browserStorage(),
): OptionsModel {
  const model = createOptionsModel(storage, onShowCollision);

  const button = document.createElement("button");
  button.id = "options-button";
  button.type = "button";
  button.title = "Options (F2)";
  button.textContent = "Options";
  button.setAttribute("aria-controls", "options-dialog");
  button.style.cssText = [
    "pointer-events:auto", "margin-left:12px", "padding:0 6px",
    "border:1px solid #3c4454", "border-radius:4px", "background:#1c2230",
    "color:inherit", "font:inherit", "cursor:pointer", "vertical-align:baseline",
  ].join(";");

  const panel = document.createElement("div");
  panel.id = "options-dialog";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Options");
  panel.hidden = true;
  panel.style.cssText = [
    "position:fixed", "top:44px", "right:12px", "z-index:4",
    "min-width:200px", "padding:12px 14px", "background:#12151cf2", "color:#ffffff",
    "border:1px solid #3c4454", "border-radius:8px",
    "font:13px/1.4 ui-sans-serif, system-ui",
  ].join(";");

  const title = document.createElement("div");
  title.textContent = "Options";
  title.style.cssText = "font-weight:600;margin-bottom:10px;";

  const collisionSwitch = document.createElement("button");
  collisionSwitch.id = "show-collision";
  collisionSwitch.type = "button";
  collisionSwitch.setAttribute("role", "switch");
  collisionSwitch.style.cssText = [
    "display:flex", "width:100%", "justify-content:space-between",
    "pointer-events:auto", "padding:6px 8px", "border:1px solid #3c4454",
    "border-radius:4px", "background:#1c2230", "color:inherit", "font:inherit",
    "cursor:pointer", "text-align:left",
  ].join(";");

  panel.append(title, collisionSwitch);

  const paint = () => {
    panel.hidden = !model.open;
    button.setAttribute("aria-expanded", model.open ? "true" : "false");
    collisionSwitch.setAttribute("aria-checked", model.showCollision ? "true" : "false");
    collisionSwitch.textContent = model.showCollision ? "Show collision: on" : "Show collision: off";
    collisionSwitch.style.borderColor = model.showCollision ? "#3dff9a" : "#3c4454";
  };
  paint();

  const stop = (ev: Event) => {
    ev.stopPropagation();
  };
  button.addEventListener("pointerdown", stop);
  button.addEventListener("mousedown", stop);
  button.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    model.toggleDialog();
    paint();
  });
  panel.addEventListener("pointerdown", stop);
  panel.addEventListener("click", stop);
  collisionSwitch.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    model.toggleShowCollision();
    paint();
  });

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.repeat) return;
    if (!model.onKey(ev.code)) return;
    ev.preventDefault();
    paint();
  };
  window.addEventListener("keydown", onKeyDown);

  const status = document.getElementById("status");
  if (status) status.append(button);
  else document.body.append(button);
  document.body.append(panel);
  return model;
}
