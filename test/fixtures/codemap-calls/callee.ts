/** Callee for the calls test. */
export function bump(count: number): number {
  return count + 1;
}

export function reset(): void {}

export class Counter {
  readonly n: number;
  constructor(n = 0) {
    this.n = n;
  }
}

export class Runner {
  step(): number {
    return bump(1);
  }
}
