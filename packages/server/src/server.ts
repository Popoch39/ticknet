import {
  EngineDriver,
  MessageRouter,
  ServerEngine,
  type Address,
  type Clock,
  type CloseReason,
  type ConnectionHealth,
  type ConnectionId,
  type DeliveryMode,
  type MessageType,
  type ServerEvent,
  type Transport,
} from "@ticknet/core";
import { openUdpTransport, realClock, resolveHost } from "./bun-adapter";

/** What the authentication callback is given about a Client that proved its address. */
export interface AuthenticationRequest {
  readonly address: Address;
  /** The Client's Auth token, as it sent it; empty if it sent none. */
  readonly authToken: Uint8Array;
}

/**
 * The authentication callback's answer. Accepting may attach `data` to the
 * Connection, which is required when the data type does not allow undefined.
 * Denying tells the Client `code`, an integer from 0 to MAX_CLOSE_CODE; 0 by
 * default.
 */
export type AuthenticationDecision<Data> =
  | (undefined extends Data
      ? { readonly accept: true; readonly data?: Data }
      : { readonly accept: true; readonly data: Data })
  | { readonly accept: false; readonly code?: number };

export type Authenticate<Data> = (
  request: AuthenticationRequest,
) => AuthenticationDecision<Data> | Promise<AuthenticationDecision<Data>>;

export interface ServerOptions {
  /** The UDP port to listen on; by default one the system picks, read back from `Server.port`. */
  readonly port?: number;
  /** The host name or IP address to listen on; every IPv4 interface by default. */
  readonly host?: string;
  /** Replaces the UDP socket, for tests on a simulated network; `port` and `host` are then unused. */
  readonly transport?: Transport;
  /** Replaces real time, for tests with a manual Clock. */
  readonly clock?: Clock;
  /** Ticks per second; 30 by default. */
  readonly tickRate?: number;
  /**
   * Further Clients are refused with a Server full reason; Clients being
   * authenticated count towards it. 64 by default.
   */
  readonly maxConnections?: number;
  /**
   * Milliseconds the Server waits on a Client; 10 seconds by default. A
   * Connection on which nothing arrives for that long closes with a timeout
   * reason, and an authentication callback that has not answered by then is
   * ignored, freeing the Client's place.
   */
  readonly timeout?: number;
  /**
   * The most bytes the Server puts on the network for each Connection per
   * Tick, resends and acknowledgements included; DEFAULT_SEND_BUDGET by
   * default. What is left unused in one Tick is not carried over.
   */
  readonly sendBudget?: number;
}

/** What a Connection needs from its Server. */
interface ConnectionLink {
  send(id: number, body: Uint8Array, delivery: DeliveryMode): boolean;
  close(code: number): void;
  health(): ConnectionHealth | undefined;
}

/** One Client's Connection to this Server. */
export class Connection<Data = undefined> {
  readonly address: Address;
  /** What the authentication callback attached to this Connection. */
  readonly data: Data;
  readonly #link: ConnectionLink;

  /** Connections are made by the Server. */
  constructor(address: Address, data: Data, link: ConnectionLink) {
    this.address = address;
    this.data = data;
    this.#link = link;
  }

  /**
   * Milliseconds a Datagram takes to reach this Client and be acknowledged,
   * smoothed over recent ones; undefined until the first acknowledgement.
   */
  get roundTripTime(): number | undefined {
    return this.#link.health()?.roundTripTime;
  }

  /**
   * Share of the recent Datagrams sent to this Client that never reached it,
   * from 0 to 1; undefined until the fate of one is known.
   */
  get lossRate(): number | undefined {
    return this.#link.health()?.lossRate;
  }

  /**
   * Sends a Message to this Client when the current Tick ends. Throws at once
   * if an Unreliable or Sequenced Message cannot fit in one Datagram, if a
   * Reliable one is over MAX_RELIABLE_MESSAGE_SIZE, or if the Connection has
   * closed. A Reliable Message too large for one Datagram travels as
   * Fragments. It is sent again until the Client acknowledges it; with more
   * than MAX_RELIABLE_BACKLOG Reliable Messages or Fragments waiting, the
   * Connection closes.
   *
   * Returns false, sending nothing, when an Unreliable or Sequenced Message
   * does not fit in what is left of this Tick's Send budget. A Reliable
   * Message is never refused: what does not fit waits for later Ticks.
   */
  send<T>(type: MessageType<T>, value: T, delivery: DeliveryMode): boolean {
    return this.#link.send(type.id, type.encode(value), delivery);
  }

