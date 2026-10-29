/** Character id carried on hello. Absent or blank means the host default. */
export function helloModel(hello: unknown): string | undefined {
  if (!hello || typeof hello !== "object") return undefined;
  const model = (hello as { model?: unknown }).model;
  if (typeof model !== "string" || model.length === 0) return undefined;
  return model;
}

export function modelFrame(model: string): { t: "model"; v: 1; model: string } {
  return { t: "model", v: 1, model };
}

/** Arena frame `{ t: "model", v: 1, model }`. Other frames are ignored. */
export function parseModelFrame(frame: unknown): string | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const rec = frame as { t?: unknown; v?: unknown; model?: unknown };
  if (rec.t !== "model" || rec.v !== 1) return undefined;
  if (typeof rec.model !== "string" || rec.model.length === 0) return undefined;
  return rec.model;
}
