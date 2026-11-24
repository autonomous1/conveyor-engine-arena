// Registers the probe tree switch for a probe child only (`npm run probe`).
// Tests and the task runners keep `ts-ext-register.mjs`.
import { register } from "node:module";

register("./probe-tree-hook.mjs", import.meta.url);
