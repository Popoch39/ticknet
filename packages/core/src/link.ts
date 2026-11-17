import {
  encodeDatagram,
  packMessages,
  type ConnectedDatagram,
  type MessageEntry,
} from "./datagram";
import { assertFitsReliableMessage } from "./fragments";
import type { DeliveryMode } from "./message";
import { assertFitsInDatagram, Outbox } from "./outbox";
import { ReceivedSequences } from "./received-sequences";
import { ReliableReceiver, ReliableSender } from "./reliable-stream";
import { SentDatagrams, type ConnectionHealth } from "./sent-datagrams";

/**
 * Throws a RangeError for a Message body too large to be sent with
 * `delivery`: over one Datagram for an Unreliable or Sequenced Message, which
 * is never fragmented, over MAX_RELIABLE_MESSAGE_SIZE for a Reliable one.
 */
export function assertSendable(
  id: number,
  body: Uint8Array,
  delivery: DeliveryMode,
): void {
  if (delivery === "reliable") assertFitsReliableMessage(id, body);
  else assertFitsInDatagram(id, body, delivery);
}

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
 * The sequence number of the first connected Datagram each side of a
 * Connection sends. They count modulo 2^32, a wrap that would take years to
 * reach from 0; starting this close to it makes every Connection that lasts a
 * few minutes cross it, so that wrap-around is exercised all the time rather
 * than almost never (Linux starts its jiffies counter short of its wrap for
 * the same reason).
 */
const FIRST_DATAGRAM_SEQUENCE = 2 ** 32 - 4096;

/**
 * One side of an open Connection, the same on the Server and the Client:
 * the Messages it queued, its Reliable stream each way, the connected
 * Datagrams it received, and what the other side acknowledged of those it
 * sent. Every connected Datagram it sends carries an acknowledgement of the
 * most recent ones it received; a keepalive is one without Messages, so the
 * other side keeps acknowledging an idle Connection and its health stays
 * fresh.
 */
export class Link {
  readonly #outbox = new Outbox();
  readonly #reliableOut = new ReliableSender();
  readonly #reliableIn = new ReliableReceiver();
  readonly #received = new ReceivedSequences();
  readonly #sent = new SentDatagrams();
  readonly #keepaliveInterval: number;
  #sequence = FIRST_DATAGRAM_SEQUENCE;
  /**
   * Messages arrived since the last Datagram left, so the next flush sends
   * one even with nothing queued. A Datagram without Messages does not ask
   * for one, or two quiet sides would acknowledge each other forever.
   */
  #acknowledgementDue = false;
  #lastSentAt: number;

  /** `now` counts as the last time something was sent. */
  constructor(keepaliveInterval: number, now: number) {
    this.#keepaliveInterval = keepaliveInterval;
    this.#lastSentAt = now;
  }

  get health(): ConnectionHealth {
    return this.#sent.health;
  }

  /** Whether more Reliable Messages wait for acknowledgement than MAX_RELIABLE_BACKLOG, so that the Connection must close. */
  get reliableBacklogOverflowed(): boolean {
    return this.#reliableOut.overflowed;
  }

  /** Queues a Message until the next flush; throws a RangeError for one too large to send (see assertSendable). */
  send(id: number, body: Uint8Array, delivery: DeliveryMode): void {
    if (delivery === "reliable") this.#reliableOut.push(id, body);
    else this.#outbox.push(id, body, delivery);
  }

  /**
   * Takes in a connected Datagram received at `now`. Returns the Messages
   * to deliver, in order, or undefined for a copy of a Datagram already
   * received. A Reliable Message that arrives ahead of one still missing is
   * held back and returned behind it once it arrives.
   */
  receive(
    datagram: ConnectedDatagram,
    now: number,
  ): readonly MessageEntry[] | undefined {
    if (!this.#received.accept(datagram.sequence, now)) return undefined;
    for (const sequence of this.#sent.acknowledge(
      datagram.acknowledgement,
      now,
    ))
      this.#reliableOut.acknowledge(sequence);
    if (datagram.messages.length > 0) this.#acknowledgementDue = true;
    return datagram.messages.flatMap<MessageEntry>((message) =>
      message.delivery === "reliable"
        ? this.#reliableIn.receive(message)
        : [message],
    );
  }

  /**
   * Empties the queue into connected Datagrams sent at `now`, stamped with
   * the sender's `tick`, along with the Reliable Messages due to be sent
   * again. With nothing to send, sends one without Messages if an
   * acknowledgement is due, or as a keepalive if nothing left for the
   * keepalive interval.
   */
  flush(tick: number, now: number): Uint8Array[] {
    const groups = packMessages([
      ...this.#reliableOut.take(now, this.#sent.resendDelay),
      ...this.#outbox.take(),
    ]);
    if (
      groups.length === 0 &&
      (this.#acknowledgementDue ||
        now - this.#lastSentAt >= this.#keepaliveInterval)
    )
      groups.push([]);
    this.#acknowledgementDue = false;
    if (groups.length > 0) this.#lastSentAt = now;
    return groups.map((messages) => {
      const sequence = this.#sequence;
      this.#sequence = (sequence + 1) >>> 0;
      this.#sent.record(sequence, now, messages.length > 0);
      this.#reliableOut.sent(sequence, messages);
      return encodeDatagram({
        kind: "connected",
        tick,
        sequence,
        acknowledgement: this.#received.acknowledgement(now),
        messages,
      });
    });
  }
}
