import type { Clock } from "../clock";

interface Timer {
  readonly at: number;
  readonly order: number;
  readonly callback: () => void;
}

/** A Clock that only moves when told to, so that tests run instantly and replay identically. */
export class ManualClock implements Clock {
  #now: number;
  #timers: Timer[] = [];
  #scheduled = 0;

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  schedule(at: number, callback: () => void): () => void {
    const timer = { at, order: this.#scheduled++, callback };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((other) => other !== timer);
    };
  }

  /**
   * Moves time forward by `ms`, running every callback that falls due on the
   * way, in time order, including callbacks scheduled while advancing.
   */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (
      let timer = this.#nextDue(target);
      timer;
      timer = this.#nextDue(target)
    ) {
      this.#timers = this.#timers.filter((other) => other !== timer);
      this.#now = Math.max(this.#now, timer.at);
      timer.callback();
    }
    this.#now = target;
  }

  #nextDue(target: number): Timer | undefined {
    let next: Timer | undefined;
    for (const timer of this.#timers) {
      if (timer.at > target) continue;
      if (
        !next ||
        timer.at < next.at ||
        (timer.at === next.at && timer.order < next.order)
      )
        next = timer;
    }
    return next;
  }
}
