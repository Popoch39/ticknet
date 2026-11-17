import { expect, test } from "bun:test";
import { connect, type Client } from "@ticknet/client";
import {
  MAX_DATAGRAM_MESSAGE_SIZE,
  MAX_DATAGRAM_SIZE,
  type OutgoingDatagram,
  type Transport,
} from "@ticknet/core";
import {
  ManualClock,
  SimulatedNetwork,
  type NetworkConditions,
} from "@ticknet/core/testing";
import {
  defineMessages,
  MAX_RELIABLE_MESSAGE_SIZE,
  startServer,
  type Connection,
  type Server,
} from "@ticknet/server";

const SERVER = { host: "10.0.0.1", port: 4000 };

const messages = defineMessages({
  blob: {
    id: 1,
    encode: (value: Uint8Array) => value,
    decode: (data: Uint8Array) => data,
  },
});

/** Lets every pending promise callback run, without moving the Clock. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** `size` bytes that differ from one `seed` to another and along their length, so that a misplaced piece shows. */
function bytes(size: number, seed = 1): Uint8Array {
  const data = new Uint8Array(size);
  let state = seed;
  for (let index = 0; index < size; index++) {
    state = (state * 1103515245 + 12345) >>> 0;
    data[index] = state >>> 24;
  }
  return data;
}

const STEP = 50;

/** Wraps a Transport to record every Datagram sent through it. */
function recorded(transport: Transport) {
  const sent: OutgoingDatagram[] = [];
  const recording: Transport = {
    listen: (receiver) => transport.listen(receiver),
    send: (datagrams) => {
      sent.push(...datagrams);
      return transport.send(datagrams);
    },
    close: () => transport.close(),
  };
  return { transport: recording, sent };
}

/** Wraps a Transport so that, while thinned, every other Datagram its endpoint sends is lost on the way. */
function thinnable(transport: Transport) {
  let thinned = false;
  const wrapped: Transport = {
    listen: (receiver) => transport.listen(receiver),
    send: (datagrams) => {
      if (!thinned) return transport.send(datagrams);
      // The lost ones count as sent: they were accepted, then lost.
      transport.send(datagrams.filter((_, index) => index % 2 === 0));
      return datagrams.length;
    },
    close: () => transport.close(),
  };
  return {
    transport: wrapped,
    thin: () => {
      thinned = true;
    },
    restore: () => {
      thinned = false;
    },
  };
}

const CLIENT = { host: "10.0.0.2", port: 50000 };

/** Connects a Client sending at 20 Hz through `transport`, moving the Clock until it is connected. */
async function connectClient(clock: ManualClock, transport: Transport) {
  let client: Client | undefined;
  let failure: unknown;
  connect({ ...SERVER, transport, clock, sendRate: 1000 / STEP }).then(
    (opened) => (client = opened),
    (error: unknown) => (failure = error),
  );
  while (!client && failure === undefined) {
    clock.advance(1);
    await settle();
  }
  if (!client) throw failure;
  return client;
}

/**
 * A Server at 20 Ticks per second and one Client sending at 20 Hz from
 * CLIENT, connected over a simulated network with the given conditions.
 * Every Datagram either side sends is recorded, and the Client's link can be
 * thinned.
 */
async function connected(
  options: { seed?: number; conditions?: NetworkConditions } = {},
) {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({
    clock,
    seed: options.seed,
    conditions: options.conditions,
  });
  const serverSide = recorded(network.bind(SERVER));
  const server = await startServer({
    transport: serverSide.transport,
    clock,
    tickRate: 1000 / STEP,
  });
  let connection: Connection | undefined;
  server.on("connectionOpened", (opened) => (connection = opened));
  const clientLink = thinnable(network.bind(CLIENT));
  const clientSide = recorded(clientLink.transport);
  const client = await connectClient(clock, clientSide.transport);
  if (!connection) throw new Error("Expected the Server to open a Connection");
  const sent = () => [...serverSide.sent, ...clientSide.sent];
  return { clock, network, server, client, connection, clientLink, sent };
}

/** Records, on each side, the blobs delivered from the other. */
function received(server: Server, client: Client) {
  const atServer: Uint8Array[] = [];
  const atClient: Uint8Array[] = [];
  server.onMessage(messages.blob, (_from, value) => atServer.push(value));
  client.onMessage(messages.blob, (value) => atClient.push(value));
  return { atServer, atClient };
}

test("a Reliable Message many times larger than a Datagram is delivered intact, in each direction", async () => {
  const { clock, server, client, connection } = await connected();
  const { atServer, atClient } = received(server, client);
  const toServer = bytes(100_000, 1);
  const toClient = bytes(100_000, 2);

  client.send(messages.blob, toServer, "reliable");
  connection.send(messages.blob, toClient, "reliable");
  clock.advance(2000);

  expect(atServer).toEqual([toServer]);
  expect(atClient).toEqual([toClient]);
});

const badLink: NetworkConditions = {
  loss: 0.2,
  reordering: 0.2,
  duplication: 0.2,
  latency: 30,
  jitter: 20,
};

