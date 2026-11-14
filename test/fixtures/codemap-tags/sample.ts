/**
 * Sample module for codemap tag extraction tests.
 * @why Exists so the tag extractor is tested without touching real source.
 */
export type Thing = { x: number };

/**
 * @invariant `count` is never negative.
 * @pre `step` is positive.
 * @post Returns `count` incremented by `step`.
 * @why Uses a loop so the assertion is trivially checkable.
 */
export function bump(count: number, step: number): number {
  return count + step;
}

/** @internal */
export function helper(): void {}

// Same-file alias: the codemap must take tags from `bump`, not from this specifier.
export { bump as jump };
