import { expect, test } from "bun:test";
import {
  connect,
  DEFAULT_SEND_BUDGET as CLIENT_DEFAULT_SEND_BUDGET,
  type Client,
} from "@ticknet/client";
import { MAX_DATAGRAM_SIZE, type Transport } from "@ticknet/core";
import {
  ManualClock,
  SimulatedNetwork,
  type NetworkConditions,
} from "@ticknet/core/testing";
import {
  DEFAULT_SEND_BUDGET,
  defineMessages,
  startServer,
  type Connection,
} from "@ticknet/server";

const SERVER = { host: "10.0.0.1", port: 4000 };
const CLIENT = { host: "10.0.0.2", port: 50000 };

const messages = defineMessages({
  blob: {
    id: 1,
    encode: (value: Uint8Array) => value,
    decode: (data: Uint8Array) => data,
  },
  chat: {
    id: 2,
    encode: (value: number) => {
      const data = new Uint8Array(4);
      new DataView(data.buffer).setUint32(0, value);
      return data;
    },
    decode: (data: Uint8Array) =>
      new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0),
  },
});

/** Lets every pending promise callback run, without moving the Clock. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const range = (count: number) => Array.from({ length: count }, (_, i) => i);

const STEP = 50;

/**
 * Wraps a Transport to add up the bytes its endpoint puts on the network, by
 * the time they left and where they went.
 */
function metered(transport: Transport, clock: ManualClock) {
  const bytes = new Map<string, number>();
  const wrapped: Transport = {
    listen: (receiver) => transport.listen(receiver),
    send: (datagrams) => {
      for (const { to, data } of datagrams) {
        const key = `${clock.now()} ${to.host}`;
        bytes.set(key, (bytes.get(key) ?? 0) + data.byteLength);
      }
      return transport.send(datagrams);
    },
    close: () => transport.close(),
  };
  return {
    transport: wrapped,
    /** The most bytes put on the network towards one address at one time. */
    largest: () => Math.max(0, ...bytes.values()),
  };
}

/**
 * A Server at 20 Ticks per second and one Client sending at 20 Hz, both with
 * the given Send budget, connected over a simulated network with the given
 * conditions. Each side's bytes are metered once the Connection is open.
 */
async function connected(
  options: {
    sendBudget?: number;
    seed?: number;
    conditions?: NetworkConditions;
    timeout?: number;
  } = {},
) {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({
    clock,
    seed: options.seed,
    conditions: options.conditions,
  });
  const serverSide = metered(network.bind(SERVER), clock);
  const server = await startServer({
    transport: serverSide.transport,
    clock,
    tickRate: 1000 / STEP,
    timeout: options.timeout,
    sendBudget: options.sendBudget,
  });
  let connection: Connection | undefined;
  server.on("connectionOpened", (opened) => (connection = opened));
  const clientSide = metered(network.bind(CLIENT), clock);
  let client: Client | undefined;
  let failure: unknown;
  connect({
    ...SERVER,
    transport: clientSide.transport,
    clock,
    sendRate: 1000 / STEP,
    timeout: options.timeout,
    sendBudget: options.sendBudget,
  }).then(
    (opened) => (client = opened),
    (error: unknown) => (failure = error),
  );
  while (!client && failure === undefined) {
    clock.advance(1);
    await settle();
  }
  if (!client) throw failure;
  if (!connection) throw new Error("Expected the Server to open a Connection");
  return {
    clock,
    network,
    server,
    client,
    connection,
    serverSide,
    clientSide,
  };
}

/** 300 bytes: three fit in a 1200-byte budget with their Datagram, a fourth does not. */
const QUARTER = new Uint8Array(300);

