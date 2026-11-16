/**
 * The only source of time for a Server or Client: real timers in the adapters,
 * a manual Clock in tests. Times are in milliseconds.
 */
export interface Clock {
  now(): number;
  /** Calls `callback` once the time reaches `at`; the returned function cancels it. */
  schedule(at: number, callback: () => void): () => void;
}
