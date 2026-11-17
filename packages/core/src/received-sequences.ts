import {
  ACKNOWLEDGEMENT_SPAN,
  sequenceDistance,
  type Acknowledgement,
} from "./datagram";

/**
 * How far behind the newest sequence number a Datagram can be and still be
 * told apart from a copy. Anything older is dropped: it may be lost anyway.
 */
const WINDOW = 1024;

/**
 * The sequence numbers of the connected Datagrams received on one Connection,
 * so that a duplicated Datagram never delivers its Messages twice, and so
 * that the other side can be told what arrived.
 */
export class ReceivedSequences {
  #newest: number | undefined;
  #newestAt = 0;
  /** `slots[n % WINDOW]` is the last sequence number n received in that slot, or -1. */
  readonly #slots = new Float64Array(WINDOW).fill(-1);

  /** Records `sequence`, received at `now`; false if it was already received or is too old to tell. */
  accept(sequence: number, now: number): boolean {
    if (
      this.#newest !== undefined &&
      sequenceDistance(this.#newest, sequence) >= WINDOW
    )
      return false;
    // WINDOW divides 2^32, so slots follow each other across the wrap too.
    const slot = sequence % WINDOW;
    // A slot is overwritten only by a sequence number WINDOW or more newer, which puts the old one out of the window.
    if (this.#slots[slot] === sequence) return false;
    this.#slots[slot] = sequence;
    if (
      this.#newest === undefined ||
      sequenceDistance(sequence, this.#newest) > 0
    ) {
      this.#newest = sequence;
      this.#newestAt = now;
    }
    return true;
  }

  /** What to tell the other side, in a Datagram sent at `now`, about the most recent sequence numbers received. */
  acknowledgement(now: number): Acknowledgement {
    const newest = this.#newest;
    if (newest === undefined) return { newest: 0, received: 0, delay: 0 };
    let received = 0;
    for (let age = 0; age < ACKNOWLEDGEMENT_SPAN; age++) {
      const sequence = (newest - age) >>> 0;
      if (this.#slots[sequence % WINDOW] === sequence) received |= 1 << age;
    }
    return { newest, received: received >>> 0, delay: now - this.#newestAt };
  }
}
