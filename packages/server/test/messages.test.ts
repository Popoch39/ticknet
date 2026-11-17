import { expect, test } from "bun:test";
import { connect } from "@ticknet/client";
import {
  MAX_DATAGRAM_MESSAGE_SIZE,
  type OutgoingDatagram,
  type Transport,
} from "@ticknet/core";
import { ManualClock, SimulatedNetwork } from "@ticknet/core/testing";
import { defineMessages, startServer, type Connection } from "@ticknet/server";

const SERVER = { host: "10.0.0.1", port: 4000 };

const text = {
  encode: (value: string) => new TextEncoder().encode(value),
  decode: (data: Uint8Array) => new TextDecoder().decode(data),
};

const messages = defineMessages({
  chat: {
    id: 1,
    encode: text.encode,
    decode: (data: Uint8Array) => {
      const value = text.decode(data);
      if (value === "malformed") throw new Error("Not a chat line");
      return value;
    },
  },
  score: {
    id: 2,
    encode: (value: number) => Uint8Array.of(value),
    decode: (data: Uint8Array) => data[0] ?? 0,
  },
  blob: {
    id: 3,
    encode: (value: Uint8Array) => value,
    decode: (data: Uint8Array) => data,
  },
});

/** Wraps a Transport to record every batch of Datagrams sent through it. */
function recorded(transport: Transport) {
  const batches: OutgoingDatagram[][] = [];
  const recording: Transport = {
    listen: (receiver) => transport.listen(receiver),
    send: (datagrams) => {
      batches.push([...datagrams]);
      return transport.send(datagrams);
    },
    close: () => transport.close(),
  };
  return { transport: recording, batches };
}

/**
 * A Server on a simulated network at time 0, and a way to connect Clients to
 * it. Every Datagram either side sends is recorded.
 */
async function setup(options: { tickRate?: number; sendRate?: number } = {}) {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock });
  const serverSide = recorded(network.bind(SERVER));
  const server = await startServer({
    transport: serverSide.transport,
    clock,
    tickRate: options.tickRate,
  });
  const opened: Connection[] = [];
  server.on("connectionOpened", (connection) => opened.push(connection));
  let nextPort = 50000;

  /** Connects a Client without moving the Clock past the Handshake. */
  async function connectClient() {
    const clientSide = recorded(
      network.bind({ host: "10.0.0.2", port: nextPort++ }),
    );
    const connecting = connect({
      ...SERVER,
      transport: clientSide.transport,
      clock,
      sendRate: options.sendRate,
    });
    clock.advance(0);
    const client = await connecting;
    const connection = opened.at(-1);
    if (!connection)
      throw new Error("Expected the Server to open a Connection");
    // Only what is sent once connected matters to these tests.
    clientSide.batches.length = 0;
    serverSide.batches.length = 0;
    return { client, connection, sent: clientSide.batches };
  }

  return { clock, server, sent: serverSide.batches, connectClient };
}

const datagramCount = (batches: OutgoingDatagram[][]) =>
  batches.reduce((count, batch) => count + batch.length, 0);

test("defining two Messages with the same id fails with a clear error", () => {
  expect(() =>
    defineMessages({ chat: { id: 1, ...text }, say: { id: 1, ...text } }),
  ).toThrow('Messages "chat" and "say" are both defined with id 1');
});

test("sending and handling a Message are type-checked against its definition", async () => {
  const { server, connectClient } = await setup();
  const { client, connection } = await connectClient();

  // Never called: these lines only have to fail the type-check.
  const misuses = () => {
    // @ts-expect-error A chat line is a string.
    client.send(messages.chat, 42, "unreliable");
    // @ts-expect-error A score is a number.
    connection.send(messages.score, "high", "unreliable");
    // @ts-expect-error A chat line is a string.
    server.broadcast(messages.chat, { line: "hi" }, "unreliable");
    // @ts-expect-error A chat handler receives a string.
    server.onMessage(messages.chat, (_from, value: number) => value);
    // @ts-expect-error A score handler receives a number.
    client.onMessage(messages.score, (value: string) => value);
    // @ts-expect-error There is no such Delivery mode.
    client.send(messages.chat, "hi", "eventually");
  };
  expect(misuses).toBeFunction();
});

test("a Client sends an Unreliable Message and the Server's handler receives the Connection and the decoded value", async () => {
  const { clock, server, connectClient } = await setup();
  const { client, connection } = await connectClient();
  const received: [Connection, string][] = [];
  server.onMessage(messages.chat, (from, value) =>
    received.push([from, value]),
  );

  client.send(messages.chat, "hello", "unreliable");
  clock.advance(100);

  expect(received).toEqual([[connection, "hello"]]);
});

