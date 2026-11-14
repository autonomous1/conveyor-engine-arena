import { bump, reset, Counter } from "./callee.js";

function localStep(): number {
  return bump(1);
}

function shadowed(): number {
  const bump = () => 0;
  return bump();
}

function globals(x: number): number {
  const obj = { method: () => 1 };
  obj.method();
  return Math.max(x, 1);
}

/** Calls three local symbols and skips globals and property calls. */
export function run(): number {
  const a = localStep();
  reset();
  const c = new Counter();
  return a + c.n;
}
