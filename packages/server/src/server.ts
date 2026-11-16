import {
  EngineDriver,
  ServerEngine,
  type Address,
  type Clock,
  type ConnectionId,
  type ServerEvent,
  type Transport,
} from "@ticknet/core";

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
  readonly transport: Transport;
  readonly clock: Clock;
  /**
   * Further Clients are refused with a Server full reason; Clients being
   * authenticated count towards it. 64 by default.
   */
  readonly maxConnections?: number;
  /**
   * Milliseconds the Server waits on a Client; 10 seconds by default. For
   * now it bounds the wait for the authentication callback: a later answer
   * is ignored and the Client's place is freed.
   */
  readonly timeout?: number;
}

/** One Client's Connection to this Server. */
export class Connection<Data = undefined> {
  readonly address: Address;
  /** What the authentication callback attached to this Connection. */
  readonly data: Data;
  readonly #close: () => void;

  /** Connections are made by the Server. */
  constructor(address: Address, data: Data, close: () => void) {
    this.address = address;
    this.data = data;
    this.#close = close;
  }

  /** Ends this Connection, freeing its place on the Server. The Client is not told yet. */
  close(): void {
    this.#close();
  }
}

export interface ServerEvents<Data = undefined> {
  connectionOpened: (connection: Connection<Data>) => void;
  /** Something the game supplied failed (a throwing authentication callback, say); the Server carries on. */
  error: (error: unknown) => void;
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
    error: new Set(),
  };
  readonly #engine: ServerEngine;
  readonly #driver: EngineDriver<ServerEvent>;
  readonly #authenticate: (
    request: AuthenticationRequest,
  ) => Decision<Data> | Promise<Decision<Data>>;
  /** Connections accepted by the callback, until the engine opens them. */
  readonly #accepted = new Map<ConnectionId, Connection<Data>>();

  /** Use `startServer`. */
  constructor(
    options: ServerOptions,
    authenticate: (
      request: AuthenticationRequest,
    ) => Decision<Data> | Promise<Decision<Data>>,
  ) {
    this.#authenticate = authenticate;
    this.#engine = new ServerEngine({
      secret: crypto.getRandomValues(new Uint8Array(16)),
      maxConnections: options.maxConnections ?? 64,
      timeout: options.timeout ?? 10_000,
    });
    this.#driver = new EngineDriver(
      this.#engine,
      options.transport,
      options.clock,
      (event) => {
        switch (event.type) {
          case "authenticationRequested":
            this.#authenticateClient(event.connection, {
              address: event.address,
              authToken: event.authToken,
            });
            break;
          case "connectionOpened": {
            const connection = this.#accepted.get(event.connection);
            if (!connection) break;
            this.#accepted.delete(event.connection);
            for (const listener of this.#listeners.connectionOpened)
              listener(connection);
            break;
          }
        }
      },
    );
  }

  on<E extends keyof ServerEvents<Data>>(
    event: E,
    listener: ServerEvents<Data>[E],
  ): void {
    this.#listeners[event].add(listener);
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
      if (this.#engine.accept(connection))
        this.#accepted.set(
          connection,
          new Connection(address, decision.data, () =>
            this.#driver.perform(() => this.#engine.close(connection)),
          ),
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
    this.#report(error);
  }

  #report(error: unknown): void {
    const listeners = this.#listeners.error;
    // Never silent: without a listener, the error still reaches the console.
    if (listeners.size === 0) console.error(error);
    for (const listener of listeners) listener(error);
  }
}

/** Starts a Server that accepts every Client completing the Handshake. */
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
  const authenticate = options.authenticate;
  return new Server<unknown>(options, (request) => {
    if (!authenticate) return { accept: true, data: undefined };
    const decision = authenticate(request);
    return decision instanceof Promise
      ? decision.then(withData)
      : withData(decision);
  });
}

function withData(
  decision: AuthenticationDecision<unknown>,
): Decision<unknown> {
  return decision.accept
    ? { accept: true, data: decision.data }
    : { accept: false, code: decision.code ?? 0 };
}
