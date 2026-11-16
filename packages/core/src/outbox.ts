import {
  encodeDatagram,
  MAX_DATAGRAM_MESSAGE_SIZE,
  packMessages,
  SEQUENCED_SEQUENCE_MASK,
  type MessageEntry,
} from "./datagram";
import type { DeliveryMode } from "./message";

/** Throws a RangeError for a Message body that cannot fit in one Datagram. */
export function assertFitsInDatagram(
  id: number,
  body: Uint8Array,
  delivery: DeliveryMode,
): void {
  if (body.byteLength > MAX_DATAGRAM_MESSAGE_SIZE)
    throw new RangeError(
      `Message id ${id} is ${body.byteLength} bytes once encoded; ${MODE_NAMES[delivery]} Message must fit in one Datagram, which holds at most ${MAX_DATAGRAM_MESSAGE_SIZE} bytes of it`,
    );
}

const MODE_NAMES: Record<DeliveryMode, string> = {
  unreliable: "an Unreliable",
  sequenced: "a Sequenced",
};

/**
 * How long an endpoint with nothing to send on a Connection waits before
 * sending a keepalive, given its own `timeout`: four fit in it, and never
 * more than a second passes, so that a peer with a shorter timeout still
 * hears from it in time.
 */
export function keepaliveInterval(timeout: number): number {
  return Math.min(1000, timeout / 4);
}

/**
 * The Messages one endpoint has sent on a Connection and not yet put on the
 * network. They leave together, in as few Datagrams as possible, when the
 * outbox is flushed. When nothing has left for `keepaliveInterval`
 * milliseconds, a flush puts an empty Datagram on the network all the same,
 * so that the other side does not time out.
 */
export class Outbox {
  readonly #keepaliveInterval: number;
  #lastSent: number;
  #messages: MessageEntry[] = [];
  #sequence = 0;
  /** The sequence number the next Sequenced Message of each type gets, by Message id. */
  readonly #nextSequenced = new Map<number, number>();

  /** `now` counts as the last time something was sent. */
  constructor(keepaliveInterval: number, now: number) {
    this.#keepaliveInterval = keepaliveInterval;
    this.#lastSent = now;
  }

  /** Throws a RangeError, before queuing anything, for a body that cannot fit in one Datagram. */
  push(id: number, body: Uint8Array, delivery: DeliveryMode): void {
    assertFitsInDatagram(id, body, delivery);
    if (delivery === "sequenced") {
      const sequence = this.#nextSequenced.get(id) ?? 0;
      this.#nextSequenced.set(id, (sequence + 1) & SEQUENCED_SEQUENCE_MASK);
      this.#messages.push({ delivery, id, sequence, body });
    } else this.#messages.push({ delivery, id, body });
  }

  /**
   * Empties the outbox, at time `now`, into connected Datagrams stamped with
   * the sender's `tick` and each with the next sequence number; into a single
   * empty one if a keepalive is due.
   */
  flush(tick: number, now: number): Uint8Array[] {
    const groups = packMessages(this.#messages);
    this.#messages = [];
    if (groups.length === 0 && now - this.#lastSent >= this.#keepaliveInterval)
      groups.push([]);
    if (groups.length > 0) this.#lastSent = now;
    return groups.map((messages) =>
      encodeDatagram({
        kind: "connected",
        tick,
        sequence: this.#sequence++,
        messages,
      }),
    );
  }
}
