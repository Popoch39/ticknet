import { Challenger } from "./challenge";
import {
  CLIENT_HANDSHAKE_SIZE,
  decodeDatagram,
  encodeDatagram,
} from "./datagram";
import type { Engine } from "./engine";
import { addressKey, type Address, type OutgoingDatagram } from "./transport";

/** Identifies a Connection within one Server; never reused. */
export type ConnectionId = number;

export type ServerEvent = {
  readonly type: "connectionOpened";
  readonly connection: ConnectionId;
  readonly address: Address;
};

export interface ServerEngineConfig {
  /** 16 random bytes keying the Handshake challenges; never sent. */
  readonly secret: Uint8Array;
}

/**
 * The Server side of the protocol. An address gets a Connection only once it
 * has echoed a challenge, which proves the Client receives at that address;
 * until then the Server keeps nothing about it.
 */
export class ServerEngine implements Engine<ServerEvent> {
  readonly #challenger: Challenger;
  readonly #connections = new Map<string, ConnectionId>();
  #nextConnectionId: ConnectionId = 1;
  #datagrams: OutgoingDatagram[] = [];
  #events: ServerEvent[] = [];

  constructor(config: ServerEngineConfig) {
    this.#challenger = new Challenger(config.secret);
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
    }
  }

  advance(_now: number): void {}

  nextDeadline(): number | undefined {
    return undefined;
  }

  pollDatagrams(): OutgoingDatagram[] {
    const datagrams = this.#datagrams;
    this.#datagrams = [];
    return datagrams;
  }

  pollEvents(): ServerEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  #accept(from: Address): void {
    const key = addressKey(from);
    // A repeated echo means the acceptance was lost: answer again, without a second Connection.
    if (!this.#connections.has(key)) {
      const connection = this.#nextConnectionId++;
      this.#connections.set(key, connection);
      this.#events.push({
        type: "connectionOpened",
        connection,
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
