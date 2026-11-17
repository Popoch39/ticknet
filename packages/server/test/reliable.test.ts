import { expect, test } from "bun:test";
import { connect, type Client, type CloseReason } from "@ticknet/client";
import type { Transport } from "@ticknet/core";
import {
  ManualClock,
  SimulatedNetwork,
  type NetworkConditions,
} from "@ticknet/core/testing";
import {
  defineMessages,
  MAX_RELIABLE_BACKLOG,
  startServer,
  type Connection,
  type Server,
} from "@ticknet/server";

const SERVER = { host: "10.0.0.1", port: 4000 };

/** A 32-bit unsigned integer, big-endian. */
const u32 = {
  encode: (value: number) => {
    const data = new Uint8Array(4);
    new DataView(data.buffer).setUint32(0, value);
    return data;
  },
  decode: (data: Uint8Array) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0),
};

const messages = defineMessages({
  chat: { id: 1, ...u32 },
  score: { id: 2, ...u32 },
  position: { id: 3, ...u32 },
});

/** Lets every pending promise callback run, without moving the Clock. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const range = (count: number) => Array.from({ length: count }, (_, i) => i);

const STEP = 50;

/**
 * Wraps a Transport so that a test can cut its endpoint's link: while cut,
 * whatever it sends is lost on the way.
 */
function cuttable(transport: Transport) {
  let cut = false;
  const wrapped: Transport = {
    listen: (receiver) => transport.listen(receiver),
    send: (datagrams) => (cut ? datagrams.length : transport.send(datagrams)),
    close: () => transport.close(),
  };
  return {
    transport: wrapped,
    cut: () => {
      cut = true;
    },
    restore: () => {
      cut = false;
    },
  };
}

/**
 * A Server at 20 Ticks per second and one Client sending at 20 Hz, connected
 * over a simulated network with the given conditions, so that each Tick or
 * send step puts one Datagram on the network, closer together than the
 * 100 ms the simulated network holds one back for. Either endpoint's link
 * can be cut.
 */
