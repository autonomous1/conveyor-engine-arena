// Minimal Chrome DevTools Protocol client over Node's global WebSocket (Node 22+). No deps.
export async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", (e) => rej(new Error(`CDP connect failed: ${wsUrl} ${e.message ?? ""}`)), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject, method } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    const key = `${msg.sessionId ?? ""}|${msg.method}`;
    for (const fn of listeners.get(key) ?? []) fn(msg.params);
  });
  const api = {
    send(method, params = {}, sessionId) {
      const msgId = ++id;
      const payload = { id: msgId, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
      return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject, method }));
    },
    on(method, fn, sessionId) {
      const key = `${sessionId ?? ""}|${method}`;
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(fn);
    },
    session(sessionId) {
      return {
        send: (m, p) => api.send(m, p, sessionId),
        on: (m, fn) => api.on(m, fn, sessionId),
      };
    },
    close() { try { ws.close(); } catch {} },
  };
  return api;
}

/** Browser-level ws URL from a --remote-debugging-port. */
export async function browserWsUrl(port, host = "127.0.0.1") {
  const res = await fetch(`http://${host}:${port}/json/version`);
  if (!res.ok) throw new Error(`no DevTools on ${host}:${port} (${res.status})`);
  return (await res.json()).webSocketDebuggerUrl;
}
