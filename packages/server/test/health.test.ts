import { expect, test } from "bun:test";
import { connect, type Client } from "@ticknet/client";
import {
  ManualClock,
  SimulatedNetwork,
  type NetworkConditions,
} from "@ticknet/core/testing";
import {
  defineMessages,
  startServer,
  type Connection,
  type Server,
  type Transport,
} from "@ticknet/server";
import { SERVER, settle } from "./support";

const CLIENT = { host: "10.0.0.2", port: 50000 };

const messages = defineMessages({
  ping: {
    id: 1,
    encode: (value: number) => Uint8Array.of(value),
    decode: (data: Uint8Array) => data[0] ?? 0,
  },
});

/**
 * A Server and one connected Client on a simulated network with the given
 * conditions, both at their default rates of 30 Hz.
 */
async function connected(
  options: {
    seed?: number;
    conditions?: NetworkConditions;
    wrapClient?: (transport: Transport, clock: ManualClock) => Transport;
  } = {},
): Promise<{
  clock: ManualClock;
  server: Server;
  client: Client;
  connection: Connection;
}> {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({
    clock,
    seed: options.seed,
    conditions: options.conditions,
  });
  const server = await startServer({ transport: network.bind(SERVER), clock });
  let connection: Connection | undefined;
  server.on("connectionOpened", (opened) => (connection = opened));
  let client: Client | undefined;
  let failure: unknown;
  const clientTransport = network.bind(CLIENT);
  connect({
    ...SERVER,
    transport: options.wrapClient?.(clientTransport, clock) ?? clientTransport,
    clock,
  }).then(
    (connectedClient) => (client = connectedClient),
    (error: unknown) => (failure = error),
  );
  while (!client && failure === undefined) {
    clock.advance(1);
    await settle();
  }
  if (!client) throw failure;
  if (!connection) throw new Error("Expected the Server to open a Connection");
  return { clock, server, client, connection };
}

test("before any acknowledgement, neither side reports a round-trip time or a loss rate", async () => {
  const { client, connection } = await connected();

  expect(connection.roundTripTime).toBeUndefined();
  expect(connection.lossRate).toBeUndefined();
  expect(client.roundTripTime).toBeUndefined();
  expect(client.lossRate).toBeUndefined();
});

/** Fails unless `value` is a number within `tolerance` of `expected`. */
function expectNear(
  value: number | undefined,
  expected: number,
  tolerance: number,
) {
  expect(value).toBeNumber();
  expect(Math.abs((value ?? Number.NaN) - expected)).toBeLessThanOrEqual(
    tolerance,
  );
}

/** Both sides send a Message every `interval` milliseconds for `duration` milliseconds. */
function chat(
  { clock, client, connection }: Awaited<ReturnType<typeof connected>>,
  duration: number,
  interval = 10,
) {
  for (let elapsed = 0; elapsed < duration; elapsed += interval) {
    client.send(messages.ping, 1, "unreliable");
    connection.send(messages.ping, 1, "unreliable");
    clock.advance(interval);
  }
}

test("with a fixed latency and no loss, both sides measure a round-trip time of twice that latency", async () => {
  const pair = await connected({ conditions: { latency: 40 } });

  chat(pair, 2000);

  expectNear(pair.connection.roundTripTime, 80, 2);
  expectNear(pair.client.roundTripTime, 80, 2);
});

test("on a link without loss, both sides report a loss rate of zero", async () => {
  const pair = await connected({ conditions: { latency: 40 } });

  chat(pair, 2000);

  expect(pair.connection.lossRate).toBe(0);
  expect(pair.client.lossRate).toBe(0);
});

test("on a link with a known loss rate, both sides report a loss rate close to it", async () => {
  for (const seed of [1, 2, 3]) {
    const pair = await connected({
      seed,
      conditions: { latency: 40, loss: 0.2 },
    });

    chat(pair, 20_000);

    expectNear(pair.connection.lossRate, 0.2, 0.06);
    expectNear(pair.client.lossRate, 0.2, 0.06);
  }
});

test("duplicated and reordered Datagrams count neither as lost nor as slower round trips", async () => {
  for (const seed of [1, 2, 3]) {
    const pair = await connected({
      seed,
      conditions: { latency: 40, duplication: 0.3, reordering: 0.3 },
    });

    chat(pair, 10_000);

    expect(pair.connection.lossRate).toBe(0);
    expect(pair.client.lossRate).toBe(0);
    expectNear(pair.connection.roundTripTime, 80, 2);
    expectNear(pair.client.roundTripTime, 80, 2);
  }
});

test("when only one side sends Messages, both sides still measure the round-trip time and the loss rate", async () => {
  for (const sender of ["server", "client"] as const) {
    const pair = await connected({ conditions: { latency: 40 } });

    for (let elapsed = 0; elapsed < 2000; elapsed += 10) {
      if (sender === "server")
        pair.connection.send(messages.ping, 1, "unreliable");
      else pair.client.send(messages.ping, 1, "unreliable");
      pair.clock.advance(10);
    }

    expectNear(pair.connection.roundTripTime, 80, 2);
    expectNear(pair.client.roundTripTime, 80, 2);
    expect(pair.connection.lossRate).toBe(0);
    expect(pair.client.lossRate).toBe(0);
  }
});

/** Holds back every Datagram `transport` sends by `latency.value` milliseconds, which a test may change at any time. */
function withAdjustableLatency(latency: { value: number }) {
  return (transport: Transport, clock: ManualClock): Transport => ({
    listen: (receiver) => transport.listen(receiver),
    send(datagrams) {
      const held = [...datagrams];
      clock.schedule(clock.now() + latency.value, () => transport.send(held));
      return datagrams.length;
    },
    close: () => transport.close(),
  });
}

test("on a Connection where no Message is ever sent, both sides still report health values that follow the link", async () => {
  const latency = { value: 30 };
  const pair = await connected({ wrapClient: withAdjustableLatency(latency) });

  pair.clock.advance(5000);

  expectNear(pair.connection.roundTripTime, 30, 2);
  expectNear(pair.client.roundTripTime, 30, 2);
  expect(pair.connection.lossRate).toBe(0);
  expect(pair.client.lossRate).toBe(0);

  latency.value = 150;
  pair.clock.advance(30_000);

  expectNear(pair.connection.roundTripTime, 150, 5);
  expectNear(pair.client.roundTripTime, 150, 5);
});

test("when the latency of the link changes, the round-trip time follows within a few seconds", async () => {
  const latency = { value: 30 };
  const pair = await connected({ wrapClient: withAdjustableLatency(latency) });
  chat(pair, 2000);
  expectNear(pair.connection.roundTripTime, 30, 2);
  expectNear(pair.client.roundTripTime, 30, 2);

  latency.value = 150;
  chat(pair, 3000);

  expectNear(pair.connection.roundTripTime, 150, 2);
  expectNear(pair.client.roundTripTime, 150, 2);

  latency.value = 60;
  chat(pair, 3000);

  expectNear(pair.connection.roundTripTime, 60, 2);
  expectNear(pair.client.roundTripTime, 60, 2);
});
