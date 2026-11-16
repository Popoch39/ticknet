import { isNewer, type MessageEntry } from "./datagram";

/**
 * The newest Sequenced Message of each type delivered on one Connection, so
 * that one arriving after a newer Message of its type is dropped. Each type
 * keeps its own order: a newer Message of another type drops nothing.
 */
export class SequencedOrder {
  /** The sequence number of the newest Sequenced Message delivered, by Message id. */
  readonly #newest = new Map<number, number>();

  /**
   * Whether a received Message is to be delivered: always for another
   * Delivery mode; for a Sequenced Message, only when it is newer than every
   * one of its type delivered so far, which it then becomes.
   */
  admit(message: MessageEntry): boolean {
    if (message.delivery !== "sequenced") return true;
    const newest = this.#newest.get(message.id);
    if (newest !== undefined && !isNewer(message.sequence, newest))
      return false;
    this.#newest.set(message.id, message.sequence);
    return true;
  }
}