  /**
   * Ends this Connection, freeing its place on the Server, and tells the
   * Client it was closed by the Server with `code`, an integer from 0 to
   * MAX_CLOSE_CODE (0 by default). Messages not sent yet are dropped. Does
   * nothing if the Connection has already closed.
   */
  close(code = 0): void {
    this.#link.close(code);
  }
}

export interface ServerEvents<Data = undefined> {
  connectionOpened: (connection: Connection<Data>) => void;
  /**
   * Runs once for every Connection that opened, whichever side ended it:
   * the Client left, the Server closed it or stopped, it timed out, or
   * either side had more Reliable Messages waiting for acknowledgement than
   * MAX_RELIABLE_BACKLOG. No Message from it is delivered afterwards.
   */
  connectionClosed: (connection: Connection<Data>, reason: CloseReason) => void;
  /** Runs once per Tick, before everything sent during the Tick leaves. */
  tick: (tick: number) => void;
  /**
   * A received Message could not be decoded, its handler threw, or the
   * authentication callback failed; the Server carries on. Without a
   * listener, the error is written to the console.
   */
  error: (error: Error) => void;
}

/** A decision with the Connection's data always present, as the Server applies it. */
type Decision<Data> =
  | { readonly accept: true; readonly data: Data }
  | { readonly accept: false; readonly code: number };

export class Server<Data = undefined> {
  readonly #listeners: {
    [E in keyof ServerEvents<Data>]: Set<ServerEvents<Data>[E]>;
  } = {
    connectionOpened: new Set(),
    connectionClosed: new Set(),
    tick: new Set(),
    error: new Set(),
  };
  /** The UDP port the Server listens on; undefined with an injected Transport. */
  readonly port: number | undefined;
  readonly #engine: ServerEngine;
  readonly #clock: Clock;
  readonly #driver: EngineDriver<ServerEvent>;
  readonly #authenticate: (
    request: AuthenticationRequest,
  ) => Decision<Data> | Promise<Decision<Data>>;
  /** Every Connection from its acceptance until it closes. */
  readonly #connections = new Map<ConnectionId, Connection<Data>>();
  readonly #router = new MessageRouter<Connection<Data>>((error) =>
    this.#report(error),
  );

  /** Use `startServer`, which opens the Transport. */
  constructor(
    options: ServerOptions,
    authenticate: (
      request: AuthenticationRequest,
    ) => Decision<Data> | Promise<Decision<Data>>,
    transport: Transport,
    clock: Clock,
    port?: number,
  ) {
    this.port = port;
    this.#clock = clock;
    this.#authenticate = authenticate;
    this.#engine = new ServerEngine(
      {
        secret: crypto.getRandomValues(new Uint8Array(16)),
        tickRate: options.tickRate ?? 30,
        maxConnections: options.maxConnections ?? 64,
        timeout: options.timeout ?? 10_000,
        sendBudget: options.sendBudget,
      },
      clock.now(),
    );
    this.#driver = new EngineDriver(this.#engine, transport, clock, (event) => {
      switch (event.type) {
        case "authenticationRequested":
          this.#authenticateClient(event.connection, {
            address: event.address,
            authToken: event.authToken,
          });
          break;
        case "connectionOpened": {
          const connection = this.#connections.get(event.connection);
          if (!connection) break;
          for (const listener of this.#listeners.connectionOpened)
            listener(connection);
          break;
        }
        case "connectionClosed": {
          const connection = this.#connections.get(event.connection);
          if (!connection) break;
          this.#connections.delete(event.connection);
          for (const listener of this.#listeners.connectionClosed)
            listener(connection, event.reason);
          break;
        }
        case "tick":
          for (const listener of this.#listeners.tick) listener(event.tick);
          break;
        case "message": {
          const connection = this.#connections.get(event.connection);
          if (connection) this.#router.route(event.id, event.body, connection);
          break;
        }
      }
    });
  }

  on<E extends keyof ServerEvents<Data>>(
    event: E,
    listener: ServerEvents<Data>[E],
  ): void {
    this.#listeners[event].add(listener);
  }

  /** Sets the handler for one Message type, called with the Connection it came from and its decoded value. */
  onMessage<T>(
    type: MessageType<T>,
    handler: (connection: Connection<Data>, value: T) => void,
  ): void {
    this.#router.on(type, (value, connection) => handler(connection, value));
  }

  /**
   * Sends a Message to every open Connection when the current Tick ends.
   * Throws at once, sending to none, if the Message is too large, as `send`
   * does. Returns the Connections that refused an Unreliable or Sequenced
   * Message because it did not fit in what is left of their Send budget for
   * this Tick; empty when every one took it.
   */
  broadcast<T>(
    type: MessageType<T>,
    value: T,
    delivery: DeliveryMode,
  ): Connection<Data>[] {
    return this.#engine
      .broadcast(type.id, type.encode(value), delivery)
      .flatMap((id) => this.#connections.get(id) ?? []);
  }

  /**
   * Closes every Connection, telling each Client it was closed by the Server
   * (with code 0), then stops ticking and releases the socket and timers, so
   * that the process can exit and the port can be reused.
   */
  stop(): void {
    this.#driver.perform(() => {
      for (const connection of this.#connections.keys())
        this.#engine.close(connection, 0);
    });
    this.#driver.stop();
  }

  #authenticateClient(
    connection: ConnectionId,
    request: AuthenticationRequest,
  ): void {
    let decision: Decision<Data> | Promise<Decision<Data>>;
    try {
      decision = this.#authenticate(request);
    } catch (error) {
      this.#refuseAfter(error, connection);
      return;
    }
    if (decision instanceof Promise) {
      decision.then(
        (answer) =>
          this.#driver.perform(() =>
            this.#decide(connection, request.address, answer),
          ),
        (error: unknown) =>
          this.#driver.perform(() => this.#refuseAfter(error, connection)),
      );
    } else {
      // A synchronous answer takes effect within the same Handshake step.
      this.#decide(connection, request.address, decision);
    }
  }

  #decide(
    connection: ConnectionId,
    address: Address,
    decision: Decision<Data>,
  ): void {
    if (decision.accept) {
      // The engine's opened event is handed out after this returns, so registering afterwards is in time.
      if (this.#engine.accept(connection, this.#clock.now()))
        this.#connections.set(
          connection,
          new Connection(address, decision.data, {
            send: (id, body, delivery) =>
              this.#engine.send(connection, id, body, delivery),
            close: (code) =>
              this.#driver.perform(() => this.#engine.close(connection, code)),
            health: () => this.#engine.health(connection),
          }),
        );
      return;
    }
    try {
      this.#engine.deny(connection, decision.code);
    } catch (error) {
      this.#refuseAfter(error, connection);
    }
  }

  /** A failing callback must neither stop the Server nor let the Client in. */
  #refuseAfter(error: unknown, connection: ConnectionId): void {
    this.#engine.deny(connection, 0);
    // The game may throw anything; listeners always get an Error.
    this.#report(
      error instanceof Error
        ? error
        : new Error("The authentication callback failed", { cause: error }),
    );
  }

  #report(error: Error): void {
    if (this.#listeners.error.size === 0) console.error(error);
    for (const listener of this.#listeners.error) listener(error);
  }
}