test("under seeded loss, reordering and duplication, large Reliable Messages are delivered intact, exactly once, both ways", async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { clock, server, client, connection } = await connected({
      seed,
      conditions: badLink,
    });
    const { atServer, atClient } = received(server, client);
    const toServer = [bytes(60_000, seed), bytes(5000, seed + 10)];
    const toClient = [bytes(60_000, seed + 20), bytes(5000, seed + 30)];

    for (const [index, body] of toServer.entries()) {
      client.send(messages.blob, body, "reliable");
      connection.send(messages.blob, toClient[index] ?? body, "reliable");
      clock.advance(STEP);
    }
    clock.advance(10_000);

    expect(atServer).toEqual(toServer);
    expect(atClient).toEqual(toClient);
  }
});

test("a large Reliable Message keeps its place in the Reliable stream, between the Reliable Messages sent before and after it", async () => {
  for (const seed of [1, 2, 3]) {
    const { clock, server, client, connection } = await connected({
      seed,
      conditions: badLink,
    });
    const { atServer, atClient } = received(server, client);
    const large = bytes(30_000, seed);
    const sent = [
      ...[1, 2, 3].map((value) => Uint8Array.of(value)),
      large,
      ...[4, 5, 6].map((value) => Uint8Array.of(value)),
    ];

    for (const body of sent) {
      client.send(messages.blob, body, "reliable");
      connection.send(messages.blob, body, "reliable");
    }
    clock.advance(10_000);

    expect(atServer).toEqual(sent);
    expect(atClient).toEqual(sent);
  }
});

test("no Datagram exceeds 1200 bytes while Fragments are in flight, alongside other Messages", async () => {
  const { clock, client, connection, sent } = await connected({
    conditions: badLink,
  });

  for (let step = 0; step < 20; step++) {
    client.send(messages.blob, bytes(20_000, step), "reliable");
    connection.send(messages.blob, bytes(20_000, step), "reliable");
    for (const delivery of ["unreliable", "sequenced", "reliable"] as const) {
      client.send(messages.blob, bytes(700, step), delivery);
      connection.send(messages.blob, bytes(700, step), delivery);
    }
    clock.advance(STEP);
  }
  clock.advance(10_000);

  const sizes = sent().map(({ data }) => data.byteLength);
  expect(Math.max(...sizes)).toBe(MAX_DATAGRAM_SIZE);
  expect(MAX_DATAGRAM_SIZE).toBe(1200);
});

test("an Unreliable or Sequenced Message too large for one Datagram still fails immediately rather than being fragmented", async () => {
  const { clock, server, client, connection } = await connected();
  const { atServer, atClient } = received(server, client);

  for (const delivery of ["unreliable", "sequenced"] as const) {
    const tooLarge = bytes(MAX_DATAGRAM_MESSAGE_SIZE + 1);
    const error = /must fit in one Datagram/;
    expect(() => client.send(messages.blob, tooLarge, delivery)).toThrow(error);
    expect(() => connection.send(messages.blob, tooLarge, delivery)).toThrow(
      error,
    );
    expect(() => server.broadcast(messages.blob, tooLarge, delivery)).toThrow(
      error,
    );
  }
  clock.advance(1000);

  expect(atServer).toEqual([]);
  expect(atClient).toEqual([]);
});

test("a Reliable Message of the documented maximum size is delivered, and one byte more fails immediately with a clear error", async () => {
  const { clock, server, client, connection } = await connected();
  const { atServer, atClient } = received(server, client);
  const largest = bytes(MAX_RELIABLE_MESSAGE_SIZE);
  const tooLarge = bytes(MAX_RELIABLE_MESSAGE_SIZE + 1);

  const error = `Message id 1 is ${MAX_RELIABLE_MESSAGE_SIZE + 1} bytes once encoded; a Reliable Message holds at most ${MAX_RELIABLE_MESSAGE_SIZE} bytes`;
  expect(() => client.send(messages.blob, tooLarge, "reliable")).toThrow(error);
  expect(() => connection.send(messages.blob, tooLarge, "reliable")).toThrow(
    error,
  );
  expect(() => server.broadcast(messages.blob, tooLarge, "reliable")).toThrow(
    error,
  );

  client.send(messages.blob, largest, "reliable");
  connection.send(messages.blob, largest, "reliable");
  clock.advance(5000);
  expect(atServer).toEqual([largest]);
  expect(atClient).toEqual([largest]);
});

test("a Connection that closes in the middle of a large Reliable Message drops the partial Message, and a new Connection from the same address starts afresh", async () => {
  const { clock, network, server, client, clientLink } = await connected();
  const atServer: Uint8Array[] = [];
  server.onMessage(messages.blob, (_from, value) => atServer.push(value));
  const closed: string[] = [];
  server.on("connectionClosed", (_connection, reason) =>
    closed.push(reason.kind),
  );

  // Every other Fragment is lost, so the Server holds part of the Message when the Client leaves.
  clientLink.thin();
  client.send(messages.blob, bytes(20_000, 1), "reliable");
  clock.advance(STEP);
  clientLink.restore();
  client.close();
  clock.advance(5000);
  expect(closed).toEqual(["closedByClient"]);
  expect(atServer).toEqual([]);

  const again = await connectClient(clock, network.bind(CLIENT));
  const resent = bytes(20_000, 2);
  again.send(messages.blob, resent, "reliable");
  clock.advance(5000);

  expect(atServer).toEqual([resent]);
});
