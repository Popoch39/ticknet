import { expect, test } from "bun:test";
import type { Client } from "@ticknet/client";
import {
  MAX_DATAGRAM_MESSAGE_SIZE,
  MAX_DATAGRAM_SIZE,
  type OutgoingDatagram,
  type Transport,
} from "@ticknet/core";
import type { NetworkConditions } from "@ticknet/core/testing";
import {
  defineMessages,
  MAX_RELIABLE_MESSAGE_SIZE,
  type Server,
} from "@ticknet/server";
import { setup } from "./support";

const messages = defineMessages({
  blob: {
    id: 1,
    encode: (value: Uint8Array) => value,
    decode: (data: Uint8Array) => data,
  },
});

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

/** Records every Datagram sent through the Transports it wraps. */
function recorder() {
  const sent: OutgoingDatagram[] = [];
  return {
    sent,
    wrap: (transport: Transport): Transport => ({
      listen: (receiver) => transport.listen(receiver),
      send: (datagrams) => {
        sent.push(...datagrams);
        return transport.send(datagrams);
      },
      close: () => transport.close(),
    }),
  };
}

/** A switch that, while thinned, loses every other Datagram sent through the Transports it wraps. */
function thinnable() {
  let thinned = false;
  return {
    wrap: (transport: Transport): Transport => ({
      listen: (receiver) => transport.listen(receiver),
      send: (datagrams) => {
        if (!thinned) return transport.send(datagrams);
        // The lost ones count as sent: they were accepted, then lost.
        transport.send(datagrams.filter((_, index) => index % 2 === 0));
        return datagrams.length;
      },
      close: () => transport.close(),
    }),
    thin: () => {
      thinned = true;
    },
    restore: () => {
      thinned = false;
    },
  };
}

const CLIENT = { host: "10.0.0.2", port: 50000 };

/**
 * A Server at 20 Ticks per second and one Client sending at 20 Hz from
 * CLIENT, connected over a simulated network with the given conditions.
 * Every Datagram either side sends is recorded, and the Client's link can be
 * thinned.
 */
async function connected(
  options: { seed?: number; conditions?: NetworkConditions } = {},
) {
  const serverSide = recorder();
  const { clock, server, connectClient } = await setup({
    ...options,
    tickRate: 1000 / STEP,
    wrapServer: serverSide.wrap,
  });
  const clientLink = thinnable();
  const clientSide = recorder();
  const sendRate = 1000 / STEP;
  const { client, connection } = await connectClient(CLIENT, {
    sendRate,
    wrap: (transport) => clientSide.wrap(clientLink.wrap(transport)),
  });
  const sent = () => [...serverSide.sent, ...clientSide.sent];
  /** Connects a new Client from CLIENT, as the first one did, without recording or thinning it. */
  const reconnect = async () =>
    (await connectClient(CLIENT, { sendRate })).client;
  return { clock, server, client, connection, clientLink, sent, reconnect };
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
  const { clock, server, client, clientLink, reconnect } = await connected();
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

  const again = await reconnect();
  const resent = bytes(20_000, 2);
  again.send(messages.blob, resent, "reliable");
  clock.advance(5000);

  expect(atServer).toEqual([resent]);
});
