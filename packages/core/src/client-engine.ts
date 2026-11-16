import type { CloseReason } from "./close-reason";
import {
  decodeDatagram,
  encodeDatagram,
  MAX_AUTH_TOKEN_SIZE,
} from "./datagram";
import type { Engine } from "./engine";
import { addressKey, type Address, type OutgoingDatagram } from "./transport";

export type ClientEvent =
  | { readonly type: "connectionOpened" }
  | { readonly type: "connectionClosed"; readonly reason: CloseReason };

export interface ClientEngineConfig {
  readonly server: Address;
  /** Milliseconds the Handshake may take before the attempt closes with a timeout reason. */
  readonly timeout: number;
  /** Opaque bytes for the Server's authentication callback; at most MAX_AUTH_TOKEN_SIZE. */
  readonly authToken?: Uint8Array;
}

/**
 * The Client side of the protocol, for one attempt to connect to one Server:
 * it starts the Handshake as soon as it is created.
 */
export class ClientEngine implements Engine<ClientEvent> {
  readonly #server: Address;
  readonly #handshakeDeadline: number;
  readonly #authToken: Uint8Array;
  #state: "requesting" | "echoing" | "connected" | "closed" = "requesting";
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
    this.#datagrams.push({
      to: config.server,
      data: encodeDatagram({ kind: "connectRequest" }),
    });
  }

  receive(data: Uint8Array, from: Address, _now: number): void {
    if (addressKey(from) !== addressKey(this.#server)) return;
    if (!this.#inHandshake()) return;
    const datagram = decodeDatagram(data);
    switch (datagram?.kind) {
      case "otherVersion":
        this.#close({ kind: "versionMismatch" });
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
        this.#events.push({ type: "connectionOpened" });
        break;
      case "refused":
        this.#close(datagram.reason);
        break;
    }
  }

  advance(now: number): void {
    if (this.#inHandshake() && now >= this.#handshakeDeadline)
      this.#close({ kind: "timeout" });
  }

  nextDeadline(): number | undefined {
    return this.#inHandshake() ? this.#handshakeDeadline : undefined;
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