/**
 * Starts a Server that accepts every Client completing the Handshake. It
 * listens on a UDP socket unless a Transport is given, and resolves once it is
 * ready to accept Clients.
 */
export function startServer(
  options: ServerOptions & { readonly authenticate?: undefined },
): Promise<Server<undefined>>;
/**
 * Starts a Server that asks `authenticate` whether a Client completing the
 * Handshake gets a Connection.
 */
export function startServer<Data>(
  options: ServerOptions & { readonly authenticate: Authenticate<Data> },
): Promise<Server<Data>>;
// Server is invariant in its data type, so the implementation names both results for each overload to match.
export async function startServer(
  options: ServerOptions & { readonly authenticate?: Authenticate<unknown> },
): Promise<Server<unknown> | Server<undefined>> {
  const authenticate = (
    request: AuthenticationRequest,
  ): Decision<unknown> | Promise<Decision<unknown>> => {
    if (!options.authenticate) return { accept: true, data: undefined };
    const decision = options.authenticate(request);
    return decision instanceof Promise
      ? decision.then(withData)
      : withData(decision);
  };
  const clock = options.clock ?? realClock;
  if (options.transport)
    return new Server<unknown>(options, authenticate, options.transport, clock);
  const hostname = await resolveHost(options.host ?? "0.0.0.0");
  const socket = await openUdpTransport(hostname, options.port ?? 0);
  try {
    return new Server<unknown>(
      options,
      authenticate,
      socket.transport,
      clock,
      socket.port,
    );
  } catch (error) {
    // Invalid options: the socket is already open and must not keep the process alive.
    socket.transport.close();
    throw error;
  }
}

function withData(
  decision: AuthenticationDecision<unknown>,
): Decision<unknown> {
  return decision.accept
    ? { accept: true, data: decision.data }
    : { accept: false, code: decision.code ?? 0 };
}
