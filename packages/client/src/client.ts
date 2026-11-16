import {
  ClientEngine,
  EngineDriver,
  MessageRouter,
  type ClientEvent,
  type Clock,
  type CloseReason,
  type DeliveryMode,
  type MessageType,
  type Transport,
} from "@ticknet/core";
import { openUdpTransport, realClock, resolveHost } from "./bun-adapter";

export interface ClientOptions {
  /**
   * The Server's host name or IP address. With an injected Transport, it is
   * used as is, as that Transport addresses the Server.
   */
  readonly host: string;
  readonly port: number;
  /** Replaces the UDP socket, for tests on a simulated network. */
  readonly transport?: Transport;
  /** Replaces real time, for tests with a manual Clock. */
  readonly clock?: Clock;
  /**
   * Milliseconds to wait for the Server before giving up, during the
   * Handshake and then whenever nothing arrives from it; 10 seconds by
   * default.
   */
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

/**
 * Why `connect` failed: the Connection never opened, or the Server's host
 * name could not be resolved to an address.
 */
export type ConnectFailure =
  CloseReason | { readonly kind: "hostNotFound"; readonly host: string };

/** Why `connect` failed. */
export class ConnectError extends Error {
  readonly reason: ConnectFailure;

  constructor(reason: ConnectFailure, options?: ErrorOptions) {
    super(
      reason.kind === "hostNotFound"
        ? `Could not connect to the Server: no address found for ${reason.host}`
        : `Could not connect to the Server: ${reason.kind}`,
      options,
    );
    this.name = "ConnectError";
    this.reason = reason;
  }
}

export interface ClientEvents {
  /**
   * The Connection ended, whichever side ended it: the Client closed it, the
   * Server closed it or stopped, or nothing arrived from the Server within
   * the timeout. Runs once, after which the socket and timers are released
   * and no Message is delivered.
   */
  connectionClosed: (reason: CloseReason) => void;
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
  readonly #driver: EngineDriver<ClientEvent>;

  constructor(
    engine: ClientEngine,
    router: MessageRouter<void>,
    listeners: Listeners,
    driver: EngineDriver<ClientEvent>,
  ) {
    this.#engine = engine;
    this.#router = router;
    this.#listeners = listeners;
    this.#driver = driver;
  }

  /**
   * The highest Server Tick number the Client has received, or undefined
   * before anything arrived from the Server.
   */
  get lastServerTick(): number | undefined {
    return this.#engine.lastServerTick;
  }

  /**
   * Milliseconds a Datagram takes to reach the Server and be acknowledged,
   * smoothed over recent ones; undefined until the first acknowledgement.
   */
  get roundTripTime(): number | undefined {
    return this.#engine.health.roundTripTime;
  }

  /**
   * Share of the recent Datagrams sent to the Server that never reached it,
   * from 0 to 1; undefined until the fate of one is known.
   */
  get lossRate(): number | undefined {
    return this.#engine.health.lossRate;
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
   * at once if the Message cannot fit in one Datagram, or if the Connection
   * has closed.
   */
  send<T>(type: MessageType<T>, value: T, delivery: DeliveryMode): void {
    this.#engine.send(type.id, type.encode(value), delivery);
  }

  /**
   * Leaves the Server on purpose, telling it so, then releases the socket
   * and timers so that the process can exit. Messages not sent yet are
   * dropped. Does nothing once the Connection has closed.
   */
  close(): void {
    this.#driver.perform(() => this.#engine.close());
  }
}

/**
 * Connects to a Server and resolves once the Handshake is complete, or
 * rejects with a ConnectError. Unless a Transport is given, the host name is
 * resolved first and a UDP socket is opened.
 */
export async function connect(options: ClientOptions): Promise<Client> {
  const clock = options.clock ?? realClock;
  // Nothing is awaited on this path, so the first Datagram leaves at once.
  if (options.transport)
    return handshake(options, options.host, options.transport, clock);
  let host: string;
  try {
    host = await resolveHost(options.host);
  } catch (error) {
    throw new ConnectError(
      { kind: "hostNotFound", host: options.host },
      { cause: error },
    );
  }
  const socket = await openUdpTransport(
    host.includes(":") ? "::" : "0.0.0.0",
    0,
  );
  return handshake(options, host, socket.transport, clock);
}

function handshake(
  options: ClientOptions,
  host: string,
  transport: Transport,
  clock: Clock,
): Promise<Client> {
  return new Promise((resolve, reject) => {
    let engine: ClientEngine;
    try {
      engine = new ClientEngine(
        {
          server: { host, port: options.port },
          timeout: options.timeout ?? 10_000,
          sendRate: options.sendRate ?? 30,
          authToken: options.authToken,
        },
        clock.now(),
      );
    } catch (error) {
      // Invalid options: the socket is already open and must not keep the process alive.
      transport.close();
      throw error;
    }
    const listeners: Listeners = {
      connectionClosed: new Set(),
      error: new Set(),
    };
    const router = new MessageRouter<void>((error) => {
      if (listeners.error.size === 0) console.error(error);
      for (const listener of listeners.error) listener(error);
    });
    let opened = false;
    const driver = new EngineDriver(engine, transport, clock, (event) => {
      switch (event.type) {
        case "connectionOpened":
          opened = true;
          resolve(new Client(engine, router, listeners, driver));
          break;
        case "connectionClosed":
          // A closed Client keeps nothing alive; a new connect makes a new Connection.
          driver.stop();
          if (!opened) reject(new ConnectError(event.reason));
          else
            for (const listener of listeners.connectionClosed)
              listener(event.reason);
          break;
        case "message":
          router.route(event.id, event.body, undefined);
          break;
      }
    });
  });
}