async function connected(
  options: {
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
  const serverLink = cuttable(network.bind(SERVER));
  const server = await startServer({
    transport: serverLink.transport,
    clock,
    tickRate: 1000 / STEP,
    timeout: options.timeout,
  });
  let connection: Connection | undefined;
  server.on("connectionOpened", (opened) => (connection = opened));
  const clientLink = cuttable(network.bind({ host: "10.0.0.2", port: 50000 }));
  let client: Client | undefined;
  let failure: unknown;
  connect({
    ...SERVER,
    transport: clientLink.transport,
    clock,
    sendRate: 1000 / STEP,
    timeout: options.timeout,
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
  return { clock, server, client, connection, serverLink, clientLink };
}

/** Records, on each side, the values of `type` delivered from the other. */
function received(server: Server, client: Client, type: typeof messages.chat) {
  const atServer: number[] = [];
  const atClient: number[] = [];
  server.onMessage(type, (_from, value) => atServer.push(value));
  client.onMessage(type, (value) => atClient.push(value));
  return { atServer, atClient };
}

test("a Reliable Message is delivered in each direction", async () => {
  const { clock, server, client, connection } = await connected();
  const { atServer, atClient } = received(server, client, messages.chat);

  client.send(messages.chat, 7, "reliable");
  connection.send(messages.chat, 8, "reliable");
  clock.advance(200);

  expect(atServer).toEqual([7]);
  expect(atClient).toEqual([8]);
});

const badLink: NetworkConditions = {
  loss: 0.2,
  reordering: 0.2,
  duplication: 0.2,
  latency: 30,
  jitter: 20,
};

test("under loss, reordering and duplication together, every Reliable Message is delivered exactly once and in send order, both ways", async () => {
  for (const seed of [1, 2, 3]) {
    const { clock, server, client, connection } = await connected({
      seed,
      conditions: badLink,
    });
    const { atServer, atClient } = received(server, client, messages.chat);

    for (const value of range(300)) {
      client.send(messages.chat, value, "reliable");
      connection.send(messages.chat, value, "reliable");
      if (value % 3 === 2) clock.advance(STEP);
    }
    clock.advance(5000);

    expect(atServer).toEqual(range(300));
    expect(atClient).toEqual(range(300));
  }
});

test("Reliable Messages of different types are delivered in the order they were sent, not in an order per type", async () => {
  const { clock, server, client, connection } = await connected({
    conditions: badLink,
  });
  const atServer: [string, number][] = [];
  const atClient: [string, number][] = [];
  for (const type of [messages.chat, messages.score]) {
    server.onMessage(type, (_from, value) => atServer.push([type.name, value]));
    client.onMessage(type, (value) => atClient.push([type.name, value]));
  }

  const sent: [string, number][] = [];
  for (const value of range(300)) {
    const type = value % 3 === 0 ? messages.score : messages.chat;
    client.send(type, value, "reliable");
    connection.send(type, value, "reliable");
    sent.push([type.name, value]);
    if (value % 3 === 2) clock.advance(STEP);
  }
  clock.advance(5000);

  expect(atServer).toEqual(sent);
  expect(atClient).toEqual(sent);
});

test("a Reliable Message sent while the link drops everything is delivered once the link recovers, before the Connection times out", async () => {
  const { clock, server, client, connection, serverLink, clientLink } =
    await connected({ timeout: 10_000 });
  const { atServer, atClient } = received(server, client, messages.chat);
  const closed: string[] = [];
  server.on("connectionClosed", (_connection, reason) =>
    closed.push(`Server: ${reason.kind}`),
  );
  client.on("connectionClosed", (reason) =>
    closed.push(`Client: ${reason.kind}`),
  );
  client.send(messages.chat, 1, "reliable");
  connection.send(messages.chat, 1, "reliable");
  clock.advance(1000);

  serverLink.cut();
  clientLink.cut();
  client.send(messages.chat, 2, "reliable");
  connection.send(messages.chat, 2, "reliable");
  clock.advance(9000);
  expect(atServer).toEqual([1]);
  expect(atClient).toEqual([1]);

  serverLink.restore();
  clientLink.restore();
  clock.advance(2000);

  expect(atServer).toEqual([1, 2]);
  expect(atClient).toEqual([1, 2]);
  expect(closed).toEqual([]);
});

test("Unreliable and Sequenced Messages keep flowing while a Reliable Message waits to be resent", async () => {
  const { clock, server, client, connection, clientLink } = await connected({
    conditions: { latency: 100 },
  });
  const arrived: [string, number][] = [];
  server.onMessage(messages.chat, (_from, value) =>
    arrived.push(["reliable", value]),
  );
  server.onMessage(messages.score, (_from, value) =>
    arrived.push(["unreliable", value]),
  );
  server.onMessage(messages.position, (_from, value) =>
    arrived.push(["sequenced", value]),
  );
  // Long enough to measure the round-trip time, of 200 ms, which no resend comes before.
  for (const _ of range(20)) {
    client.send(messages.score, 0, "unreliable");
    connection.send(messages.score, 0, "unreliable");
    clock.advance(STEP);
  }
  clock.advance(1000);
  arrived.length = 0;

  clientLink.cut();
  client.send(messages.chat, 1, "reliable");
  clock.advance(STEP);
  clientLink.restore();
  // The second Reliable Message arrives at once, but waits for the first one to be resent.
  client.send(messages.chat, 2, "reliable");
  for (const value of range(4)) {
    client.send(messages.score, value, "unreliable");
    client.send(messages.position, value, "sequenced");
    clock.advance(STEP);
  }
  clock.advance(1000);

  expect(arrived).toEqual([
    ...range(4).flatMap((value): [string, number][] => [
      ["unreliable", value],
      ["sequenced", value],
    ]),
    ["reliable", 1],
    ["reliable", 2],
  ]);
});

test("a long-running Connection keeps delivering Reliable Messages exactly once and in order after its sequence counters wrap around", async () => {
  const { clock, server, client, connection } = await connected({
    conditions: badLink,
  });
  const { atServer, atClient } = received(server, client, messages.chat);

  // Well past 2^16 Reliable Messages each way, over several thousand Datagrams.
  const count = 70_000;
  const perStep = 14;
  for (let value = 0; value < count; value++) {
    client.send(messages.chat, value, "reliable");
    connection.send(messages.chat, value, "reliable");
    if (value % perStep === perStep - 1) clock.advance(STEP);
  }
  clock.advance(5000);

  for (const values of [atServer, atClient]) {
    expect(values.findIndex((value, index) => value !== index)).toBe(-1);
    expect(values).toHaveLength(count);
  }
});

/**
 * A Server at 20 Ticks per second that sends a Reliable Message to each
 * Client as its Connection opens, and the number of each Tick to every
 * Client, and a Client connecting to it without moving the Clock yet.
 */
async function welcomingServer() {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock });
  const server = await startServer({
    transport: network.bind(SERVER),
    clock,
    tickRate: 1000 / STEP,
  });
  const opened: Connection[] = [];
  server.on("connectionOpened", (connection) => {
    opened.push(connection);
    connection.send(messages.chat, 0, "reliable");
  });
  server.on("tick", (tick) =>
    server.broadcast(messages.score, tick, "reliable"),
  );
  const connecting = connect({
    ...SERVER,
    transport: network.bind({ host: "10.0.0.2", port: 50000 }),
    clock,
    sendRate: 1000 / STEP,
  });
  return { clock, opened, connecting };
}

test("Reliable Messages that arrive before connect resolves reach the handlers registered right after it, in order", async () => {
  const { clock, connecting } = await welcomingServer();
  // A single move of the Clock runs the Handshake and four Ticks before the code awaiting connect can run.
  clock.advance(4 * STEP);

  const client = await connecting;
  const arrived: [string, number][] = [];
  client.onMessage(messages.chat, (value) => arrived.push(["chat", value]));
  client.onMessage(messages.score, (value) => arrived.push(["score", value]));
  // Synchronously, as a test moving the Clock right after registering does.
  clock.advance(2 * STEP);

  expect(arrived).toEqual([
    ["chat", 0],
    ...range(6).map((index): [string, number] => ["score", index + 1]),
  ]);
});

test("Messages held until connect resolved are delivered before a close that followed them", async () => {
  const { clock, opened, connecting } = await welcomingServer();
  clock.advance(2 * STEP);
  opened[0]?.close(7);
  clock.advance(0);

  const client = await connecting;
  const arrived: string[] = [];
  client.onMessage(messages.chat, (value) => arrived.push(`chat ${value}`));
  client.onMessage(messages.score, (value) => arrived.push(`score ${value}`));
  client.on("connectionClosed", (reason) => arrived.push(reason.kind));
  await settle();

  expect(arrived).toEqual(["chat 0", "score 1", "score 2", "closedByServer"]);
});

test("when the Reliable backlog of a Connection passes its limit, the Connection is closed on both sides with a backlog overflow reason", async () => {
  for (const overflowing of ["Server", "Client"] as const) {
    const { clock, server, client, connection, serverLink, clientLink } =
      await connected();
    const closed: [string, CloseReason][] = [];
    server.on("connectionClosed", (_connection, reason) =>
      closed.push(["Server", reason]),
    );
    client.on("connectionClosed", (reason) => closed.push(["Client", reason]));
    const send = (value: number) =>
      overflowing === "Server"
        ? connection.send(messages.chat, value, "reliable")
        : client.send(messages.chat, value, "reliable");
    // The other side stops acknowledging anything: what it sends is lost.
    (overflowing === "Server" ? clientLink : serverLink).cut();

    for (const value of range(MAX_RELIABLE_BACKLOG)) send(value);
    clock.advance(1000);
    expect(closed).toEqual([]);

    send(MAX_RELIABLE_BACKLOG);
    clock.advance(1000);

    const reason: CloseReason = { kind: "reliableBacklogOverflow" };
    expect(closed).toContainEqual(["Server", reason]);
    expect(closed).toContainEqual(["Client", reason]);
    expect(closed).toHaveLength(2);
    expect(() => send(0)).toThrow(/closed/);
  }
});
