import { expect, test } from "bun:test";
import { connect, type Client } from "@ticknet/client";
import {
  ManualClock,
  SimulatedNetwork,
  withNetworkConditions,
  type EndpointConditions,
  type NetworkConditions,
} from "@ticknet/core/testing";
import {
  defineMessages,
  startServer,
  type Connection,
  type Server,
} from "@ticknet/server";

const SERVER = { host: "10.0.0.1", port: 4000 };

const messages = defineMessages({
  count: {
    id: 1,
    encode: (value: number) => Uint8Array.of(value >> 8, value & 0xff),
    decode: (data: Uint8Array) => ((data[0] ?? 0) << 8) | (data[1] ?? 0),
  },
});

/**
 * A Server at 10 Ticks per second on a simulated network with the given
 * conditions, and a way to connect Clients sending at 10 Hz too, so that each
 * Tick or Send step puts one Datagram on the network.
 */
async function setup(
  options: {
    seed?: number;
    conditions?: NetworkConditions;
    server?: EndpointConditions;
  } = {},
) {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({
    clock,
    seed: options.seed,
    conditions: options.conditions,
  });
  const server = await startServer({
    transport: network.bind(SERVER, options.server),
    clock,
    tickRate: 10,
  });
  const opened: Connection[] = [];
  server.on("connectionOpened", (connection) => opened.push(connection));
  let nextPort = 50000;

  /** Connects a Client, moving the Clock only as far as the Handshake needs. */
  async function connectClient(): Promise<{
    client: Client;
    connection: Connection;
  }> {
    let client: Client | undefined;
    let failure: unknown;
    connect({
      ...SERVER,
      transport: network.bind({ host: "10.0.0.2", port: nextPort++ }),
      clock,
      sendRate: 10,
    }).then(
      (connected) => (client = connected),
      (error: unknown) => (failure = error),
    );
    while (!client && failure === undefined) {
      clock.advance(1);
      await settle();
    }
    if (!client) throw failure;
    const connection = opened.find(
      ({ address }) => address.port === nextPort - 1,
    );
    if (!connection)
      throw new Error("Expected the Server to open a Connection");
    return { client, connection };
  }

  return { clock, network, server, connectClient };
}

/** Lets every pending promise callback run, without moving the Clock. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const range = (count: number) => Array.from({ length: count }, (_, i) => i);

/**
 * Sends `count` numbered Messages each way, one per Tick and Send step, then
 * waits long enough for any of them to arrive. Returns what each side got.
 */
async function exchange(
  clock: ManualClock,
  server: Server,
  { client, connection }: { client: Client; connection: Connection },
  count: number,
) {
  const atServer: number[] = [];
  const atClient: number[] = [];
  server.onMessage(messages.count, (from, value) => {
    if (from === connection) atServer.push(value);
  });
  client.onMessage(messages.count, (value) => atClient.push(value));
  for (const value of range(count)) {
    client.send(messages.count, value, "unreliable");
    connection.send(messages.count, value, "unreliable");
    clock.advance(100);
  }
  clock.advance(1000);
  return { atServer, atClient };
}

test("a Client connects although half the Datagrams are lost each way, whatever the seed", async () => {
  for (const seed of range(20)) {
    const { clock, connectClient } = await setup({
      seed,
      conditions: { loss: 0.5 },
    });
    const start = clock.now();

    await connectClient();

    expect(clock.now() - start).toBeLessThan(10_000);
  }
});

test("under loss, lost Unreliable Messages are simply absent and the Connection keeps carrying the others to the end", async () => {
  const { clock, server, connectClient } = await setup({
    conditions: { loss: 0.3 },
  });
  const pair = await connectClient();
  const errors: Error[] = [];
  pair.client.on("error", (error) => errors.push(error));
  server.on("error", (error) => errors.push(error));

  const { atServer, atClient } = await exchange(clock, server, pair, 200);

  for (const received of [atServer, atClient]) {
    expect(received.length).toBeGreaterThan(100);
    expect(received.length).toBeLessThan(180);
    // What arrives is a subsequence of what was sent: nothing invented, repeated or reordered.
    expect(received).toEqual([...new Set(received)].sort((a, b) => a - b));
    expect(received.some((value) => value >= 190)).toBe(true);
  }
  expect(errors).toEqual([]);
});

