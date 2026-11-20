// ARCHITECTURE: a `host`/`client`/`shared` KB section reference must resolve to a
// section a file of that layer actually declares.
// Wiring: check.mjs; the scanner lives in lib/refs.mjs (shared with drift).
// Invariants: a section number is declared once per layer — the stub indexes prose,
// it does not declare §N, so a resolved reference has exactly one home.
import { sectionRefFindings } from "../lib/refs.mjs";

export const id = "kb-section-refs";
export const description = "a `layer-kb §N` reference must resolve to a section in that layer";

export function run(root) {
  return sectionRefFindings(root);
}
