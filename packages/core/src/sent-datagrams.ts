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

/**
 * How many of the most recent connected Datagrams sent are tracked: an
 * acknowledgement of an older one goes unnoticed, and the loss rate is
 * measured over them.
 */
export const TRACKED_DATAGRAMS = 256;

/** Weight of each new sample in the smoothed round-trip time, as in TCP. */
const ROUND_TRIP_GAIN = 1 / 8;

/** Weight of each new sample in the round-trip time's variation, as in TCP. */
const VARIATION_GAIN = 1 / 4;

/** Milliseconds to wait before resending until the round-trip time is measured, as TCP's first retransmission timeout. */
const INITIAL_RESEND_DELAY = 1000;

/** The least margin added to the round-trip time before resending, so that a steady link's jitter of a millisecond or two causes no resend. */
const MIN_RESEND_MARGIN = 10;

const PENDING = 1;
const ACKNOWLEDGED = 2;
/** Left out of an acknowledgement that covered it; acknowledged later if it was only late. */
const MISSED = 3;

/**
 * The connected Datagrams one side sent on a Connection, and what the other
 * side acknowledged of them: the source of the Connection's health.
 */
export class SentDatagrams {
  /** `sequences[n % TRACKED_DATAGRAMS]` is the last sequence number n sent in that slot, or -1. */
  readonly #sequences = new Float64Array(TRACKED_DATAGRAMS).fill(-1);
  readonly #sentAt = new Float64Array(TRACKED_DATAGRAMS);
  readonly #states = new Uint8Array(TRACKED_DATAGRAMS);
  /** 1 for a Datagram carrying Messages, which the other side acknowledges at its next Tick or Send step. */
  readonly #carriesMessages = new Uint8Array(TRACKED_DATAGRAMS);
  #acknowledged = 0;
  #missed = 0;
  #roundTripTime: number | undefined;
  #roundTripVariation = 0;
  /**
   * How long the other side waits before acknowledging a Datagram carrying
   * Messages, as it reports: it jumps to any longer wait at once, so that
   * resends do not come early, and slowly forgets one not repeated (a
   * stall of the other side, say), so that they do not stay late.
   */
  #acknowledgementDelay = 0;

  get health(): ConnectionHealth {
    const known = this.#acknowledged + this.#missed;
    return {
      roundTripTime: this.#roundTripTime,
      lossRate: known === 0 ? undefined : this.#missed / known,
    };
  }

  /**
   * Milliseconds to wait for the acknowledgement of a Datagram carrying
   * Messages before sending them again: the round-trip time and four times
   * its variation, as TCP's retransmission timeout, plus the other side's
   * wait before acknowledging, which the round-trip time leaves out.
   */
  get resendDelay(): number {
    if (this.#roundTripTime === undefined) return INITIAL_RESEND_DELAY;
    return (
      this.#roundTripTime +
      Math.max(4 * this.#roundTripVariation, MIN_RESEND_MARGIN) +
      this.#acknowledgementDelay
    );
  }

  record(sequence: number, now: number, carriesMessages: boolean): void {
    const slot = sequence % TRACKED_DATAGRAMS;
    this.#setState(slot, PENDING);
    this.#sequences[slot] = sequence;
    this.#sentAt[slot] = now;
    this.#carriesMessages[slot] = carriesMessages ? 1 : 0;
  }

  /**
   * Takes in an acknowledgement received at `now`. Returns the sequence
   * numbers it acknowledges for the first time.
   */
  acknowledge(
    { newest, received, delay }: Acknowledgement,
    now: number,
  ): number[] {
    const acknowledged: number[] = [];
    // The newest is always among the received ones, unless nothing was received yet.
    if ((received & 1) === 0) return acknowledged;
    for (let age = 0; age < ACKNOWLEDGEMENT_SPAN; age++) {
      const sequence = (newest - age) >>> 0;
      // TRACKED_DATAGRAMS divides 2^32, so slots follow each other across the wrap too.
      const slot = sequence % TRACKED_DATAGRAMS;
      if (this.#sequences[slot] !== sequence) continue;
      const state = this.#states[slot];
      if ((received >>> age) & 1) {
        if (state === ACKNOWLEDGED) continue;
        this.#setState(slot, ACKNOWLEDGED);
        acknowledged.push(sequence);
        // Only the newest has a known delay; a copy of an acknowledgement finds it already taken.
        if (age === 0) {
          this.#sample(Math.max(0, now - (this.#sentAt[slot] ?? 0) - delay));
          if (this.#carriesMessages[slot])
            this.#acknowledgementDelay = Math.max(
              delay,
              this.#acknowledgementDelay +
                (delay - this.#acknowledgementDelay) * ROUND_TRIP_GAIN,
            );
        }
      } else if (state === PENDING) {
        this.#setState(slot, MISSED);
      }
    }
    return acknowledged;
  }

  #sample(roundTripTime: number): void {
    if (this.#roundTripTime === undefined) {
      this.#roundTripTime = roundTripTime;
      this.#roundTripVariation = roundTripTime / 2;
      return;
    }
    this.#roundTripVariation +=
      (Math.abs(roundTripTime - this.#roundTripTime) -
        this.#roundTripVariation) *
      VARIATION_GAIN;
    this.#roundTripTime +=
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
