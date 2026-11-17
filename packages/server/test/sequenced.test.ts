import { expect, test } from "bun:test";
import { connect, type Client } from "@ticknet/client";
import { MAX_DATAGRAM_MESSAGE_SIZE } from "@ticknet/core";
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
} from "@ticknet/server";
import { SERVER, settle } from "./support";

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
  position: { id: 1, ...u32 },
  heading: { id: 2, ...u32 },
});

const range = (count: number) => Array.from({ length: count }, (_, i) => i);

const STEP = 50;

/**
 * A Server at 20 Ticks per second and one Client sending at 20 Hz, connected
 * over a simulated network with the given conditions, so that each Tick or
 * Send step puts one Datagram on the network. Datagrams leave every STEP
 * milliseconds, less than the 100 ms the simulated network holds one back
 * for, so that reordering does reorder.
 */
async function connected(
  options: { seed?: number; conditions?: NetworkConditions } = {},
) {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock, ...options });
  const server = await startServer({
    transport: network.bind(SERVER),
    clock,
    tickRate: 1000 / STEP,
  });
  let connection: Connection | undefined;
  server.on("connectionOpened", (opened) => (connection = opened));
  let client: Client | undefined;
  let failure: unknown;
  connect({
    ...SERVER,
    transport: network.bind({ host: "10.0.0.2", port: 50000 }),
    clock,
    sendRate: 1000 / STEP,
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
  return { clock, server, client, connection };
}

/** Records, on each side, the values of `type` delivered from the other. */
function received(
  server: Server,
  client: Client,
  type: typeof messages.position,
) {
  const atServer: number[] = [];
  const atClient: number[] = [];
  server.onMessage(type, (_from, value) => atServer.push(value));
  client.onMessage(type, (value) => atClient.push(value));
  return { atServer, atClient };
}

test("a Sequenced Message is delivered in each direction", async () => {
  const { clock, server, client, connection } = await connected();
  const { atServer, atClient } = received(server, client, messages.position);

  client.send(messages.position, 7, "sequenced");
  connection.send(messages.position, 8, "sequenced");
  clock.advance(200);

  expect(atServer).toEqual([7]);
  expect(atClient).toEqual([8]);
});

test("under reordering, the Sequenced values delivered are always in increasing send order, older ones arriving late being dropped", async () => {
  const { clock, server, client, connection } = await connected({
    conditions: { reordering: 0.3 },
  });
  const { atServer, atClient } = received(server, client, messages.position);

  for (const value of range(200)) {
    client.send(messages.position, value, "sequenced");
    connection.send(messages.position, value, "sequenced");
    clock.advance(STEP);
  }
  clock.advance(1000);

  for (const values of [atServer, atClient]) {
    for (const [index, value] of values.entries())
      if (index > 0) expect(value).toBeGreaterThan(values[index - 1] ?? -1);
    // Nothing is lost on this network: what is missing arrived after a newer one and was dropped.
    expect(values.length).toBeGreaterThan(100);
    expect(values.length).toBeLessThan(200);
    expect(values.at(-1)).toBe(199);
  }
});

test("under loss, a lost Sequenced Message is never delivered later, and the others keep arriving in order", async () => {
  const { clock, server, client, connection } = await connected({
    conditions: { loss: 0.3 },
  });
  const { atServer, atClient } = received(server, client, messages.position);

  for (const value of range(200)) {
    client.send(messages.position, value, "sequenced");
    connection.send(messages.position, value, "sequenced");
    clock.advance(STEP);
  }
  clock.advance(1000);
  const delivered = [[...atServer], [...atClient]];
  // Long enough for anything resent to arrive.
  clock.advance(30_000);

  expect([atServer, atClient]).toEqual(delivered);
  for (const values of delivered) {
    expect(values.length).toBeGreaterThan(100);
    expect(values.length).toBeLessThan(180);
    expect(values).toEqual([...new Set(values)].sort((a, b) => a - b));
  }
});

test("with every Datagram duplicated, each Sequenced Message is delivered exactly once, both ways", async () => {
  const { clock, server, client, connection } = await connected({
    conditions: { duplication: 1 },
  });
  const { atServer, atClient } = received(server, client, messages.position);

  for (const value of range(50)) {
    client.send(messages.position, value, "sequenced");
    connection.send(messages.position, value, "sequenced");
    clock.advance(STEP);
  }
  clock.advance(1000);

  expect(atServer).toEqual(range(50));
  expect(atClient).toEqual(range(50));
});

test("sending a Sequenced Message too large for one Datagram fails immediately with a clear error", async () => {
  const { clock, server, client, connection } = await connected();
  const blob = defineMessages({
    blob: {
      id: 3,
      encode: (value: Uint8Array) => value,
      decode: (data: Uint8Array) => data,
    },
  }).blob;
  const atServer: number[] = [];
  server.onMessage(blob, (_from, value) => atServer.push(value.byteLength));
  const tooLarge = new Uint8Array(MAX_DATAGRAM_MESSAGE_SIZE + 1);

  const error = `a Sequenced Message must fit in one Datagram, which holds at most ${MAX_DATAGRAM_MESSAGE_SIZE} bytes of it`;
  expect(() => client.send(blob, tooLarge, "sequenced")).toThrow(error);
  expect(() => connection.send(blob, tooLarge, "sequenced")).toThrow(error);
  expect(() => server.broadcast(blob, tooLarge, "sequenced")).toThrow(error);

  client.send(blob, new Uint8Array(MAX_DATAGRAM_MESSAGE_SIZE), "sequenced");
  clock.advance(STEP);
  expect(atServer).toEqual([MAX_DATAGRAM_MESSAGE_SIZE]);
});

test("a long-running Connection keeps Sequenced ordering after its sequence counters wrap around", async () => {
  const { clock, server, client, connection } = await connected({
    conditions: { reordering: 0.3 },
  });
  const { atServer, atClient } = received(server, client, messages.position);

  // Well past 2^16 Sequenced Messages of one type each way, a hundred per Datagram.
  const count = 70_000;
  const perStep = 100;
  for (let value = 0; value < count; value++) {
    client.send(messages.position, value, "sequenced");
    connection.send(messages.position, value, "sequenced");
    if (value % perStep === perStep - 1) clock.advance(STEP);
  }
  clock.advance(1000);

  for (const values of [atServer, atClient]) {
    const firstOutOfOrder = values.findIndex(
      (value, index) => index > 0 && value <= (values[index - 1] ?? -1),
    );
    expect(firstOutOfOrder).toBe(-1);
    expect(values.at(-1)).toBe(count - 1);
    expect(values.length).toBeGreaterThan(count / 2);
    // Each Datagram held back and overtaken loses its whole batch.
    expect(values.length).toBeLessThan(count);
  }
});

test("Sequenced ordering is tracked per Message type: a late one is not dropped because a newer Message of another type arrived first", async () => {
  const { clock, server, client, connection } = await connected({
    conditions: { reordering: 0.3 },
  });
  const atServer: [string, number][] = [];
  const atClient: [string, number][] = [];
  for (const type of [messages.position, messages.heading]) {
    server.onMessage(type, (_from, value) => atServer.push([type.name, value]));
    client.onMessage(type, (value) => atClient.push([type.name, value]));
  }

  // The types take turns, one per Datagram: a Datagram held back is overtaken by one of the other type.
  const sent: [string, number][] = [];
  for (const value of range(200)) {
    const type = value % 2 === 0 ? messages.position : messages.heading;
    client.send(type, value, "sequenced");
    connection.send(type, value, "sequenced");
    sent.push([type.name, value]);
    clock.advance(STEP);
  }
  clock.advance(1000);

  for (const arrived of [atServer, atClient]) {
    expect(arrived).not.toEqual(sent);
    const sortedBack = [...arrived].sort(([, a], [, b]) => a - b);
    expect(sortedBack).toEqual(sent);
  }
});
