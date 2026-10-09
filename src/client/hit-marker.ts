/**
 * One screen circle at the crosshair. It is not a decal and not a scene mesh.
 * A sent local fire shows it for 150 ms. The shooter's own laser shows it
 * only when that send did not. A miss still shows it. Another pawn's laser does not.
 */

export const HIT_MARKER_MS = 150;

export type HitMarkerNote =
  | { kind: "fire"; sent: boolean }
  | { kind: "laser"; shooter: number; ownedId: number | undefined };

export type HitMarker = {
  readonly element: HTMLDivElement;
  readonly visible: boolean;
  note(event: HitMarkerNote, now: number): void;
  tick(now: number): void;
};

export function createHitMarker(doc: Document = document): HitMarker {
  const element = doc.createElement("div");
  element.id = "hit-marker";
  element.style.cssText = [
    "position:fixed",
    "left:50%",
    "top:50%",
    "width:8px",
    "height:8px",
    "border-radius:50%",
    "background:#ff2020",
    "transform:translate(-50%,-50%)",
    "z-index:4",
    "pointer-events:none",
  ].join(";");
  element.style.display = "none";
  doc.body.append(element);

  let hideAt = 0;
  /** Own lasers still owed by sends that already painted the circle. */
  let echoes = 0;

  function show(now: number) {
    hideAt = now + HIT_MARKER_MS;
    element.style.display = "block";
  }

  return {
    element,
    get visible() {
      return element.style.display !== "none";
    },
    note(event, now) {
      if (event.kind === "fire") {
        if (!event.sent) return;
        echoes += 1;
        show(now);
        return;
      }
      if (!Number.isFinite(event.shooter) || event.ownedId === undefined || event.shooter !== event.ownedId) return;
      if (echoes > 0) {
        echoes -= 1;
        return;
      }
      show(now);
    },
    tick(now) {
      if (hideAt === 0 || now < hideAt) return;
      hideAt = 0;
      element.style.display = "none";
    },
  };
}
