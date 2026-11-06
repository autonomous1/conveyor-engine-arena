/**
 * Headless QA hooks. Installed only when the page search is `qa=1`.
 * The normal client does not call `installQaApi`.
 */

export type V3 = { x: number; y: number; z: number };

export type QaDoor = { id: string; open: boolean };
export type QaPickup = { id: string };
export type QaPawn = { id: number; x: number; y: number; z: number; yaw: number };

export type QaFollow = { back: number; up: number };

export type QaScene = {
  camera: {
    fov: number;
    position: { set(x: number, y: number, z: number): void };
    up: { set(x: number, y: number, z: number): void };
    lookAt(x: number, y: number, z: number): void;
    updateProjectionMatrix(): void;
  };
  cameraLocked: boolean;
  renderer: { domElement: { toDataURL(type?: string): string } };
};

export type QaApi = {
  ready(): Promise<void>;
  lookFrom(eye: V3, target: V3, fovDeg?: number): void;
  follow(entityId: number, opts?: { back?: number; up?: number }): void;
  waitFrames(n: number): Promise<void>;
  snapshot(): Promise<string>;
  doors(): QaDoor[];
  pickups(): QaPickup[];
  pawns(): QaPawn[];
};

type QaWindow = { __qa?: QaApi };

/** True only for the search `qa=1`. `qa=true` and a bare `qa` are not QA mode. */
export function isQaMode(search: string): boolean {
  const query = search.startsWith("?") ? search.slice(1) : search;
  return new URLSearchParams(query).get("qa") === "1";
}

/**
 * Read `#token=` and drop the fragment with `replaceState`.
 * The fragment is not part of the request URL. An empty token is left in place.
 */
export function takeHashToken(
  loc: { hash: string; pathname: string; search: string },
  history: { replaceState(data: unknown, unused: string, url?: string | URL | null): void },
): string | undefined {
  const body = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;
  const token = new URLSearchParams(body).get("token");
  if (token === null || token.length === 0) return undefined;
  history.replaceState(null, "", `${loc.pathname}${loc.search}`);
  return token;
}

export function installQaApi(ctx: {
  scene: QaScene;
  net: { firstSnapshot: Promise<void> };
  render(): void;
  freeze(): void;
  follow(entityId: number, opts: QaFollow): void;
  clearFollow(): void;
  doors(): QaDoor[];
  pickups(): QaPickup[];
  pawns(): QaPawn[];
}): void {
  ctx.freeze();
  const api: QaApi = {
    ready: () => ctx.net.firstSnapshot,
    lookFrom(eye, target, fov = 55) {
      ctx.clearFollow();
      ctx.scene.camera.fov = fov;
      ctx.scene.camera.position.set(eye.x, eye.y, eye.z);
      ctx.scene.camera.up.set(0, 1, 0);
      ctx.scene.camera.lookAt(target.x, target.y, target.z);
      ctx.scene.camera.updateProjectionMatrix();
      ctx.scene.cameraLocked = true;
    },
    follow(entityId, opts) {
      const back = opts?.back;
      const up = opts?.up;
      ctx.scene.cameraLocked = true;
      ctx.follow(entityId, {
        back: typeof back === "number" && Number.isFinite(back) ? back : 3,
        up: typeof up === "number" && Number.isFinite(up) ? up : 1.6,
      });
    },
    waitFrames(n) {
      const frames = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
      return new Promise((resolve) => {
        if (frames === 0) {
          resolve();
          return;
        }
        let left = frames;
        const step = () => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    },
    async snapshot() {
      ctx.render();
      return ctx.scene.renderer.domElement.toDataURL("image/png");
    },
    doors: () => ctx.doors(),
    pickups: () => ctx.pickups(),
    pawns: () => ctx.pawns(),
  };
  (window as QaWindow).__qa = api;
}
