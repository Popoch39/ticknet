import {
  encodeDatagram,
  MAX_DATAGRAM_SIZE,
  packMessages,
  PackedSize,
  type ConnectedDatagram,
  type MessageEntry,
} from "./datagram";
import { assertFitsReliableMessage } from "./fragments";
import type { DeliveryMode } from "./message";
import { assertFitsInDatagram, Outbox } from "./outbox";
import { ReceivedSequences } from "./received-sequences";
import { ReliableReceiver, ReliableSender } from "./reliable-stream";
import { SentDatagrams, type ConnectionHealth } from "./sent-datagrams";
import { SequencedOrder } from "./sequenced-order";

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
 * sending a keepalive, given its own timeout and the one the other side told
 * it during the Handshake: four fit in the shorter, so that neither side's
 * timeout runs out on an idle Connection, and never more than a second
 * passes, so that the round-trip time and loss rate stay fresh.
 */
export function keepaliveInterval(
  ownTimeout: number,
  otherTimeout: number,
): number {
  return Math.min(1000, Math.min(ownTimeout, otherTimeout) / 4);
}

/**
 * The Send budget of a Connection when the game sets none, in bytes per Tick
 * (per Send step on the Client): four full Datagrams, about 1.2 Mbit/s at
 * 30 Ticks per second.
 */
export const DEFAULT_SEND_BUDGET = 4 * MAX_DATAGRAM_SIZE;

/** Throws a RangeError for a Send budget that could not carry a full Datagram, or that is not a whole number of bytes. */
export function assertSendBudget(sendBudget: number): void {
  if (!(Number.isInteger(sendBudget) && sendBudget >= MAX_DATAGRAM_SIZE))
    throw new RangeError(
      `The Send budget must be a whole number of bytes, at least ${MAX_DATAGRAM_SIZE} so that a full Datagram fits in it, not ${sendBudget}`,
    );
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
 * the Messages it queued, its Reliable stream each way, the order of the
 * Sequenced Messages it delivered, the connected Datagrams it received, and what the other side acknowledged of those it
 * sent. Every connected Datagram it sends carries an acknowledgement of the
 * most recent ones it received; a keepalive is one without Messages, so the
 * other side keeps acknowledging an idle Connection and its health stays
 * fresh.
 */
export class Link {
  readonly #outbox = new Outbox();
  readonly #reliableOut = new ReliableSender();
  readonly #reliableIn = new ReliableReceiver();
  readonly #sequenced = new SequencedOrder();
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
  /** The most bytes one flush puts on the network. */
  readonly #sendBudget: number;
  /** What the Unreliable and Sequenced Messages queued for the next flush take on the network. */
  #queued = new PackedSize();

  /** `now` counts as the last time something was sent. */
  constructor(keepaliveInterval: number, now: number, sendBudget: number) {
    this.#keepaliveInterval = keepaliveInterval;
    this.#lastSentAt = now;
    this.#sendBudget = sendBudget;
  }

  get health(): ConnectionHealth {
    return this.#sent.health;
  }

  /** Whether more Reliable Messages wait for acknowledgement than MAX_RELIABLE_BACKLOG, so that the Connection must close. */
  get reliableBacklogOverflowed(): boolean {
    return this.#reliableOut.overflowed;
  }

  /**
   * Queues a Message until the next flush; throws a RangeError for one too
   * large to send (see assertSendable). Returns false, queuing nothing, for
   * an Unreliable or Sequenced Message that does not fit in what remains of
   * the Send budget of the next flush.
   */
  send(id: number, body: Uint8Array, delivery: DeliveryMode): boolean {
    if (delivery === "reliable") {
      this.#reliableOut.push(id, body);
      return true;
    }
    assertFitsInDatagram(id, body, delivery);
    // Room is kept for the Reliable Messages already due, so that sending these cannot starve them.
    if (
      this.#queued.with({ delivery, body }) + this.#reliableOut.waiting >
      this.#sendBudget
    )
      return false;
    this.#outbox.push(id, body, delivery);
    this.#queued.add({ delivery, body });
    return true;
  }

  /**
   * Takes in a connected Datagram received at `now`. Returns the Messages
   * to deliver, in order, or undefined for a copy of a Datagram already
   * received. A Reliable Message that arrives ahead of one still missing is
   * held back and returned behind it once it arrives; a Sequenced Message
   * older than one of its type already delivered is left out.
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
    return datagram.messages
      .flatMap<MessageEntry>((message) =>
        message.delivery === "reliable"
          ? this.#reliableIn.receive(message)
          : [message],
      )
      .filter((message) => this.#sequenced.admit(message));
  }

  /**
   * Empties the queue into connected Datagrams sent at `now`, stamped with
   * the sender's `tick`, along with as many of the Reliable Messages due (to
   * be sent again, or not sent yet) as the rest of the Send budget allows;
   * those left out stay due, and Unreliable or Sequenced Messages queued
   * before the next flush leave room for them. With nothing to send, sends
   * one without Messages, well within any budget, if an
   * acknowledgement is due, or as a keepalive if nothing left for the
   * keepalive interval.
   */
  flush(tick: number, now: number): Uint8Array[] {
    // The queued Messages were admitted against the budget, so the Reliable stream gets what they leave.
    const groups = packMessages([
      ...this.#reliableOut.take(
        now,
        this.#sent.resendDelay,
        this.#sendBudget - this.#queued.bytes,
      ),
      ...this.#outbox.take(),
    ]);
    this.#queued = new PackedSize();
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
