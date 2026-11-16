import { Cadence } from "./cadence";
import type { CloseReason } from "./close-reason";
import {
  decodeDatagram,
  encodeDatagram,
  MAX_AUTH_TOKEN_SIZE,
} from "./datagram";
import type { Engine } from "./engine";
import type { DeliveryMode } from "./message";
import { keepaliveInterval, Link } from "./link";
import type { ConnectionHealth } from "./sent-datagrams";
import { SequencedOrder } from "./sequenced-order";
import { addressKey, type Address, type OutgoingDatagram } from "./transport";

export type ClientEvent =
  | { readonly type: "connectionOpened" }
  | { readonly type: "connectionClosed"; readonly reason: CloseReason }
  | {
      readonly type: "message";
      readonly id: number;
      readonly body: Uint8Array;
    };

/**
 * Milliseconds between two copies of an unanswered Handshake Datagram, so
 * that a lost one only delays the Handshake.
 */
const HANDSHAKE_RESEND_INTERVAL = 100;

export interface ClientEngineConfig {
  readonly server: Address;
  /**
   * Milliseconds the Handshake may take, and then that may pass without
   * anything from the Server, before the Client closes with a timeout reason.
   */
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
  readonly #timeout: number;
  readonly #handshakeDeadline: number;
  /** Once connected, when the Connection times out unless something arrives from the Server. */
  #silenceDeadline = Infinity;
  readonly #authToken: Uint8Array;
  readonly #sendSteps: Cadence;
  #state: "requesting" | "echoing" | "connected" | "closed" = "requesting";
  #closeReason: CloseReason | undefined;
  /** The Handshake Datagram of the current step, sent again until the Server answers it. */
  #handshakeDatagram: Uint8Array;
  #handshakeResendAt: number;
  readonly #link: Link;
  readonly #sequenced = new SequencedOrder();
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
    this.#timeout = config.timeout;
    this.#link = new Link(keepaliveInterval(config.timeout), now);
    this.#handshakeDeadline = now + config.timeout;
    this.#sendSteps = new Cadence(now, config.sendRate, "send rate");
    this.#handshakeDatagram = encodeDatagram({ kind: "connectRequest" });
    this.#handshakeResendAt = now + HANDSHAKE_RESEND_INTERVAL;
    this.#datagrams.push({ to: config.server, data: this.#handshakeDatagram });
  }

  /** The highest Tick number found on a Datagram from the Server, if any arrived. */
  get lastServerTick(): number | undefined {
    return this.#lastServerTick;
  }

  /** The round-trip time and loss rate measured on the link to the Server. */
  get health(): ConnectionHealth {
    return this.#link.health;
  }

  /** Queues a Message until the next send step; throws if it can never be sent. */
  send(id: number, body: Uint8Array, delivery: DeliveryMode): void {
    if (this.#closeReason)
      throw new Error(
        `The Connection is closed (${this.#closeReason.kind}); nothing more can be sent on it`,
      );
    if (this.#state !== "connected")
      throw new Error("The Client can only send once it is connected");
    this.#link.send(id, body, delivery);
  }

  /**
   * Leaves the Server on purpose, telling it so; what is still queued is
   * dropped. Does nothing once the attempt or the Connection has closed.
   */
  close(): void {
    if (this.#state === "closed") return;
    if (this.#state === "connected")
      this.#datagrams.push({
        to: this.#server,
        data: encodeDatagram({
          kind: "close",
          reason: { kind: "closedByClient" },
        }),
      });
    this.#close({ kind: "closedByClient" });
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
        this.#sendHandshake(
          encodeDatagram({
            kind: "challengeResponse",
            challenge: datagram.challenge,
            authToken: this.#authToken,
          }),
          now,
        );
        break;
      case "accepted":
        if (this.#state !== "echoing") break;
        this.#state = "connected";
        this.#silenceDeadline = now + this.#timeout;
        this.#sendSteps.skipPast(now);
        this.#events.push({ type: "connectionOpened" });
        break;
      case "refused":
        if (this.#inHandshake()) this.#close(datagram.reason);
        break;
      case "connected": {
        if (this.#state !== "connected") break;
        const messages = this.#link.receive(datagram, now);
        if (!messages) break;
        this.#silenceDeadline = now + this.#timeout;
        if (
          this.#lastServerTick === undefined ||
          datagram.tick > this.#lastServerTick
        )
          this.#lastServerTick = datagram.tick;
        for (const message of messages)
          if (this.#sequenced.admit(message))
            this.#events.push({
              type: "message",
              id: message.id,
              body: message.body,
            });
        break;
      }
      case "close":
        // A Client never closes the Server's side; only the Server's own notice counts.
        if (
          this.#state !== "requesting" &&
          datagram.reason.kind === "closedByServer"
        )
          this.#close(datagram.reason);
        break;
    }
  }

  advance(now: number): void {
    if (this.#inHandshake() && now >= this.#handshakeDeadline)
      this.#close({ kind: "timeout" });
    if (this.#inHandshake() && now >= this.#handshakeResendAt)
      this.#sendHandshake(this.#handshakeDatagram, now);
    if (this.#state === "connected" && now >= this.#silenceDeadline)
      this.#close({ kind: "timeout" });
    if (this.#state === "connected" && now >= this.#sendSteps.next) {
      this.#step++;
      for (const data of this.#link.flush(this.#step, now))
        this.#datagrams.push({ to: this.#server, data });
      // A late wake-up takes one step, not one per interval missed: a single flush covers them all.
      this.#sendSteps.skipPast(now);
    }
  }

  nextDeadline(): number | undefined {
    if (this.#inHandshake())
      return Math.min(this.#handshakeDeadline, this.#handshakeResendAt);
    if (this.#state === "connected")
      return Math.min(this.#sendSteps.next, this.#silenceDeadline);
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

  /** Sends a Handshake Datagram now, and again at every resend interval until the next step of the Handshake. */
  #sendHandshake(data: Uint8Array, now: number): void {
    this.#handshakeDatagram = data;
    this.#handshakeResendAt = now + HANDSHAKE_RESEND_INTERVAL;
    this.#datagrams.push({ to: this.#server, data });
  }

  #inHandshake(): boolean {
    return this.#state === "requesting" || this.#state === "echoing";
  }

  #close(reason: CloseReason): void {
    this.#state = "closed";
    this.#closeReason = reason;
    this.#events.push({ type: "connectionClosed", reason });
  }
}
