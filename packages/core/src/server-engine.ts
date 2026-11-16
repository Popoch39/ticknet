import { Cadence } from "./cadence";
import { Challenger, sameChallenge } from "./challenge";
import { assertCloseCode, type CloseReason } from "./close-reason";
import {
  CLIENT_HANDSHAKE_SIZE,
  decodeDatagram,
  encodeDatagram,
} from "./datagram";
import type { Engine } from "./engine";
import type { DeliveryMode } from "./message";
import { assertFitsInDatagram, keepaliveInterval, Outbox } from "./outbox";
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
    }
  | {
      /** Raised once per opened Connection, whichever side ended it. */
      readonly type: "connectionClosed";
      readonly connection: ConnectionId;
      readonly reason: CloseReason;
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
  /** Clients being authenticated count towards it, so that the Server never accepts more. */
  readonly maxConnections: number;
  /**
   * Milliseconds the Server waits on a Client: for an authentication
   * decision, after which a late one is ignored and the Client's place is
   * freed, and for anything to arrive on an open Connection, after which it
   * closes with a timeout reason.
   */
  readonly timeout: number;
}

interface OpenConnection {
  readonly id: ConnectionId;
  readonly address: Address;
  /** The challenge whose echo opened it, which tells a repeated echo from a new attempt. */
  readonly challenge: Uint8Array;
  readonly outbox: Outbox;
}

