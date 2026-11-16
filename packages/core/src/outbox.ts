import {
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
 * The Messages one endpoint has sent on a Connection and not yet put on the
 * network. They leave together, in as few Datagrams as possible, when the
 * outbox is taken.
 */
export class Outbox {
  #messages: MessageEntry[] = [];
  /** The sequence number the next Sequenced Message of each type gets, by Message id. */
  readonly #nextSequenced = new Map<number, number>();

  /** Throws a RangeError, before queuing anything, for a body that cannot fit in one Datagram. */
  push(id: number, body: Uint8Array, delivery: DeliveryMode): void {
    assertFitsInDatagram(id, body, delivery);
    if (delivery === "sequenced") {
      const sequence = this.#nextSequenced.get(id) ?? 0;
      this.#nextSequenced.set(id, (sequence + 1) & SEQUENCED_SEQUENCE_MASK);
      this.#messages.push({ delivery, id, sequence, body });
    } else this.#messages.push({ delivery, id, body });
  }

  /** Empties the outbox into the groups of Messages that each fill one connected Datagram. */
  take(): MessageEntry[][] {
    const groups = packMessages(this.#messages);
    this.#messages = [];
    return groups;
  }
}
