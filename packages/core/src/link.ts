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
 * How long an endpoint with nothing to send on a Connection waits before
 * sending a keepalive, given its own `timeout`: four fit in it, and never
 * more than a second passes, so that a peer with a shorter timeout still
 * hears from it in time.
 */
export function keepaliveInterval(timeout: number): number {
  return Math.min(1000, timeout / 4);
}

/**
 * One side of an open Connection, the same on the Server and the Client:
 * the Messages it queued, the connected Datagrams it received, and what the
 * other side acknowledged of those it sent. Every connected Datagram it
 * sends carries an acknowledgement of the most recent ones it received; a
 * keepalive is one without Messages, so the other side keeps acknowledging
 * an idle Connection and its health stays fresh.
 */
export class Link {
  readonly #outbox = new Outbox();
  readonly #received = new ReceivedSequences();
  readonly #sent = new SentDatagrams();
  readonly #keepaliveInterval: number;
  #sequence = 0;
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
   * an acknowledgement is due, or as a keepalive if nothing left for the
   * keepalive interval.
   */
  flush(tick: number, now: number): Uint8Array[] {
    const groups = this.#outbox.take();
    if (
      groups.length === 0 &&
      (this.#acknowledgementDue ||
        now - this.#lastSentAt >= this.#keepaliveInterval)
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