const badLink: NetworkConditions = {
  loss: 0.1,
  latency: 60,
  jitter: 40,
  reordering: 0.1,
  duplication: 0.1,
};

/**
 * Three Clients connected to one Server under every condition, each
 * exchanging numbered Messages with it; returns what everyone received, with
 * the time it arrived.
 */
async function busyServer(seed: number) {
  const { clock, server, connectClient } = await setup({
    seed,
    conditions: badLink,
  });
  const pairs = [
    await connectClient(),
    await connectClient(),
    await connectClient(),
  ];
  const atServer: [number, number, number][] = [];
  const atClients: [number, number, number][] = [];
  server.onMessage(messages.count, (from, value) =>
    atServer.push([
      pairs.findIndex(({ connection }) => connection === from),
      value,
      clock.now(),
    ]),
  );
  pairs.forEach(({ client }, index) =>
    client.onMessage(messages.count, (value) =>
      atClients.push([index, value, clock.now()]),
    ),
  );
  for (const value of range(100)) {
    for (const { client, connection } of pairs) {
      client.send(messages.count, value, "unreliable");
      connection.send(messages.count, value, "unreliable");
    }
    clock.advance(100);
  }
  clock.advance(1000);
  return { atServer, atClients };
}

test("a Server and several Clients run together on a bad link: each Message arrives at most once, from the right sender", async () => {
  const { atServer, atClients } = await busyServer(1);

  for (const received of [atServer, atClients])
    for (const index of range(3)) {
      const values = received
        .filter(([from]) => from === index)
        .map(([, value]) => value);
      expect(values.length).toBeGreaterThan(70);
      expect(new Set(values).size).toBe(values.length);
      for (const value of values) expect(value).toBeLessThan(100);
    }
});

test("the same test on the same seed replays the same deliveries at the same times; another seed does not", async () => {
  const first = await busyServer(5);

  expect(await busyServer(5)).toEqual(first);
  expect(await busyServer(6)).not.toEqual(first);
});

test("loss on the Client-to-Server path only leaves the Server-to-Client path whole", async () => {
  const { clock, server, connectClient } = await setup({
    server: { receive: { loss: 0.5 } },
  });

  const { atServer, atClient } = await exchange(
    clock,
    server,
    await connectClient(),
    100,
  );

  expect(atClient).toEqual(range(100));
  expect(atServer.length).toBeGreaterThan(30);
  expect(atServer.length).toBeLessThan(70);
});

test("a Client's injected Transport can be wrapped in network conditions, which run on the Client's own Clock", async () => {
  const { clock, network } = await setup();
  let connected = false;
  connect({
    ...SERVER,
    transport: network.bind({ host: "10.0.0.2", port: 50000 }),
    clock,
    wrapTransport: (transport, wrapClock) =>
      withNetworkConditions(transport, {
        clock: wrapClock,
        send: { latency: 50 },
        receive: { latency: 50 },
      }),
  }).then(() => (connected = true));

  // The Handshake takes two round trips of 100 ms on the Client's Clock.
  clock.advance(199);
  await settle();
  expect(connected).toBe(false);
  clock.advance(1);
  await settle();
  expect(connected).toBe(true);
});

test("with every Datagram duplicated, each Unreliable Message is still delivered exactly once, both ways", async () => {
  const { clock, server, connectClient } = await setup({
    conditions: { duplication: 1 },
  });
  const { atServer, atClient } = await exchange(
    clock,
    server,
    await connectClient(),
    50,
  );

  expect(atServer).toEqual(range(50));
  expect(atClient).toEqual(range(50));
});
