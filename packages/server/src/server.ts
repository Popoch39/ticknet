import {
  EngineDriver,
  MessageRouter,
  ServerEngine,
  type Address,
  type Clock,
  type DeliveryMode,
  type MessageType,
  type ServerEvent,
  type Transport,
} from "@ticknet/core";
import { openUdpTransport, realClock, resolveHost } from "./bun-adapter";

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
}

/** One Client's Connection to this Server. */
export class Connection {
  readonly address: Address;
  readonly #send: (
    id: number,
    body: Uint8Array,
    delivery: DeliveryMode,
  ) => void;

  constructor(
    address: Address,
    send: (id: number, body: Uint8Array, delivery: DeliveryMode) => void,
  ) {
    this.address = address;
    this.#send = send;
  }

  /**
   * Sends a Message to this Client when the current Tick ends. Throws at once
   * if the Message cannot fit in one Datagram.
   */
  send<T>(type: MessageType<T>, value: T, delivery: DeliveryMode): void {
    this.#send(type.id, type.encode(value), delivery);
  }
}

export interface ServerEvents {
  connectionOpened: (connection: Connection) => void;
  /** Runs once per Tick, before everything sent during the Tick leaves. */
  tick: (tick: number) => void;
  /**
   * A received Message could not be decoded, or its handler threw. Without
   * a listener, the error is written to the console.
   */
  error: (error: Error) => void;
}

export class Server {
  readonly #listeners: { [E in keyof ServerEvents]: Set<ServerEvents[E]> } = {
    connectionOpened: new Set(),
    tick: new Set(),
    error: new Set(),
  };
  /** The UDP port the Server listens on; undefined with an injected Transport. */
  readonly port: number | undefined;
  readonly #engine: ServerEngine;
  readonly #driver: EngineDriver<ServerEvent>;
  readonly #connections = new Map<number, Connection>();
  readonly #router = new MessageRouter<Connection>((error) =>
    this.#report(error),
  );

  /** Use `startServer`, which opens the Transport. */
  constructor(
    options: ServerOptions,
    transport: Transport,
    clock: Clock,
    port?: number,
  ) {
    this.port = port;
    const engine = new ServerEngine(
      {
        secret: crypto.getRandomValues(new Uint8Array(16)),
        tickRate: options.tickRate ?? 30,
      },
      clock.now(),
    );
    this.#engine = engine;
    this.#driver = new EngineDriver(engine, transport, clock, (event) => {
      switch (event.type) {
        case "connectionOpened": {
          const connection = new Connection(
            event.address,
            (id, body, delivery) =>
              engine.send(event.connection, id, body, delivery),
          );
          this.#connections.set(event.connection, connection);
          for (const listener of this.#listeners.connectionOpened)
            listener(connection);
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

  on<E extends keyof ServerEvents>(event: E, listener: ServerEvents[E]): void {
    this.#listeners[event].add(listener);
  }

  /** Sets the handler for one Message type, called with the Connection it came from and its decoded value. */
  onMessage<T>(
    type: MessageType<T>,
    handler: (connection: Connection, value: T) => void,
  ): void {
    this.#router.on(type, (value, connection) => handler(connection, value));
  }

  /**
   * Sends a Message to every open Connection when the current Tick ends.
   * Throws at once, sending to none, if the Message cannot fit in one Datagram.
   */
  broadcast<T>(type: MessageType<T>, value: T, delivery: DeliveryMode): void {
    this.#engine.broadcast(type.id, type.encode(value), delivery);
  }

  /**
   * Stops ticking and releases the socket and timers, so that the process
   * can exit and the port can be reused. Clients are not told yet.
   */
  stop(): void {
    this.#driver.stop();
  }

  #report(error: Error): void {
    if (this.#listeners.error.size === 0) console.error(error);
    for (const listener of this.#listeners.error) listener(error);
  }
}

/**
 * Starts a Server, listening on a UDP socket unless a Transport is given,
 * and resolves once it is ready to accept Clients.
 */
export async function startServer(options: ServerOptions): Promise<Server> {
  const clock = options.clock ?? realClock;
  if (options.transport)
    return new Server(options, options.transport, clock, undefined);
  const hostname = await resolveHost(options.host ?? "0.0.0.0");
  const socket = await openUdpTransport(hostname, options.port ?? 0);
  return new Server(options, socket.transport, clock, socket.port);
}
