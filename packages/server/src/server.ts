import {
  EngineDriver,
  MessageRouter,
  ServerEngine,
  type Address,
  type Clock,
  type DeliveryMode,
  type MessageType,
  type Transport,
} from "@ticknet/core";

export interface ServerOptions {
  readonly transport: Transport;
  readonly clock: Clock;
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
  readonly #engine: ServerEngine;
  readonly #connections = new Map<number, Connection>();
  readonly #router = new MessageRouter<Connection>((error) =>
    this.#report(error),
  );

  constructor(options: ServerOptions) {
    const engine = new ServerEngine(
      {
        secret: crypto.getRandomValues(new Uint8Array(16)),
        tickRate: options.tickRate ?? 30,
      },
      options.clock.now(),
    );
    this.#engine = engine;
    new EngineDriver(engine, options.transport, options.clock, (event) => {
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

  #report(error: Error): void {
    if (this.#listeners.error.size === 0) console.error(error);
    for (const listener of this.#listeners.error) listener(error);
  }
}

export async function startServer(options: ServerOptions): Promise<Server> {
  return new Server(options);
}
