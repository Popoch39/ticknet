import {
  EngineDriver,
  ServerEngine,
  type Address,
  type Clock,
  type Transport,
} from "@ticknet/core";

export interface ServerOptions {
  readonly transport: Transport;
  readonly clock: Clock;
}

/** One Client's Connection to this Server. */
export class Connection {
  readonly address: Address;

  constructor(address: Address) {
    this.address = address;
  }
}

export interface ServerEvents {
  connectionOpened: (connection: Connection) => void;
}

export class Server {
  readonly #listeners: { [E in keyof ServerEvents]: Set<ServerEvents[E]> } = {
    connectionOpened: new Set(),
  };

  constructor(options: ServerOptions) {
    const engine = new ServerEngine({
      secret: crypto.getRandomValues(new Uint8Array(16)),
    });
    new EngineDriver(engine, options.transport, options.clock, (event) => {
      const connection = new Connection(event.address);
      for (const listener of this.#listeners.connectionOpened)
        listener(connection);
    });
  }

  on<E extends keyof ServerEvents>(event: E, listener: ServerEvents[E]): void {
    this.#listeners[event].add(listener);
  }
}

export async function startServer(options: ServerOptions): Promise<Server> {
  return new Server(options);
}
