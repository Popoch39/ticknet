import {
  ClientEngine,
  EngineDriver,
  type Clock,
  type CloseReason,
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

/** A Client connected to a Server. */
export class Client {}

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
        authToken: options.authToken,
      },
      options.clock.now(),
    );
    new EngineDriver(engine, options.transport, options.clock, (event) => {
      switch (event.type) {
        case "connectionOpened":
          resolve(new Client());
          break;
        case "connectionClosed":
          reject(new ConnectError(event.reason));
          break;
      }
    });
  });
}
