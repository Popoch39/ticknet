import {
  encodeDatagram,
  MAX_DATAGRAM_MESSAGE_SIZE,
  packMessages,
  type MessageEntry,
} from "./datagram";
import type { DeliveryMode } from "./message";

/** Throws a RangeError for a Message body that cannot fit in one Datagram. */
export function assertFitsInDatagram(id: number, body: Uint8Array): void {
  if (body.byteLength > MAX_DATAGRAM_MESSAGE_SIZE)
    throw new RangeError(
      `Message id ${id} is ${body.byteLength} bytes once encoded; an Unreliable Message must fit in one Datagram, which holds at most ${MAX_DATAGRAM_MESSAGE_SIZE} bytes of it`,
    );
}

/**
 * The Messages one endpoint has sent on a Connection and not yet put on the
 * network. They leave together, in as few Datagrams as possible, when the
 * outbox is flushed.
 */
export class Outbox {
  #messages: MessageEntry[] = [];

  /** Throws a RangeError, before queuing anything, for a body that cannot fit in one Datagram. */
  push(id: number, body: Uint8Array, delivery: DeliveryMode): void {
    assertFitsInDatagram(id, body);
    this.#messages.push({ delivery, id, body });
  }

  /** Empties the outbox into connected Datagrams stamped with the sender's `tick`. */
  flush(tick: number): Uint8Array[] {
    const groups = packMessages(this.#messages);
    this.#messages = [];
    return groups.map((messages) =>
      encodeDatagram({ kind: "connected", tick, messages }),
    );
  }
}
