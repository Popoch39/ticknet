// What the Server tests share: a Server on a simulated network driven by a
// manual Clock, and ways to connect Clients to it.
import { connect, type Client, type ClientOptions } from "@ticknet/client";
import type { Transport } from "@ticknet/core";
import {
  ManualClock,
  SimulatedNetwork,
  type EndpointConditions,
  type NetworkConditions,
} from "@ticknet/core/testing";
import {
  startServer,
  type Address,
  type Authenticate,
  type CloseReason,
  type Connection,
  type Server,
  type ServerOptions,
} from "@ticknet/server";

/** Where the Server under test listens on the simulated network. */
export const SERVER: Address = { host: "10.0.0.1", port: 4000 };

/** Lets every pending promise callback run, without moving the Clock. */
export const settle = () => new Promise((resolve) => setImmediate(resolve));

export interface TestServerOptions extends Omit<
  ServerOptions,
  "transport" | "clock"
> {
  /** Conditions on every path of the network; perfect by default. */
  readonly conditions?: NetworkConditions;
  /** Decides which Datagrams the conditions hit. */
  readonly seed?: number;
  /** Conditions on the Server's own traffic only. */
  readonly serverConditions?: EndpointConditions;
  /** Wraps the Server's end of the network, for a test to record or cut what it sends. */
  readonly wrapServer?: (transport: Transport) => Transport;
}

/** How a test connects a Client; the Server, the Transport and the Clock come from the test's network. */
export interface TestClientOptions extends Omit<
  ClientOptions,
  "host" | "port" | "transport" | "clock"
> {
  /** Wraps the Client's end of the network, for a test to record or cut what it sends. */
  readonly wrap?: (transport: Transport) => Transport;
}

/** A Server on a simulated network, and what a test does with it. */
export interface TestServer<Data> {
  readonly clock: ManualClock;
  readonly network: SimulatedNetwork;
  readonly server: Server<Data>;
  /** Every Connection the Server opened, in order. */
  readonly opened: Connection<Data>[];
  /** Every Connection the Server closed, in order, with the reason. */
  readonly closed: [Connection<Data>, CloseReason][];
  /**
   * Starts connecting a Client from `address`, by default the next of
   * 10.0.0.2:50000, 10.0.0.2:50001…; moves no Clock.
   */
  connectFrom(address?: Address, options?: TestClientOptions): Promise<Client>;
  /**
   * Connects a Client as `connectFrom` does, moving the Clock only as far as
   * the Handshake needs, and returns it with its Connection on the Server.
   */
  connectClient(
    address?: Address,
    options?: TestClientOptions,
  ): Promise<{ client: Client; connection: Connection<Data> }>;
}

/** Starts a Server accepting every Client on a simulated network at time 0. */
export function setup(
  options?: TestServerOptions & { readonly authenticate?: undefined },
): Promise<TestServer<undefined>>;
/** Starts a Server asking `authenticate` about each Client on a simulated network at time 0. */
export function setup<Data>(
  options: TestServerOptions & { readonly authenticate: Authenticate<Data> },
): Promise<TestServer<Data>>;
// TestServer is invariant in its data type, so the implementation names both results for each overload to match.
export async function setup(
  options: TestServerOptions & {
    readonly authenticate?: Authenticate<unknown>;
  } = {},
): Promise<TestServer<unknown> | TestServer<undefined>> {
  const {
    conditions,
    seed,
    serverConditions,
    wrapServer = (transport) => transport,
    authenticate = () => ({ accept: true }),
    ...serverOptions
  } = options;
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock, conditions, seed });
  const server = await startServer({
    ...serverOptions,
    transport: wrapServer(network.bind(SERVER, serverConditions)),
    clock,
    authenticate,
  });
  const opened: Connection<unknown>[] = [];
  const closed: [Connection<unknown>, CloseReason][] = [];
  server.on("connectionOpened", (connection) => opened.push(connection));
  server.on("connectionClosed", (connection, reason) =>
    closed.push([connection, reason]),
  );
  let nextPort = 50000;

  const connectFrom = (
    address: Address = { host: "10.0.0.2", port: nextPort++ },
    {
      wrap = (transport) => transport,
      ...clientOptions
    }: TestClientOptions = {},
  ) =>
    connect({
      ...clientOptions,
      ...SERVER,
      transport: wrap(network.bind(address)),
      clock,
    });

  async function connectClient(
    address: Address = { host: "10.0.0.2", port: nextPort++ },
    clientOptions?: TestClientOptions,
  ) {
    let client: Client | undefined;
    let failure: unknown;
    connectFrom(address, clientOptions).then(
      (connected) => (client = connected),
      (error: unknown) => (failure = error),
    );
    clock.advance(0);
    await settle();
    while (!client && failure === undefined) {
      clock.advance(1);
      await settle();
    }
    if (!client) throw failure;
    // The latest, as a Client may connect again from the same address.
    const connection = opened.findLast(
      (connection) =>
        connection.address.host === address.host &&
        connection.address.port === address.port,
    );
    if (!connection)
      throw new Error("Expected the Server to open a Connection");
    return { client, connection };
  }

  return { clock, network, server, opened, closed, connectFrom, connectClient };
}
