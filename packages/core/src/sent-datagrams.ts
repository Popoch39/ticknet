import { ACKNOWLEDGEMENT_SPAN, type Acknowledgement } from "./datagram";

/** The round-trip time and loss rate of one side of a Connection, undefined until measured. */
export interface ConnectionHealth {
  /** Milliseconds, smoothed over recent acknowledgements; undefined before the first one. */
  readonly roundTripTime: number | undefined;
  /**
   * Share of recent connected Datagrams this side sent that the other side
   * did not receive, from 0 to 1; undefined until the fate of one is known.
   */
  readonly lossRate: number | undefined;
}

/** How many of the most recent connected Datagrams sent the loss rate is measured over. */
const LOSS_WINDOW = 256;

/** Weight of each new sample in the smoothed round-trip time, as in TCP. */
const ROUND_TRIP_GAIN = 1 / 8;

const PENDING = 1;
const ACKNOWLEDGED = 2;
/** Left out of an acknowledgement that covered it; acknowledged later if it was only late. */
const MISSED = 3;

/**
 * The connected Datagrams one side sent on a Connection, and what the other
 * side acknowledged of them: the source of the Connection's health.
 */
export class SentDatagrams {
  /** `sequences[n % LOSS_WINDOW]` is the last sequence number n sent in that slot, or -1. */
  readonly #sequences = new Float64Array(LOSS_WINDOW).fill(-1);
  readonly #sentAt = new Float64Array(LOSS_WINDOW);
  readonly #states = new Uint8Array(LOSS_WINDOW);
  #acknowledged = 0;
  #missed = 0;
  #roundTripTime: number | undefined;

  get health(): ConnectionHealth {
    const known = this.#acknowledged + this.#missed;
    return {
      roundTripTime: this.#roundTripTime,
      lossRate: known === 0 ? undefined : this.#missed / known,
    };
  }

  record(sequence: number, now: number): void {
    const slot = sequence % LOSS_WINDOW;
    this.#setState(slot, PENDING);
    this.#sequences[slot] = sequence;
    this.#sentAt[slot] = now;
  }

  /** Takes in an acknowledgement received at `now`. */
  acknowledge({ newest, received, delay }: Acknowledgement, now: number): void {
    // The newest is always among the received ones, unless nothing was received yet.
    if ((received & 1) === 0) return;
    for (let age = 0; age < ACKNOWLEDGEMENT_SPAN && age <= newest; age++) {
      const sequence = newest - age;
      const slot = sequence % LOSS_WINDOW;
      if (this.#sequences[slot] !== sequence) continue;
      const state = this.#states[slot];
      if ((received >>> age) & 1) {
        if (state === ACKNOWLEDGED) continue;
        this.#setState(slot, ACKNOWLEDGED);
        // Only the newest has a known delay; a copy of an acknowledgement finds it already taken.
        if (age === 0)
          this.#sample(Math.max(0, now - (this.#sentAt[slot] ?? 0) - delay));
      } else if (state === PENDING) {
        this.#setState(slot, MISSED);
      }
    }
  }

  #sample(roundTripTime: number): void {
    this.#roundTripTime =
      this.#roundTripTime === undefined
        ? roundTripTime
        : this.#roundTripTime +
          (roundTripTime - this.#roundTripTime) * ROUND_TRIP_GAIN;
  }

  #setState(slot: number, state: number): void {
    const previous = this.#states[slot];
    if (previous === ACKNOWLEDGED) this.#acknowledged--;
    if (previous === MISSED) this.#missed--;
    if (state === ACKNOWLEDGED) this.#acknowledged++;
    if (state === MISSED) this.#missed++;
    this.#states[slot] = state;
  }
}
