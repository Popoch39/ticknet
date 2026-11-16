import {
  encodeDatagram,
  type ConnectedDatagram,
  type MessageEntry,
} from "./datagram";
import type { DeliveryMode } from "./message";
import { Outbox } from "./outbox";
import { ReceivedSequences } from "./received-sequences";
import { SentDatagrams, type ConnectionHealth } from "./sent-datagrams";

/**
 * Milliseconds after which a side with nothing to send still sends a
 * Datagram, so that the other side keeps acknowledging it: the health of an
 * idle Connection stays fresh.
 */
export const KEEPALIVE_INTERVAL = 1000;

/**
 * One side of an open Connection, the same on the Server and the Client:
 * the Messages it queued, the connected Datagrams it received, and what the
 * other side acknowledged of those it sent. Every connected Datagram it
 * sends carries an acknowledgement of the most recent ones it received.
 */
export class Link {
  readonly #outbox = new Outbox();
  readonly #received = new ReceivedSequences();
  readonly #sent = new SentDatagrams();
  #sequence = 0;
  /**
   * Messages arrived since the last Datagram left, so the next flush sends
   * one even with nothing queued. A Datagram without Messages does not ask
   * for one, or two quiet sides would acknowledge each other forever.
   */
  #acknowledgementDue = false;
  /** When the last Datagram left; undefined until the first flush, which starts the count. */
  #lastSentAt: number | undefined;

  get health(): ConnectionHealth {
    return this.#sent.health;
  }

  /** Queues a Message until the next flush; throws a RangeError if it can never fit in one Datagram. */
  send(id: number, body: Uint8Array, delivery: DeliveryMode): void {
    this.#outbox.push(id, body, delivery);
  }

  /**
   * Takes in a connected Datagram received at `now`. Returns its Messages,
   * or undefined for a copy of one already received.
   */
  receive(
    datagram: ConnectedDatagram,
    now: number,
  ): readonly MessageEntry[] | undefined {
    if (!this.#received.accept(datagram.sequence, now)) return undefined;
    this.#sent.acknowledge(datagram.acknowledgement, now);
    if (datagram.messages.length > 0) this.#acknowledgementDue = true;
    return datagram.messages;
  }

  /**
   * Empties the queue into connected Datagrams sent at `now`, stamped with
   * the sender's `tick`. With nothing queued, sends one without Messages if
   * an acknowledgement is due, or as a keepalive if nothing left for
   * KEEPALIVE_INTERVAL.
   */
  flush(tick: number, now: number): Uint8Array[] {
    this.#lastSentAt ??= now;
    const groups = this.#outbox.take();
    if (
      groups.length === 0 &&
      (this.#acknowledgementDue || now - this.#lastSentAt >= KEEPALIVE_INTERVAL)
    )
      groups.push([]);
    this.#acknowledgementDue = false;
    if (groups.length > 0) this.#lastSentAt = now;
    return groups.map((messages) => {
      const sequence = this.#sequence++;
      this.#sent.record(sequence, now);
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