test("an Unreliable or Sequenced Message sent once the Tick's Send budget is spent is refused without throwing, and never delivered", async () => {
  for (const delivery of ["unreliable", "sequenced"] as const) {
    const { clock, server, client, connection } = await connected({
      sendBudget: 1200,
    });
    let atServer = 0;
    let atClient = 0;
    server.onMessage(messages.blob, () => atServer++);
    client.onMessage(messages.blob, () => atClient++);

    const fromClient = range(4).map(() =>
      client.send(messages.blob, QUARTER, delivery),
    );
    const fromServer = range(4).map(() =>
      connection.send(messages.blob, QUARTER, delivery),
    );
    clock.advance(500);

    expect(fromClient).toEqual([true, true, true, false]);
    expect(fromServer).toEqual([true, true, true, false]);
    expect(atServer).toBe(3);
    expect(atClient).toBe(3);
  }
});

const badLink: NetworkConditions = {
  loss: 0.2,
  reordering: 0.2,
  duplication: 0.2,
  latency: 30,
  jitter: 20,
};

test("Reliable Messages over the Send budget are sent in later Ticks, exactly once and in order, and no Tick goes over the budget, resends and acknowledgements included", async () => {
  for (const seed of [1, 2, 3]) {
    const { clock, server, client, connection, serverSide, clientSide } =
      await connected({ sendBudget: 1200, seed, conditions: badLink });
    const atServer: number[] = [];
    const atClient: number[] = [];
    server.onMessage(messages.chat, (_from, value) => atServer.push(value));
    client.onMessage(messages.chat, (value) => atClient.push(value));

    // About ten Datagrams' worth each way, where the budget lets one leave per Tick.
    for (const value of range(1000)) {
      expect(client.send(messages.chat, value, "reliable")).toBe(true);
      expect(connection.send(messages.chat, value, "reliable")).toBe(true);
    }
    clock.advance(10_000);

    expect(atServer).toEqual(range(1000));
    expect(atClient).toEqual(range(1000));
    expect(serverSide.largest()).toBeLessThanOrEqual(1200);
    expect(clientSide.largest()).toBeLessThanOrEqual(1200);
  }
});

/** Sends Unreliable Messages through `send` until the budget refuses one, to the last byte. */
function fill(
  send: (body: Uint8Array) => boolean,
  sizes = [QUARTER, new Uint8Array(1)],
) {
  for (const body of sizes) while (send(body));
}

test("when the game fills the Send budget every Tick, acknowledgements and waiting Reliable Messages still get through and the Connection does not time out", async () => {
  const { clock, server, client, connection, serverSide, clientSide } =
    await connected({
      sendBudget: 1200,
      timeout: 1000,
      conditions: { latency: 30 },
    });
  const atServer: number[] = [];
  const atClient: number[] = [];
  server.onMessage(messages.chat, (_from, value) => atServer.push(value));
  client.onMessage(messages.chat, (value) => atClient.push(value));
  const closed: string[] = [];
  server.on("connectionClosed", (_connection, reason) =>
    closed.push(`Server: ${reason.kind}`),
  );
  client.on("connectionClosed", (reason) =>
    closed.push(`Client: ${reason.kind}`),
  );

  for (const step of range(200)) {
    fill((body) => client.send(messages.blob, body, "unreliable"));
    fill((body) => connection.send(messages.blob, body, "unreliable"));
    // Sent once the budget is spent, so they wait for a later Tick.
    if (step % 10 === 0) {
      client.send(messages.chat, step / 10, "reliable");
      connection.send(messages.chat, step / 10, "reliable");
    }
    clock.advance(STEP);
  }
  clock.advance(STEP);

  expect(closed).toEqual([]);
  expect(atServer).toEqual(range(20));
  expect(atClient).toEqual(range(20));
  expect(serverSide.largest()).toBeLessThanOrEqual(1200);
  expect(clientSide.largest()).toBeLessThanOrEqual(1200);
});

