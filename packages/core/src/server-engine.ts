import { Challenger } from "./challenge";
import { MAX_CLOSE_CODE } from "./close-reason";
import {
  CLIENT_HANDSHAKE_SIZE,
  decodeDatagram,
  encodeDatagram,
} from "./datagram";
import type { Engine } from "./engine";
import { addressKey, type Address, type OutgoingDatagram } from "./transport";

/** Identifies a Connection within one Server, from its authentication on; never reused. */
export type ConnectionId = number;

export type ServerEvent =
  | {
      /** A Client proved its address; answer with `accept` or `deny`. */
      readonly type: "authenticationRequested";
      readonly connection: ConnectionId;
      readonly address: Address;
      readonly authToken: Uint8Array;
    }
  | {
      readonly type: "connectionOpened";
      readonly connection: ConnectionId;
      readonly address: Address;
    };

export interface ServerEngineConfig {
  /** 16 random bytes keying the Handshake challenges; never sent. */
  readonly secret: Uint8Array;
  /** Clients being authenticated count towards it, so that the Server never accepts more. */
  readonly maxConnections: number;
  /**
   * Milliseconds the Server waits for an authentication decision; after
   * that, a late decision is ignored and the Client's place is freed.
   */
  readonly timeout: number;
}

/**
 * The Server side of the protocol. An address gets considered for a
 * Connection only once it has echoed a challenge, which proves the Client
 * receives at that address; until then the Server keeps nothing about it.
 */
export class ServerEngine implements Engine<ServerEvent> {
  readonly #challenger: Challenger;
  readonly #maxConnections: number;
  readonly #timeout: number;
  /** Proven addresses waiting for the authentication decision, in the order they were asked about. */
  readonly #authenticating = new Map<
    ConnectionId,
    { readonly address: Address; readonly deadline: number }
  >();
  readonly #connections = new Map<ConnectionId, Address>();
  /** Every address being authenticated or connected, by its key. */
  readonly #byAddress = new Map<string, ConnectionId>();
  #nextConnectionId: ConnectionId = 1;
  #datagrams: OutgoingDatagram[] = [];
  #events: ServerEvent[] = [];

  constructor(config: ServerEngineConfig) {
    this.#challenger = new Challenger(config.secret);
    this.#maxConnections = config.maxConnections;
    this.#timeout = config.timeout;
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
          this.#authenticate(from, datagram.authToken, now);
        break;
    }
  }

  /**
   * Opens the Connection whose authentication was requested. Returns false,
   * doing nothing, if it is no longer pending.
   */
  accept(connection: ConnectionId): boolean {
    const address = this.#authenticating.get(connection)?.address;
    if (!address) return false;
    this.#authenticating.delete(connection);
    this.#connections.set(connection, address);
    this.#events.push({ type: "connectionOpened", connection, address });
    this.#send(address, encodeDatagram({ kind: "accepted" }));
    return true;
  }

  /**
   * Forgets an open Connection, freeing its place; does nothing if it is not
   * open. The Client is not told yet.
   */
  close(connection: ConnectionId): void {
    const address = this.#connections.get(connection);
    if (!address) return;
    this.#connections.delete(connection);
    this.#byAddress.delete(addressKey(address));
  }

  /**
   * Refuses the Client whose authentication was requested, telling it `code`;
   * does nothing if it is no longer pending. Throws a RangeError if `code` is
   * not an integer from 0 to MAX_CLOSE_CODE.
   */
  deny(connection: ConnectionId, code: number): void {
    if (!Number.isInteger(code) || code < 0 || code > MAX_CLOSE_CODE)
      throw new RangeError(
        `A denial code must be an integer from 0 to ${MAX_CLOSE_CODE}, not ${code}`,
      );
    const address = this.#authenticating.get(connection)?.address;
    if (!address) return;
    this.#forgetAuthentication(connection, address);
    this.#send(
      address,
      encodeDatagram({ kind: "refused", reason: { kind: "denied", code } }),
    );
  }

  advance(now: number): void {
    for (const [connection, { address, deadline }] of this.#authenticating) {
      if (deadline > now) break;
      // The Client has given up by now, or soon will: it times out on its own.
      this.#forgetAuthentication(connection, address);
    }
  }

  nextDeadline(): number | undefined {
    // Every authentication waits as long, so the oldest one ends first.
    for (const { deadline } of this.#authenticating.values()) return deadline;
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

  #forgetAuthentication(connection: ConnectionId, address: Address): void {
    this.#authenticating.delete(connection);
    this.#byAddress.delete(addressKey(address));
  }

  #authenticate(from: Address, authToken: Uint8Array, now: number): void {
    const key = addressKey(from);
    const known = this.#byAddress.get(key);
    if (known !== undefined) {
      // A repeated echo means the acceptance was lost: answer again, without a second Connection.
      // While the decision is pending, the game has already been asked.
      if (this.#connections.has(known))
        this.#send(from, encodeDatagram({ kind: "accepted" }));
      return;
    }
    if (this.#byAddress.size >= this.#maxConnections) {
      this.#send(
        from,
        encodeDatagram({ kind: "refused", reason: { kind: "serverFull" } }),
      );
      return;
    }
    const connection = this.#nextConnectionId++;
    this.#authenticating.set(connection, {
      address: from,
      deadline: now + this.#timeout,
    });
    this.#byAddress.set(key, connection);
    this.#events.push({
      type: "authenticationRequested",
      connection,
      address: from,
      authToken,
    });
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
