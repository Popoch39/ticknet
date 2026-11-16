import { Cadence } from "./cadence";
import { Challenger } from "./challenge";
import {
  CLIENT_HANDSHAKE_SIZE,
  decodeDatagram,
  encodeDatagram,
} from "./datagram";
import type { Engine } from "./engine";
import type { DeliveryMode } from "./message";
import { assertFitsInDatagram, Outbox } from "./outbox";
import { addressKey, type Address, type OutgoingDatagram } from "./transport";

/** Identifies a Connection within one Server; never reused. */
export type ConnectionId = number;

export type ServerEvent =
  | {
      readonly type: "connectionOpened";
      readonly connection: ConnectionId;
      readonly address: Address;
    }
  | { readonly type: "tick"; readonly tick: number }
  | {
      readonly type: "message";
      readonly connection: ConnectionId;
      readonly id: number;
      readonly body: Uint8Array;
    };

export interface ServerEngineConfig {
  /** 16 random bytes keying the Handshake challenges; never sent. */
  readonly secret: Uint8Array;
  /** How many Ticks the Server runs per second. */
  readonly tickRate: number;
}

interface OpenConnection {
  readonly id: ConnectionId;
  readonly address: Address;
  readonly outbox: Outbox;
}

/**
 * The Server side of the protocol. An address gets a Connection only once it
 * has echoed a challenge, which proves the Client receives at that address;
 * until then the Server keeps nothing about it.
 *
 * The Server runs Ticks at a fixed rate, numbered from 1. Messages sent to a
 * Connection are queued and leave together when the current Tick ends. A Tick
 * ends once its `tick` event has been handled, that is at the first
 * `pollDatagrams` after the `pollEvents` that returned it, so that whatever
 * the game sends while handling it leaves with it.
 */
export class ServerEngine implements Engine<ServerEvent> {
  readonly #challenger: Challenger;
  readonly #ticks: Cadence;
  readonly #byAddress = new Map<string, OpenConnection>();
  readonly #byId = new Map<ConnectionId, OpenConnection>();
  #nextConnectionId: ConnectionId = 1;
  #tick = 0;
  #tickState: "between" | "started" | "ending" = "between";
  #datagrams: OutgoingDatagram[] = [];
  #events: ServerEvent[] = [];

  constructor(config: ServerEngineConfig, now: number) {
    this.#challenger = new Challenger(config.secret);
    this.#ticks = new Cadence(now, config.tickRate, "Tick rate");
  }

  /** Queues a Message until the end of the Tick; throws if it can never be sent. */
  send(
    connection: ConnectionId,
    id: number,
    body: Uint8Array,
    delivery: DeliveryMode,
  ): void {
    const open = this.#byId.get(connection);
    if (!open) throw new Error(`There is no open Connection ${connection}`);
    open.outbox.push(id, body, delivery);
  }

  /** Queues a Message to every open Connection; throws, sending to none, if it can never be sent. */
  broadcast(id: number, body: Uint8Array, delivery: DeliveryMode): void {
    assertFitsInDatagram(id, body);
    for (const open of this.#byId.values())
      open.outbox.push(id, body, delivery);
  }

  receive(data: Uint8Array, from: Address, now: number): void {
    const datagram = decodeDatagram(data);
    switch (datagram?.kind) {
      case "otherVersion":
        // Only what has the size of a Client's first Datagram in every version gets an answer, so that
        // stray bytes on the port go unanswered.
        if (data.byteLength === CLIENT_HANDSHAKE_SIZE) {
          this.#answerUnproven(
            from,
            encodeDatagram({
              kind: "refused",
              reason: { kind: "versionMismatch" },
            }),
            data,
          );
        }
        break;
      case "connectRequest":
        this.#answerUnproven(
          from,
          encodeDatagram({
            kind: "challenge",
            challenge: this.#challenger.issue(from, now),
          }),
          data,
        );
        break;
      case "challengeResponse":
        if (this.#challenger.verify(datagram.challenge, from, now))
          this.#accept(from);
        break;
      case "connected": {
        const open = this.#byAddress.get(addressKey(from));
        if (!open) break;
        for (const { id, body } of datagram.messages)
          this.#events.push({
            type: "message",
            connection: open.id,
            id,
            body,
          });
        break;
      }
    }
  }

  advance(now: number): void {
    // One Tick per call, so that each one is handled and flushed before the next starts.
    if (this.#tickState === "between" && now >= this.#ticks.next) {
      this.#ticks.step();
      this.#tick++;
      this.#tickState = "started";
      this.#events.push({ type: "tick", tick: this.#tick });
    }
  }

  nextDeadline(): number | undefined {
    return this.#ticks.next;
  }

  pollDatagrams(): OutgoingDatagram[] {
    if (this.#tickState === "ending") {
      this.#tickState = "between";
      for (const open of this.#byId.values())
        for (const data of open.outbox.flush(this.#tick))
          this.#datagrams.push({ to: open.address, data });
    }
    const datagrams = this.#datagrams;
    this.#datagrams = [];
    return datagrams;
  }

  pollEvents(): ServerEvent[] {
    if (this.#tickState === "started") this.#tickState = "ending";
    const events = this.#events;
    this.#events = [];
    return events;
  }

  #accept(from: Address): void {
    const key = addressKey(from);
    // A repeated echo means the acceptance was lost: answer again, without a second Connection.
    if (!this.#byAddress.has(key)) {
      const open = {
        id: this.#nextConnectionId++,
        address: from,
        outbox: new Outbox(),
      };
      this.#byAddress.set(key, open);
      this.#byId.set(open.id, open);
      this.#events.push({
        type: "connectionOpened",
        connection: open.id,
        address: from,
      });
    }
    this.#send(from, encodeDatagram({ kind: "accepted" }));
  }

  /**
   * Answers an address that may be spoofed. The answer is never larger than
   * what triggered it, so that the Server cannot be used to amplify an attack.
   */
  #answerUnproven(to: Address, answer: Uint8Array, trigger: Uint8Array): void {
    if (answer.byteLength <= trigger.byteLength) this.#send(to, answer);
  }

  #send(to: Address, data: Uint8Array): void {
    this.#datagrams.push({ to, data });
  }
}
