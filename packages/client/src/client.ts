import {
  ClientEngine,
  EngineDriver,
  MessageRouter,
  type Clock,
  type CloseReason,
  type DeliveryMode,
  type MessageType,
  type Transport,
} from "@ticknet/core";

export interface ClientOptions {
  /** The Server's host, as the Transport addresses it. */
  readonly host: string;
  readonly port: number;
  readonly transport: Transport;
  readonly clock: Clock;
  /** Milliseconds to wait for the Server before giving up; 10 seconds by default. */
  readonly timeout?: number;
  /** How many times per second queued Messages are sent; 30 by default. */
  readonly sendRate?: number;
  /**
   * Opaque bytes handed to the Server's authentication callback; empty by
   * default. At most MAX_AUTH_TOKEN_SIZE bytes, so that the Handshake fits in
   * one Datagram.
   */
  readonly authToken?: Uint8Array;
}

/** Why `connect` failed. */
export class ConnectError extends Error {
  readonly reason: CloseReason;

  constructor(reason: CloseReason) {
    super(`Could not connect to the Server: ${reason.kind}`);
    this.name = "ConnectError";
    this.reason = reason;
  }
}

export interface ClientEvents {
  /**
   * A received Message could not be decoded, or its handler threw. Without
   * a listener, the error is written to the console.
   */
  error: (error: Error) => void;
}

type Listeners = { [E in keyof ClientEvents]: Set<ClientEvents[E]> };

/** A Client connected to a Server, as `connect` resolves it. */
export class Client {
  readonly #engine: ClientEngine;
  readonly #router: MessageRouter<void>;
  readonly #listeners: Listeners;

  constructor(
    engine: ClientEngine,
    router: MessageRouter<void>,
    listeners: Listeners,
  ) {
    this.#engine = engine;
    this.#router = router;
    this.#listeners = listeners;
  }

  /**
   * The highest Server Tick number the Client has received, or undefined
   * before anything arrived from the Server.
   */
  get lastServerTick(): number | undefined {
    return this.#engine.lastServerTick;
  }

  on<E extends keyof ClientEvents>(event: E, listener: ClientEvents[E]): void {
    this.#listeners[event].add(listener);
  }

  /** Sets the handler for one Message type, called with its decoded value. */
  onMessage<T>(type: MessageType<T>, handler: (value: T) => void): void {
    this.#router.on(type, (value) => handler(value));
  }

  /**
   * Sends a Message to the Server at the next step of the send rate. Throws
   * at once if the Message cannot fit in one Datagram.
   */
  send<T>(type: MessageType<T>, value: T, delivery: DeliveryMode): void {
    this.#engine.send(type.id, type.encode(value), delivery);
  }
}

/**
 * Connects to a Server and resolves once the Handshake is complete, or
 * rejects with a ConnectError.
 */
export function connect(options: ClientOptions): Promise<Client> {
  return new Promise((resolve, reject) => {
    const engine = new ClientEngine(
      {
        server: { host: options.host, port: options.port },
        timeout: options.timeout ?? 10_000,
        sendRate: options.sendRate ?? 30,
        authToken: options.authToken,
      },
      options.clock.now(),
    );
    const listeners: Listeners = { error: new Set() };
    const router = new MessageRouter<void>((error) => {
      if (listeners.error.size === 0) console.error(error);
      for (const listener of listeners.error) listener(error);
    });
    new EngineDriver(engine, options.transport, options.clock, (event) => {
      switch (event.type) {
        case "connectionOpened":
          resolve(new Client(engine, router, listeners));
          break;
        case "connectionClosed":
          reject(new ConnectError(event.reason));
          break;
        case "message":
          router.route(event.id, event.body, undefined);
          break;
      }
    });
  });
}