test("the Server sends an Unreliable Message to one Connection, and only that Client's handler receives it", async () => {
  const { clock, connectClient } = await setup();
  const first = await connectClient();
  const second = await connectClient();
  const received: [string, number][] = [];
  first.client.onMessage(messages.score, (value) =>
    received.push(["first", value]),
  );
  second.client.onMessage(messages.score, (value) =>
    received.push(["second", value]),
  );

  first.connection.send(messages.score, 7, "unreliable");
  clock.advance(100);

  expect(received).toEqual([["first", 7]]);
});

test("the Server sends one Message to every Connection in one call", async () => {
  const { clock, server, connectClient } = await setup();
  const clients = [await connectClient(), await connectClient()];
  const received: [number, string][] = [];
  clients.forEach(({ client }, index) =>
    client.onMessage(messages.chat, (value) => received.push([index, value])),
  );

  server.broadcast(messages.chat, "round starts", "unreliable");
  clock.advance(100);

  expect(received).toEqual([
    [0, "round starts"],
    [1, "round starts"],
  ]);
});

test("the Server calls the Tick callback at the configured rate with an increasing Tick number, driven by the Clock", async () => {
  const { clock, server } = await setup({ tickRate: 10 });
  const ticks: [number, number][] = [];
  server.on("tick", (tick) => ticks.push([tick, clock.now()]));

  clock.advance(99);
  expect(ticks).toEqual([]);

  clock.advance(251);
  expect(ticks).toEqual([
    [1, 100],
    [2, 200],
    [3, 300],
  ]);
});

test("Messages sent during a Tick stay off the network until it ends, then leave together in a single Datagram", async () => {
  const { clock, server, sent, connectClient } = await setup({ tickRate: 10 });
  const { client, connection } = await connectClient();
  const received: string[] = [];
  client.onMessage(messages.chat, (value) => received.push(value));
  let sentDuringTick: number | undefined;
  server.on("tick", (tick) => {
    if (tick !== 1) return;
    for (const line of ["one", "two", "three"])
      connection.send(messages.chat, line, "unreliable");
    sentDuringTick = datagramCount(sent);
  });

  clock.advance(100);

  expect(sentDuringTick).toBe(0);
  expect(datagramCount(sent)).toBe(1);
  expect(received).toEqual(["one", "two", "three"]);
});

test("a reply sent from a Message handler between Ticks leaves when the next Tick ends", async () => {
  const { clock, server, connectClient } = await setup({
    tickRate: 10,
    sendRate: 40,
  });
  const { client } = await connectClient();
  const replies: [string, number][] = [];
  server.onMessage(messages.chat, (from, value) =>
    from.send(messages.chat, `re: ${value}`, "unreliable"),
  );
  client.onMessage(messages.chat, (value) =>
    replies.push([value, clock.now()]),
  );

  // Leaves the Client at 25 ms, well before the first Tick at 100 ms.
  client.send(messages.chat, "hello", "unreliable");
  clock.advance(200);

  expect(replies).toEqual([["re: hello", 100]]);
});

test("Messages too many for one Datagram leave in as few Datagrams as fit, none over 1200 bytes, all delivered", async () => {
  const { clock, sent, connectClient } = await setup({ tickRate: 10 });
  const { client, connection } = await connectClient();
  let received = 0;
  client.onMessage(messages.blob, () => received++);

  // Ten bodies of 300 bytes, at most three of which fit in one Datagram.
  for (let index = 0; index < 10; index++)
    connection.send(messages.blob, new Uint8Array(300), "unreliable");
  clock.advance(100);

  const sizes = sent.flat().map(({ data }) => data.byteLength);
  expect(sizes).toHaveLength(4);
  for (const size of sizes) expect(size).toBeLessThanOrEqual(1200);
  expect(received).toBe(10);
});

test("the Client flushes at its configured send rate, not on every send", async () => {
  const { clock, server, connectClient } = await setup({ sendRate: 10 });
  const { client, sent } = await connectClient();
  const received: string[] = [];
  server.onMessage(messages.chat, (_from, value) => received.push(value));

  client.send(messages.chat, "first", "unreliable");
  clock.advance(50);
  client.send(messages.chat, "second", "unreliable");
  clock.advance(49);
  expect(datagramCount(sent)).toBe(0);
  expect(received).toEqual([]);

  clock.advance(1);
  expect(datagramCount(sent)).toBe(1);
  expect(received).toEqual(["first", "second"]);
});

test("the Client exposes the last Server Tick number it received", async () => {
  const { clock, server, connectClient } = await setup({ tickRate: 10 });
  const { client, connection } = await connectClient();
  server.on("tick", (tick) => {
    if (tick <= 3) connection.send(messages.score, tick, "unreliable");
  });
  expect(client.lastServerTick).toBeUndefined();

  clock.advance(200);
  expect(client.lastServerTick).toBe(2);

  clock.advance(300);
  expect(client.lastServerTick).toBe(3);
});