/**
 * The Server side of the protocol. An address gets considered for a
 * Connection only once it has echoed a challenge, which proves the Client
 * receives at that address; until then the Server keeps nothing about it.
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
  readonly #maxConnections: number;
  readonly #timeout: number;
  /** Proven addresses waiting for the authentication decision, in the order they were asked about. */
  readonly #authenticating = new Map<
    ConnectionId,
    {
      readonly address: Address;
      readonly challenge: Uint8Array;
      readonly deadline: number;
    }
  >();
  readonly #authenticatingAddresses = new Set<string>();
  readonly #byAddress = new Map<string, OpenConnection>();
  readonly #byId = new Map<ConnectionId, OpenConnection>();
  /**
   * When each open Connection times out unless something arrives from it.
   * Every Connection waits as long, so re-inserting on arrival keeps the
   * map ordered by deadline.
   */
  readonly #silenceDeadlines = new Map<ConnectionId, number>();
  #nextConnectionId: ConnectionId = 1;
  #tick = 0;
  /** The time the current Tick started at, which its flush counts as the time of sending. */
  #tickStartedAt = 0;
  #tickState: "between" | "started" | "ending" = "between";
  #datagrams: OutgoingDatagram[] = [];
  #events: ServerEvent[] = [];

  constructor(config: ServerEngineConfig, now: number) {
    this.#challenger = new Challenger(config.secret);
    this.#ticks = new Cadence(now, config.tickRate, "Tick rate");
    this.#maxConnections = config.maxConnections;
    this.#timeout = config.timeout;
  }

  /** Queues a Message until the end of the Tick; throws if it can never be sent. */
  send(
    connection: ConnectionId,
    id: number,
    body: Uint8Array,
    delivery: DeliveryMode,
  ): void {
    const open = this.#byId.get(connection);
    // Ids are never reused, so one that is not open has closed.
    if (!open)
      throw new Error(
        `Connection ${connection} is closed; nothing more can be sent on it`,
      );
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
          this.#authenticate(from, datagram.challenge, datagram.authToken, now);
        break;
      case "connected": {
        const open = this.#byAddress.get(addressKey(from));
        if (!open) break;
        this.#heardFrom(open.id, now);
        for (const { id, body } of datagram.messages)
          this.#events.push({
            type: "message",
            connection: open.id,
            id,
            body,
          });
        break;
      }
      case "close": {
        const open = this.#byAddress.get(addressKey(from));
        // A Server never takes a Client's word that the Server closed.
        if (open && datagram.reason.kind === "closedByClient")
          this.#forget(open, datagram.reason);
        break;
      }
    }
  }

  /**
   * Opens the Connection whose authentication was requested, at time `now`.
   * Returns false, doing nothing, if it is no longer pending.
   */
  accept(connection: ConnectionId, now: number): boolean {
    const pending = this.#authenticating.get(connection);
    if (!pending) return false;
    const { address, challenge } = pending;
    this.#forgetAuthentication(connection, address);
    const open = {
      id: connection,
      address,
      challenge,
      outbox: new Outbox(keepaliveInterval(this.#timeout), now),
    };
    this.#byAddress.set(addressKey(address), open);
    this.#byId.set(connection, open);
    this.#heardFrom(connection, now);
    this.#events.push({ type: "connectionOpened", connection, address });
    this.#send(address, encodeDatagram({ kind: "accepted" }));
    return true;
  }

  /**
   * Closes an open Connection, telling the Client `code` and freeing its
   * place; what is still queued for it is dropped. Does nothing if it is not
   * open. Throws a RangeError if `code` is not an integer from 0 to
   * MAX_CLOSE_CODE.
   */
  close(connection: ConnectionId, code: number): void {
    assertCloseCode(code, "close");
    const open = this.#byId.get(connection);
    if (!open) return;
    const reason = { kind: "closedByServer", code } as const;
    this.#send(open.address, encodeDatagram({ kind: "close", reason }));
    this.#forget(open, reason);
  }

  /**
   * Refuses the Client whose authentication was requested, telling it `code`;
   * does nothing if it is no longer pending. Throws a RangeError if `code` is
   * not an integer from 0 to MAX_CLOSE_CODE.
   */
  deny(connection: ConnectionId, code: number): void {
    assertCloseCode(code, "denial");
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
    for (const [connection, deadline] of this.#silenceDeadlines) {
      if (deadline > now) break;
      const open = this.#byId.get(connection);
      if (open) this.#forget(open, { kind: "timeout" });
    }
    // One Tick per call, so that each one is handled and flushed before the next starts.
    if (this.#tickState === "between" && now >= this.#ticks.next) {
      this.#ticks.step();
      this.#tick++;
      this.#tickStartedAt = now;
      this.#tickState = "started";
      this.#events.push({ type: "tick", tick: this.#tick });
    }
  }

  nextDeadline(): number {
    // In both maps, the first entry ends first.
    const [authentication] = this.#authenticating.values();
    const [silence] = this.#silenceDeadlines.values();
    return Math.min(
      this.#ticks.next,
      authentication?.deadline ?? Infinity,
      silence ?? Infinity,
    );
  }

  pollDatagrams(): OutgoingDatagram[] {
    if (this.#tickState === "ending") {
      this.#tickState = "between";
      for (const open of this.#byId.values())
        for (const data of open.outbox.flush(this.#tick, this.#tickStartedAt))
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

  #heardFrom(connection: ConnectionId, now: number): void {
    this.#silenceDeadlines.delete(connection);
    this.#silenceDeadlines.set(connection, now + this.#timeout);
  }

  #forget(open: OpenConnection, reason: CloseReason): void {
    this.#byId.delete(open.id);
    this.#byAddress.delete(addressKey(open.address));
    this.#silenceDeadlines.delete(open.id);
    this.#events.push({
      type: "connectionClosed",
      connection: open.id,
      reason,
    });
  }

  #forgetAuthentication(connection: ConnectionId, address: Address): void {
    this.#authenticating.delete(connection);
    this.#authenticatingAddresses.delete(addressKey(address));
  }

  #authenticate(
    from: Address,
    challenge: Uint8Array,
    authToken: Uint8Array,
    now: number,
  ): void {
    const key = addressKey(from);
    const open = this.#byAddress.get(key);
    if (open) {
      // A repeated echo means the acceptance was lost: answer again, without a second Connection.
      if (sameChallenge(challenge, open.challenge)) {
        this.#send(from, encodeDatagram({ kind: "accepted" }));
        return;
      }
      // The Client started over, so it left the old Connection, whose close notice was lost.
      this.#forget(open, { kind: "closedByClient" });
    }
    // While the decision is pending, the game has already been asked.
    if (this.#authenticatingAddresses.has(key)) return;
    if (
      this.#byAddress.size + this.#authenticating.size >=
      this.#maxConnections
    ) {
      this.#send(
        from,
        encodeDatagram({ kind: "refused", reason: { kind: "serverFull" } }),
      );
      return;
    }
    const connection = this.#nextConnectionId++;
    this.#authenticating.set(connection, {
      address: from,
      challenge,
      deadline: now + this.#timeout,
    });
    this.#authenticatingAddresses.add(key);
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
