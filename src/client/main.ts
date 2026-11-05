import type { ArenaView } from "../shared/arena-view.js";
import { AUTH_MSG, clearKey, isArenaSolo, loadKey } from "./auth-key.js";
import { boot } from "./boot.js";

const view = await fetch("/arena.json").then((res) => {
  if (!res.ok) throw new Error("arena.json " + res.status);
  return res.json() as Promise<ArenaView>;
});

function socketUrl(arena: ArenaView): string {
  const query = new URLSearchParams(location.search).get("ws");
  if (query) return query;
  return arena.wsUrl ?? `${location.origin.replace(/^http/, "ws")}/`;
}

if (!isArenaSolo() && view.authRequired === true && !loadKey()) {
  sessionStorage.setItem(AUTH_MSG, "Paste your auth key to play");
  location.replace("/landing-page.html#play");
} else {
  await boot(view, () => new WebSocket(socketUrl(view)), {
    onAuthRejected(reason) {
      clearKey();
      sessionStorage.setItem(AUTH_MSG, reason.length > 0 ? `auth: ${reason}` : "auth rejected");
      location.replace("/landing-page.html#play");
    },
  });
}
