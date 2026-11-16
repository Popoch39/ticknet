import { Cadence } from "./cadence";
import type { CloseReason } from "./close-reason";
import {
  decodeDatagram,
  encodeDatagram,
  MAX_AUTH_TOKEN_SIZE,
} from "./datagram";
import type { Engine } from "./engine";
import type { DeliveryMode } from "./message";
import { Outbox } from "./outbox";
import { addressKey, type Address, type OutgoingDatagram } from "./transport";

export type ClientEvent =
  | { readonly type: "connectionOpened" }
  | { readonly type: "connectionClosed"; readonly reason: CloseReason }
  | {
      readonly type: "message";
      readonly id: number;
      readonly body: Uint8Array;
    };

export interface ClientEngineConfig {
  readonly server: Address;
  /** Milliseconds the Handshake may take before the attempt closes with a timeout reason. */
  readonly timeout: number;
  /** How many times per second the Client puts its queued Messages on the network. */
  readonly sendRate: number;
  /** Opaque bytes for the Server's authentication callback; at most MAX_AUTH_TOKEN_SIZE. */
  readonly authToken?: Uint8Array;
}

/**
 * The Client side of the protocol, for one attempt to connect to one Server:
 * it starts the Handshake as soon as it is created. Once connected, Messages
 * sent are queued and leave together at each step of the send rate.
 */
export class ClientEngine implements Engine<ClientEvent> {
  readonly #server: Address;
  readonly #handshakeDeadline: number;
  readonly #authToken: Uint8Array;
  readonly #sendSteps: Cadence;
  #state: "requesting" | "echoing" | "connected" | "closed" = "requesting";
  readonly #outbox = new Outbox();
  /** Send steps taken since the Connection opened; stamped on Datagrams as the Client's Tick number. */
  #step = 0;
  #lastServerTick: number | undefined;
  #datagrams: OutgoingDatagram[] = [];
  #events: ClientEvent[] = [];

  /** Throws a RangeError, before sending anything, if the Auth token cannot fit in the Handshake. */
  constructor(config: ClientEngineConfig, now: number) {
    const authToken = config.authToken ?? new Uint8Array(0);
    if (authToken.byteLength > MAX_AUTH_TOKEN_SIZE)
      throw new RangeError(
        `The Auth token is ${authToken.byteLength} bytes long, but at most ${MAX_AUTH_TOKEN_SIZE} fit in the Handshake`,
      );
    // Copied so that the caller may reuse its buffer before the challenge arrives.
    this.#authToken = authToken.slice();
    this.#server = config.server;
    this.#handshakeDeadline = now + config.timeout;
    this.#sendSteps = new Cadence(now, config.sendRate, "send rate");
    this.#datagrams.push({
      to: config.server,
      data: encodeDatagram({ kind: "connectRequest" }),
    });
  }

  /** The highest Tick number found on a Datagram from the Server, if any arrived. */
  get lastServerTick(): number | undefined {
    return this.#lastServerTick;
  }

  /** Queues a Message until the next send step; throws if it can never be sent. */
  send(id: number, body: Uint8Array, delivery: DeliveryMode): void {
    if (this.#state !== "connected")
      throw new Error("The Client can only send once it is connected");
    this.#outbox.push(id, body, delivery);
  }

  receive(data: Uint8Array, from: Address, now: number): void {
    if (addressKey(from) !== addressKey(this.#server)) return;
    if (this.#state === "closed") return;
    const datagram = decodeDatagram(data);
    switch (datagram?.kind) {
      case "otherVersion":
        if (this.#inHandshake()) this.#close({ kind: "versionMismatch" });
        break;
      case "challenge":
        if (this.#state !== "requesting") break;
        this.#state = "echoing";
        this.#datagrams.push({
          to: this.#server,
          data: encodeDatagram({
            kind: "challengeResponse",
            challenge: datagram.challenge,
            authToken: this.#authToken,
          }),
        });
        break;
      case "accepted":
        if (this.#state !== "echoing") break;
        this.#state = "connected";
        this.#sendSteps.skipPast(now);
        this.#events.push({ type: "connectionOpened" });
        break;
      case "refused":
        if (this.#inHandshake()) this.#close(datagram.reason);
        break;
      case "connected":
        if (this.#state !== "connected") break;
        if (
          this.#lastServerTick === undefined ||
          datagram.tick > this.#lastServerTick
        )
          this.#lastServerTick = datagram.tick;
        for (const { id, body } of datagram.messages)
          this.#events.push({ type: "message", id, body });
        break;
    }
  }

  advance(now: number): void {
    if (this.#inHandshake() && now >= this.#handshakeDeadline)
      this.#close({ kind: "timeout" });
    if (this.#state === "connected" && now >= this.#sendSteps.next) {
      this.#step++;
      for (const data of this.#outbox.flush(this.#step))
        this.#datagrams.push({ to: this.#server, data });
      // A late wake-up takes one step, not one per interval missed: a single flush covers them all.
      this.#sendSteps.skipPast(now);
    }
  }

  nextDeadline(): number | undefined {
    if (this.#inHandshake()) return this.#handshakeDeadline;
    if (this.#state === "connected") return this.#sendSteps.next;
    return undefined;
  }

  pollDatagrams(): OutgoingDatagram[] {
    const datagrams = this.#datagrams;
    this.#datagrams = [];
    return datagrams;
  }

  pollEvents(): ClientEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  #inHandshake(): boolean {
    return this.#state === "requesting" || this.#state === "echoing";
  }

  #close(reason: CloseReason): void {
    this.#state = "closed";
    this.#events.push({ type: "connectionClosed", reason });
  }
}
