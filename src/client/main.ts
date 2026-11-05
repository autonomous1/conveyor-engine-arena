import type { ArenaView } from "../shared/arena-view.js";
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

await boot(view, () => new WebSocket(socketUrl(view)));
