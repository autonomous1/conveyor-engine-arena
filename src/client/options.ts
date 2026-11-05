/**
 * Options dialog. F2 or the Options button toggles the panel.
 * The button is not the canvas click, so it does not request pointer lock.
 * Escape is not handled here; the browser still unlocks the pointer.
 * Show collision, Fire debug, Scene map, and Invert look Y stay in localStorage and are not part of the input message.
 * Noclip is localStorage too. The client sends it on the existing input `buttons` field, and only when the host set `view.noclip`.
 * The model select is sessionStorage. It is sent on hello and again when the choice changes.
 * Host fire counters are painted here. They are not part of the crosshair HUD.
 * A gamepad can move a focus outline and activate the focused row. Mouse and F2 are unchanged.
 */

import { emptyAudit, formatAudit, type AuditCounters } from "../shared/audit.ts";

export const SHOW_COLLISION_STORAGE_KEY = "arena.showCollision.v1";
export const FIRE_DEBUG_STORAGE_KEY = "arena.fireDebug.v1";
export const SHOW_SCENE_MAP_STORAGE_KEY = "arena.showSceneMap.v1";
export const NOCLIP_STORAGE_KEY = "arena.noclip.v1";
export const INVERT_Y_STORAGE_KEY = "arena.invertY.v1";
export const MODEL_CHOICE_STORAGE_KEY = "arena.modelChoice.v1";

export type FocusRow = {
  activate(): void;
  adjust(delta: number): void;
};

export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type OptionsModel = {
  readonly open: boolean;
  readonly showCollision: boolean;
  readonly fireDebug: boolean;
  readonly showSceneMap: boolean;
  /** False when the host did not set `view.noclip`, even if storage says on. */
  readonly showNoclip: boolean;
  /** Right-stick forward looks down when this is on. Default off. */
  readonly invertY: boolean;
  readonly focusIndex: number;
  toggleDialog(): void;
  toggleShowCollision(): void;
  toggleFireDebug(): void;
  toggleShowSceneMap(): void;
  toggleNoclip(): void;
  toggleInvertY(): void;
  /** Wrap within the focusable rows. */
  moveFocus(delta: number): void;
  activateFocused(): void;
  adjustFocused(delta: number): void;
  /** Pad open lands on the first row. Mouse and F2 do not call this. */
  resetFocus(): void;
  appendFocusRow(row: FocusRow): void;
  /** F2 toggles the dialog. Every other key, including Escape, is left alone. */
  onKey(code: string): boolean;
};