test("without a configured Send budget, each side may put DEFAULT_SEND_BUDGET bytes on the network per Tick, a few full Datagrams", async () => {
  const { clock, client, connection, serverSide, clientSide } =
    await connected();
  expect(CLIENT_DEFAULT_SEND_BUDGET).toBe(DEFAULT_SEND_BUDGET);
  expect(DEFAULT_SEND_BUDGET).toBeGreaterThanOrEqual(2 * MAX_DATAGRAM_SIZE);
  expect(DEFAULT_SEND_BUDGET).toBeLessThanOrEqual(8 * MAX_DATAGRAM_SIZE);

  fill((body) => client.send(messages.blob, body, "unreliable"));
  fill((body) => connection.send(messages.blob, body, "unreliable"));
  clock.advance(STEP);

  // Filled to the last byte the smallest Message can take, a header and one byte of body.
  for (const side of [serverSide, clientSide]) {
    expect(side.largest()).toBeLessThanOrEqual(DEFAULT_SEND_BUDGET);
    expect(side.largest()).toBeGreaterThan(DEFAULT_SEND_BUDGET - 6);
  }
});

test("a broadcast tells which Connections refused it for lack of budget; the others still get it", async () => {
  const { clock, network, server, client, connection } = await connected({
    sendBudget: 1200,
  });
  const opened: Connection[] = [];
  server.on("connectionOpened", (other) => opened.push(other));
  const connecting = connect({
    ...SERVER,
    transport: network.bind({ host: "10.0.0.3", port: 50000 }),
    clock,
    sendRate: 1000 / STEP,
  });
  clock.advance(0);
  const other = await connecting;
  let atClient = 0;
  let atOther = 0;
  client.onMessage(messages.blob, () => atClient++);
  other.onMessage(messages.blob, () => atOther++);

  fill((body) => connection.send(messages.blob, body, "unreliable"), [QUARTER]);
  const refused = server.broadcast(messages.blob, QUARTER, "sequenced");
  clock.advance(STEP);

  expect(refused).toEqual([connection]);
  expect(opened).toHaveLength(1);
  expect(atClient).toBe(3);
  expect(atOther).toBe(1);
});

/** Records how `promise` settles, so that one that never settles fails the test rather than blocking it. */
function track(promise: Promise<unknown>): { failure?: unknown } {
  const outcome: { failure?: unknown } = {};
  promise.catch((error: unknown) => {
    outcome.failure = error;
  });
  return outcome;
}

test("a Send budget too small to carry a full Datagram is rejected when the Server or the Client is created", async () => {
  for (const sendBudget of [1199, 0, -1, 1200.5, Number.NaN]) {
    const clock = new ManualClock();
    const network = new SimulatedNetwork({ clock });
    const starting = track(
      startServer({ transport: network.bind(SERVER), clock, sendBudget }),
    );
    const connecting = track(
      connect({
        ...SERVER,
        transport: network.bind(CLIENT),
        clock,
        sendBudget,
      }),
    );
    await settle();

    expect(starting.failure).toBeInstanceOf(RangeError);
    expect(connecting.failure).toBeInstanceOf(RangeError);
    expect(String(connecting.failure)).toContain("Send budget");
  }
});

test("the Send budget is restored at each Tick, and what a Tick leaves unused is not carried over", async () => {
  const { clock, client, connection } = await connected({ sendBudget: 1200 });
  const sendFour = () => ({
    fromClient: range(4).map(() =>
      client.send(messages.blob, QUARTER, "unreliable"),
    ),
    fromServer: range(4).map(() =>
      connection.send(messages.blob, QUARTER, "unreliable"),
    ),
  });
  const threeOfFour = {
    fromClient: [true, true, true, false],
    fromServer: [true, true, true, false],
  };

  expect(sendFour()).toEqual(threeOfFour);
  clock.advance(STEP);
  expect(sendFour()).toEqual(threeOfFour);
  // Ten quiet Ticks leave the next one no more than its own budget.
  clock.advance(11 * STEP);
  expect(sendFour()).toEqual(threeOfFour);
});