test("sending an Unreliable Message too large for one Datagram fails immediately with a clear error", async () => {
  const { clock, server, connectClient } = await setup();
  const { client, connection } = await connectClient();
  const largest = new Uint8Array(MAX_DATAGRAM_MESSAGE_SIZE);
  const tooLarge = new Uint8Array(MAX_DATAGRAM_MESSAGE_SIZE + 1);
  const received: number[] = [];
  server.onMessage(messages.blob, (_from, value) =>
    received.push(value.byteLength),
  );

  const error = /must fit in one Datagram/;
  expect(() => client.send(messages.blob, tooLarge, "unreliable")).toThrow(
    error,
  );
  expect(() => connection.send(messages.blob, tooLarge, "unreliable")).toThrow(
    error,
  );
  expect(() => server.broadcast(messages.blob, tooLarge, "unreliable")).toThrow(
    error,
  );

  client.send(messages.blob, largest, "unreliable");
  clock.advance(100);
  expect(received).toEqual([MAX_DATAGRAM_MESSAGE_SIZE]);
});

test("a received Message with an unknown id is ignored and the rest of the Datagram is still delivered", async () => {
  const { clock, server, connectClient } = await setup();
  const { client } = await connectClient();
  const clientOnly = defineMessages({ ping: { id: 99, ...text } });
  const received: string[] = [];
  const errors: Error[] = [];
  server.onMessage(messages.chat, (_from, value) => received.push(value));
  server.on("error", (error) => errors.push(error));

  client.send(messages.chat, "before", "unreliable");
  client.send(clientOnly.ping, "unknown to the Server", "unreliable");
  client.send(messages.chat, "after", "unreliable");
  clock.advance(100);

  expect(received).toEqual(["before", "after"]);
  expect(errors).toEqual([]);
});

test("a decode function that throws is reported, and the other Messages and the Ticks carry on", async () => {
  const { clock, server, connectClient } = await setup({ tickRate: 10 });
  const { client } = await connectClient();
  const received: string[] = [];
  const errors: Error[] = [];
  const ticks: number[] = [];
  server.onMessage(messages.chat, (_from, value) => received.push(value));
  server.on("error", (error) => errors.push(error));
  server.on("tick", (tick) => ticks.push(tick));

  client.send(messages.chat, "malformed", "unreliable");
  client.send(messages.chat, "fine", "unreliable");
  clock.advance(200);

  expect(received).toEqual(["fine"]);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toBe('Could not decode Message "chat" (id 1)');
  expect(errors[0]?.cause).toEqual(new Error("Not a chat line"));
  expect(ticks).toEqual([1, 2]);
});

test("a Message handler that throws is reported, and the Messages after it are still delivered", async () => {
  const { clock, server, connectClient } = await setup();
  const { client } = await connectClient();
  const received: string[] = [];
  const errors: Error[] = [];
  server.onMessage(messages.chat, (_from, value) => {
    if (value === "crash") throw new Error("Game bug");
    received.push(value);
  });
  server.on("error", (error) => errors.push(error));

  client.send(messages.chat, "crash", "unreliable");
  client.send(messages.chat, "fine", "unreliable");
  clock.advance(100);

  expect(received).toEqual(["fine"]);
  expect(errors.map((error) => [error.message, error.cause])).toEqual([
    ['The handler of Message "chat" (id 1) threw', new Error("Game bug")],
  ]);
});

test("a Tick callback that throws is reported, and the other callbacks, the Tick's Messages and the Ticks after it carry on", async () => {
  const { clock, server, connectClient } = await setup({ tickRate: 10 });
  const { client, connection } = await connectClient();
  const received: string[] = [];
  client.onMessage(messages.chat, (value) => received.push(value));
  const ticks: number[] = [];
  const errors: Error[] = [];
  server.on("tick", (tick) => {
    connection.send(messages.chat, `tick ${tick}`, "unreliable");
    if (tick === 2) throw new Error("Game bug");
  });
  server.on("tick", (tick) => ticks.push(tick));
  server.on("error", (error) => errors.push(error));

  clock.advance(450);

  expect(ticks).toEqual([1, 2, 3, 4]);
  expect(received).toEqual(["tick 1", "tick 2", "tick 3", "tick 4"]);
  expect(errors.map((error) => [error.message, error.cause])).toEqual([
    ['A "tick" listener threw', new Error("Game bug")],
  ]);
});

test("a decode function that throws on the Client is reported to the Client's error listeners", async () => {
  const { clock, connectClient } = await setup();
  const { client, connection } = await connectClient();
  const received: string[] = [];
  const errors: Error[] = [];
  client.onMessage(messages.chat, (value) => received.push(value));
  client.on("error", (error) => errors.push(error));

  connection.send(messages.chat, "malformed", "unreliable");
  connection.send(messages.chat, "fine", "unreliable");
  clock.advance(100);

  expect(received).toEqual(["fine"]);
  expect(errors.map((error) => error.message)).toEqual([
    'Could not decode Message "chat" (id 1)',
  ]);
});
