/**
 * The instants of a fixed-rate loop: `start + n * interval` for n = 1, 2, ...
 * Each instant is computed from the start rather than by adding intervals, so
 * that a rate like 30 per second does not drift.
 */
export class Cadence {
  readonly #start: number;
  readonly #interval: number;
  #index = 1;

  /** `rate` is in instants per second; `what` names it in the error for an invalid rate. */
  constructor(start: number, rate: number, what: string) {
    if (!(rate > 0 && Number.isFinite(rate)))
      throw new RangeError(
        `The ${what} must be a positive number per second, not ${rate}`,
      );
    this.#start = start;
    this.#interval = 1000 / rate;
  }

  get next(): number {
    return this.#start + this.#index * this.#interval;
  }

  /** Moves to the instant after the next one. */
  step(): void {
    this.#index++;
  }

  /** Moves to the first instant after `now`, however many were missed. */
  skipPast(now: number): void {
    while (this.next <= now) this.#index++;
  }
}
