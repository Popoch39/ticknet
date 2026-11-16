/**
 * How far behind the newest sequence number a Datagram can be and still be
 * told apart from a copy. Anything older is dropped: it may be lost anyway.
 */
const WINDOW = 1024;

/**
 * The sequence numbers of the connected Datagrams received on one Connection,
 * so that a duplicated Datagram never delivers its Messages twice.
 */
export class ReceivedSequences {
  #newest: number | undefined;
  /** `slots[n % WINDOW]` is the last sequence number n received in that slot, or -1. */
  readonly #slots = new Float64Array(WINDOW).fill(-1);

  /** Records `sequence`; false if it was already received or is too old to tell. */
  accept(sequence: number): boolean {
    if (this.#newest !== undefined && sequence <= this.#newest - WINDOW)
      return false;
    const slot = sequence % WINDOW;
    // A slot is overwritten only by a sequence number WINDOW or more newer, which puts the old one out of the window.
    if (this.#slots[slot] === sequence) return false;
    this.#slots[slot] = sequence;
    if (this.#newest === undefined || sequence > this.#newest)
      this.#newest = sequence;
    return true;
  }
}