export type OptionsDialog = OptionsModel & {
  setAudit(counters: AuditCounters): void;
  /** Selected character id. Empty when the dialog was built without model choices. */
  readonly modelChoice: string;
  repaint(): void;
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

export function loadFireDebug(storage: KeyValueStorage | null | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(FIRE_DEBUG_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function saveFireDebug(storage: KeyValueStorage | null | undefined, on: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(FIRE_DEBUG_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // The in-memory switch still applies for this session.
  }
}

export function loadShowSceneMap(storage: KeyValueStorage | null | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(SHOW_SCENE_MAP_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function saveShowSceneMap(storage: KeyValueStorage | null | undefined, on: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(SHOW_SCENE_MAP_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // The in-memory switch still applies for this session.
  }
}

export function loadNoclip(storage: KeyValueStorage | null | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(NOCLIP_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function saveNoclip(storage: KeyValueStorage | null | undefined, on: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(NOCLIP_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // The in-memory switch still applies for this session.
  }
}

export function loadInvertY(storage: KeyValueStorage | null | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(INVERT_Y_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function saveInvertY(storage: KeyValueStorage | null | undefined, on: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(INVERT_Y_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // The in-memory switch still applies for this session.
  }
}

/** First id in `choices`, or the saved id when it is still in the list. */
export function loadModelChoice(storage: KeyValueStorage | null | undefined, choices: readonly string[]): string {
  const first = choices[0] ?? "";
  if (!storage || choices.length === 0) return first;
  try {
    const saved = storage.getItem(MODEL_CHOICE_STORAGE_KEY);
    if (saved && choices.includes(saved)) return saved;
  } catch {
    // Fall through to the first id.
  }
  return first;
}

export function saveModelChoice(storage: KeyValueStorage | null | undefined, id: string): void {
  if (!storage) return;
  try {
    storage.setItem(MODEL_CHOICE_STORAGE_KEY, id);
  } catch {
    // The in-memory choice still applies for this session.
  }
}

export function createOptionsModel(
  storage: KeyValueStorage | null | undefined,
  onShowCollision: (on: boolean) => void,
  onFireDebug: (on: boolean) => void = () => {},
  onShowMap: (on: boolean) => void = () => {},
  onNoclip: (on: boolean) => void = () => {},
  noclipAllowed = false,
): OptionsModel {
  let open = false;
  let showCollision = loadShowCollision(storage);
  let fireDebug = loadFireDebug(storage);
  let showSceneMap = loadShowSceneMap(storage);
  let noclipOn = loadNoclip(storage);
  let invertY = loadInvertY(storage);
  let focusIndex = 0;
  const focusRows: FocusRow[] = [];
  onShowCollision(showCollision);
  onFireDebug(fireDebug);
  onShowMap(showSceneMap);
  onNoclip(noclipAllowed && noclipOn);
  const toggleShowCollision = () => {
    showCollision = !showCollision;
    saveShowCollision(storage, showCollision);
    onShowCollision(showCollision);
  };
  const toggleFireDebug = () => {
    fireDebug = !fireDebug;
    saveFireDebug(storage, fireDebug);
    onFireDebug(fireDebug);
  };
  const toggleShowSceneMap = () => {
    showSceneMap = !showSceneMap;
    saveShowSceneMap(storage, showSceneMap);
    onShowMap(showSceneMap);
  };
  const toggleNoclip = () => {
    if (!noclipAllowed) return;
    noclipOn = !noclipOn;
    saveNoclip(storage, noclipOn);
    onNoclip(noclipOn);
  };
  const toggleInvertY = () => {
    invertY = !invertY;
    saveInvertY(storage, invertY);
  };
  const idle = { activate() {}, adjust(_delta: number) {} };
  focusRows.push(
    { activate: toggleShowCollision, adjust: idle.adjust },
    { activate: toggleFireDebug, adjust: idle.adjust },
    { activate: toggleShowSceneMap, adjust: idle.adjust },
    { activate: toggleInvertY, adjust: idle.adjust },
  );
  if (noclipAllowed) focusRows.push({ activate: toggleNoclip, adjust: idle.adjust });
  return {
    get open() {
      return open;
    },
    get showCollision() {
      return showCollision;
    },
    get fireDebug() {
      return fireDebug;
    },
    get showSceneMap() {
      return showSceneMap;
    },
    get showNoclip() {
      return noclipAllowed && noclipOn;
    },
    get invertY() {
      return invertY;
    },
    get focusIndex() {
      return focusIndex;
    },
    toggleDialog() {
      open = !open;
    },
    toggleShowCollision,
    toggleFireDebug,
    toggleShowSceneMap,
    toggleNoclip,
    toggleInvertY,
    moveFocus(delta: number) {
      const count = focusRows.length;
      if (count <= 0 || !Number.isFinite(delta) || delta === 0) return;
      focusIndex = (focusIndex + delta) % count;
      if (focusIndex < 0) focusIndex += count;
    },
    activateFocused() {
      const row = focusRows[focusIndex];
      if (!row) return;
      row.activate();
    },
    adjustFocused(delta: number) {
      const row = focusRows[focusIndex];
      if (!row || !Number.isFinite(delta) || delta === 0) return;
      row.adjust(delta);
    },
    resetFocus() {
      focusIndex = 0;
    },
    appendFocusRow(row: FocusRow) {
      focusRows.push(row);
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

function browserSession(): KeyValueStorage | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
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
  onShowMap: (on: boolean) => void = () => {},
  extras: {
    noclipAllowed?: boolean;
    onNoclip?: (on: boolean) => void;
    modelChoices?: readonly string[];
    onModel?: (id: string) => void;
    /** Session store. `undefined` uses `sessionStorage`. `null` does not persist. */
    modelStorage?: KeyValueStorage | null;
  } = {},
): OptionsDialog {
  const noclipAllowed = extras.noclipAllowed === true;
  const model = createOptionsModel(storage, onShowCollision, () => {}, onShowMap, extras.onNoclip ?? (() => {}), noclipAllowed);
  let audit = emptyAudit();

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

  const switchStyle = [
    "display:flex", "width:100%", "justify-content:space-between",
    "pointer-events:auto", "padding:6px 8px", "border:1px solid #3c4454",
    "border-radius:4px", "background:#1c2230", "color:inherit", "font:inherit",
    "cursor:pointer", "text-align:left",
  ].join(";");
  const collisionSwitch = document.createElement("button");
  collisionSwitch.id = "show-collision";
  collisionSwitch.type = "button";
  collisionSwitch.setAttribute("role", "switch");
  collisionSwitch.style.cssText = switchStyle;

  const fireSwitch = document.createElement("button");
  fireSwitch.id = "fire-debug";
  fireSwitch.type = "button";
  fireSwitch.setAttribute("role", "switch");
  fireSwitch.style.cssText = `${switchStyle};margin-top:8px`;

  const mapSwitch = document.createElement("button");
  mapSwitch.id = "scene-map-toggle";
  mapSwitch.type = "button";
  mapSwitch.setAttribute("role", "switch");
  mapSwitch.style.cssText = `${switchStyle};margin-top:8px`;

  const invertSwitch = document.createElement("button");
  invertSwitch.id = "invert-y";
  invertSwitch.type = "button";
  invertSwitch.setAttribute("role", "switch");
  invertSwitch.style.cssText = `${switchStyle};margin-top:8px`;

  const noclipSwitch = document.createElement("button");
  noclipSwitch.id = "noclip";
  noclipSwitch.type = "button";
  noclipSwitch.setAttribute("role", "switch");
  noclipSwitch.style.cssText = `${switchStyle};margin-top:8px`;
  noclipSwitch.hidden = !noclipAllowed;
  noclipSwitch.disabled = !noclipAllowed;

  const auditView = document.createElement("pre");
  auditView.id = "audit-counters";
  auditView.style.cssText = [
    "margin:12px 0 0",
    "padding-top:8px",
    "border-top:1px solid #3c4454",
    "white-space:pre",
    "font:12px/1.45 ui-monospace, monospace",
  ].join(";");

  const choices = (extras.modelChoices ?? []).filter((id) => id.length > 0);
  let modelChoice = "";
  let modelLabel: HTMLLabelElement | undefined;
  let modelSelect: HTMLSelectElement | undefined;
  if (choices.length > 0) {
    const store = extras.modelStorage !== undefined ? extras.modelStorage : browserSession();
    modelChoice = loadModelChoice(store, choices);
    modelLabel = document.createElement("label");
    modelLabel.setAttribute("for", "model-choice");
    modelLabel.textContent = "Model";
    modelLabel.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;";
    const select = document.createElement("select");
    modelSelect = select;
    select.id = "model-choice";
    select.style.cssText = [
      "pointer-events:auto", "background:#1c2230", "color:inherit",
      "border:1px solid #3c4454", "border-radius:4px", "font:inherit",
    ].join(";");
    for (const id of choices) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      select.append(option);
    }
    select.value = modelChoice;
    select.addEventListener("change", () => {
      const next = select.value;
      if (!choices.includes(next) || next === modelChoice) return;
      modelChoice = next;
      saveModelChoice(store, next);
      extras.onModel?.(next);
    });
    modelLabel.append(select);
  }

  const help = document.createElement("p");
  help.id = "control-help";
  help.textContent = "I or Y inspects the crosshair.";
  help.style.cssText = "margin:10px 0 0;color:#c5ccd8;font:12px/1.4 ui-sans-serif,system-ui;";
  panel.append(title, collisionSwitch, fireSwitch, mapSwitch, invertSwitch, noclipSwitch);
  if (modelLabel) panel.append(modelLabel);
  panel.append(auditView, help);

  const focusEls: HTMLElement[] = [collisionSwitch, fireSwitch, mapSwitch, invertSwitch];
  if (noclipAllowed) focusEls.push(noclipSwitch);
  if (modelLabel && modelSelect) {
    const select = modelSelect;
    focusEls.push(modelLabel);
    model.appendFocusRow({
      activate() {},
      adjust(delta: number) {
        const count = select.options.length;
        if (count === 0) return;
        const next = Math.min(count - 1, Math.max(0, select.selectedIndex + delta));
        if (next === select.selectedIndex) return;
        select.selectedIndex = next;
        select.dispatchEvent(new Event("change"));
      },
    });
  }
  const paintSwitch = (el: HTMLButtonElement, on: boolean, label: string) => {
    el.setAttribute("aria-checked", on ? "true" : "false");
    el.textContent = on ? `${label}: on` : `${label}: off`;
    el.style.borderColor = on ? "#3dff9a" : "#3c4454";
  };
  const paint = () => {
    panel.hidden = !model.open;
    button.setAttribute("aria-expanded", model.open ? "true" : "false");
    paintSwitch(collisionSwitch, model.showCollision, "Show collision");
    paintSwitch(fireSwitch, model.fireDebug, "Fire debug");
    paintSwitch(mapSwitch, model.showSceneMap, "Scene map");
    paintSwitch(invertSwitch, model.invertY, "Invert look Y");
    paintSwitch(noclipSwitch, model.showNoclip, "Noclip");
    noclipSwitch.hidden = !noclipAllowed;
    noclipSwitch.disabled = !noclipAllowed;
    focusEls.forEach((el, index) => {
      const focused = model.open && index === model.focusIndex;
      el.style.outline = focused ? "2px solid #d7e3ff" : "";
      el.style.outlineOffset = focused ? "2px" : "";
    });
    auditView.textContent = formatAudit(audit);
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
  const onSwitch = (el: HTMLButtonElement, toggle: () => void) => {
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggle();
      paint();
    });
  };
  onSwitch(collisionSwitch, () => model.toggleShowCollision());
  onSwitch(fireSwitch, () => model.toggleFireDebug());
  onSwitch(mapSwitch, () => model.toggleShowSceneMap());
  onSwitch(invertSwitch, () => model.toggleInvertY());
  if (noclipAllowed) onSwitch(noclipSwitch, () => model.toggleNoclip());

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
  const dialog = model as OptionsDialog;
  Object.defineProperty(dialog, "modelChoice", {
    get() {
      return modelChoice;
    },
  });
  dialog.repaint = () => {
    paint();
  };
  dialog.setAudit = (next) => {
    if (sameAudit(audit, next)) return;
    audit = {
      fired: next.fired,
      accepted: next.accepted,
      droppedDuplicate: next.droppedDuplicate,
      droppedRate: next.droppedRate,
      hits: next.hits,
      kills: next.kills,
    };
    auditView.textContent = formatAudit(audit);
  };
  return dialog;
}

function sameAudit(a: AuditCounters, b: AuditCounters): boolean {
  return a.fired === b.fired
    && a.accepted === b.accepted
    && a.droppedDuplicate === b.droppedDuplicate
    && a.droppedRate === b.droppedRate
    && a.hits === b.hits
    && a.kills === b.kills;
}
