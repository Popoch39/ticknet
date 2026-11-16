import { expect, test } from "bun:test";
import { connect, type CloseReason } from "@ticknet/client";
import type { Transport } from "@ticknet/core";
import { ManualClock, SimulatedNetwork } from "@ticknet/core/testing";
import {
  defineMessages,
  MAX_CLOSE_CODE,
  startServer,
  type Address,
  type Connection,
} from "@ticknet/server";

const SERVER = { host: "10.0.0.1", port: 4000 };

/**
 * Wraps a Transport so that a test can silence its endpoint: while cut,
 * whatever it sends is lost on the way, as if its link had gone down.
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

const messages = defineMessages({
  chat: {
    id: 1,
    encode: (value: string) => new TextEncoder().encode(value),
    decode: (data: Uint8Array) => new TextDecoder().decode(data),
  },
});

/**
 * A Server on a simulated network at time 0, recording the Connections it
 * opens and closes, and a way to connect Clients to it.
 */
async function setup(
  options: { timeout?: number; clientTimeout?: number } = {},
) {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock });
  const serverLink = cuttable(network.bind(SERVER));
  const server = await startServer({
    transport: serverLink.transport,
    clock,
    timeout: options.timeout,
  });
  const opened: Connection[] = [];
  const closed: [Connection, CloseReason][] = [];
  server.on("connectionOpened", (connection) => opened.push(connection));
  server.on("connectionClosed", (connection, reason) =>
    closed.push([connection, reason]),
  );
  let nextPort = 50000;

  /** Connects a Client without moving the Clock past the Handshake. */
  async function connectClient(
    address: Address = { host: "10.0.0.2", port: nextPort++ },
  ) {
    const link = cuttable(network.bind(address));
    const connecting = connect({
      ...SERVER,
      transport: link.transport,
      clock,
      timeout: options.clientTimeout,
    });
    clock.advance(0);
    const client = await connecting;
    const connection = opened.at(-1);
    if (!connection)
      throw new Error("Expected the Server to open a Connection");
    const clientClosed: CloseReason[] = [];
    client.on("connectionClosed", (reason) => clientClosed.push(reason));
    return { client, connection, link, closed: clientClosed };
  }

  return { clock, server, serverLink, opened, closed, connectClient };
}

test("a Client that disconnects on purpose closes its Connection on the Server at once, with a closed-by-Client reason", async () => {
  const { clock, closed, connectClient } = await setup();
  const { client, connection, closed: clientClosed } = await connectClient();

  client.close();
  clock.advance(0);

  expect(closed).toEqual([[connection, { kind: "closedByClient" }]]);
  expect(clientClosed).toEqual([{ kind: "closedByClient" }]);
});

test("the Server closes a Connection with its own code, and the Client is told it was closed by the Server with that code", async () => {
  const { clock, closed, connectClient } = await setup();
  const kicked = await connectClient();
  const other = await connectClient();

  kicked.connection.close(4242);
  clock.advance(0);

  expect(kicked.closed).toEqual([{ kind: "closedByServer", code: 4242 }]);
  expect(closed).toEqual([
    [kicked.connection, { kind: "closedByServer", code: 4242 }],
  ]);
  expect(other.closed).toEqual([]);
});

test("closing a Connection with a code that cannot travel fails at once and leaves it open", async () => {
  const { clock, closed, connectClient } = await setup();
  const { connection, closed: clientClosed } = await connectClient();

  for (const code of [-1, 1.5, MAX_CLOSE_CODE + 1])
    expect(() => connection.close(code)).toThrow(RangeError);
  connection.close(MAX_CLOSE_CODE);
  clock.advance(0);

  expect(clientClosed).toEqual([
    { kind: "closedByServer", code: MAX_CLOSE_CODE },
  ]);
  expect(closed).toHaveLength(1);
});

test("stopping the Server tells every connected Client it was closed by the Server", async () => {
  const { clock, server, closed, connectClient } = await setup();
  const clients = [await connectClient(), await connectClient()];

  server.stop();
  clock.advance(0);

  for (const client of clients)
    expect(client.closed).toEqual([{ kind: "closedByServer", code: 0 }]);
  expect(closed).toEqual(
    clients.map(({ connection }) => [
      connection,
      { kind: "closedByServer", code: 0 },
    ]),
  );
});

test("a Client that stops responding closes its Connection on the Server with a timeout reason after the configured delay", async () => {
  const { clock, closed, connectClient } = await setup({ timeout: 5000 });
  const { connection, link } = await connectClient();

  link.cut();
  clock.advance(4999);
  expect(closed).toEqual([]);

  clock.advance(1);
  expect(closed).toEqual([[connection, { kind: "timeout" }]]);
});

test("a Client whose Server vanishes is told its Connection closed with a timeout reason after its configured delay", async () => {
  const { clock, serverLink, connectClient } = await setup({
    clientTimeout: 3000,
  });
  const { closed: clientClosed } = await connectClient();

  serverLink.cut();
  clock.advance(2999);
  expect(clientClosed).toEqual([]);

  clock.advance(1);
  expect(clientClosed).toEqual([{ kind: "timeout" }]);
});

test("a Client's close notice lost on the network still ends in a closed Connection on the Server, through the timeout", async () => {
  const { clock, closed, connectClient } = await setup({ timeout: 5000 });
  const { client, connection, link } = await connectClient();

  link.cut();
  client.close();
  clock.advance(4999);
  expect(closed).toEqual([]);

  clock.advance(1);
  expect(closed).toEqual([[connection, { kind: "timeout" }]]);
});

test("the Server's close notice lost on the network still ends in a closed Connection on the Client, through the timeout", async () => {
  const { clock, serverLink, closed, connectClient } = await setup({
    clientTimeout: 3000,
  });
  const { connection, closed: clientClosed } = await connectClient();

  serverLink.cut();
  connection.close(7);
  clock.advance(2999);
  expect(closed).toEqual([[connection, { kind: "closedByServer", code: 7 }]]);
  expect(clientClosed).toEqual([]);

  clock.advance(1);
  expect(clientClosed).toEqual([{ kind: "timeout" }]);
});

test("a Connection on which neither side sends any Message stays open well beyond the timeout", async () => {
  const { clock, closed, connectClient } = await setup({
    timeout: 3000,
    clientTimeout: 3000,
  });
  const { closed: clientClosed } = await connectClient();

  clock.advance(60_000);

  expect(closed).toEqual([]);
  expect(clientClosed).toEqual([]);
});

test("after a Connection closed event, sending on that Connection fails clearly on either side", async () => {
  const { clock, connectClient } = await setup();
  const kicked = await connectClient();
  const leaving = await connectClient();

  kicked.connection.close();
  leaving.client.close();
  clock.advance(0);

  for (const { client, connection } of [kicked, leaving]) {
    expect(() => client.send(messages.chat, "hi", "unreliable")).toThrow(
      /closed/,
    );
    expect(() => connection.send(messages.chat, "hi", "unreliable")).toThrow(
      /closed/,
    );
  }
});

test("after a Connection closed event, no further Message from it is delivered, even when the other side missed the close", async () => {
  const { clock, server, serverLink, connectClient } = await setup();
  const kicked = await connectClient();
  const leaving = await connectClient();
  const toServer: string[] = [];
  const toClient: string[] = [];
  server.onMessage(messages.chat, (_from, value) => toServer.push(value));
  leaving.client.onMessage(messages.chat, (value) => toClient.push(value));
  kicked.client.send(messages.chat, "before the kick", "unreliable");
  leaving.connection.send(messages.chat, "before leaving", "unreliable");
  clock.advance(100);

  // Only the close notices are lost, so each other side carries on sending.
  serverLink.cut();
  kicked.connection.close();
  serverLink.restore();
  leaving.link.cut();
  leaving.client.close();
  clock.advance(0);
  kicked.client.send(messages.chat, "after the kick", "unreliable");
  leaving.connection.send(messages.chat, "after leaving", "unreliable");
  clock.advance(1000);

  expect(toServer).toEqual(["before the kick"]);
  expect(toClient).toEqual(["before leaving"]);
});

test("a Client that connects again after being closed gets a new Connection", async () => {
  const { clock, server, opened, connectClient } = await setup();
  const address = { host: "10.0.0.2", port: 50000 };
  const first = await connectClient(address);
  first.client.close();
  clock.advance(0);

  const second = await connectClient(address);
  const from: Connection[] = [];
  server.onMessage(messages.chat, (connection) => from.push(connection));
  second.client.send(messages.chat, "hello again", "unreliable");
  clock.advance(100);

  expect(opened).toEqual([first.connection, second.connection]);
  expect(second.connection).not.toBe(first.connection);
  expect(from).toEqual([second.connection]);
  expect(() =>
    first.connection.send(messages.chat, "hi", "unreliable"),
  ).toThrow(/closed/);
});

test("a Client that connects again from the same address, after its close notice was lost, gets a new Connection and the old one closes", async () => {
  const { clock, opened, closed, connectClient } = await setup();
  const address = { host: "10.0.0.2", port: 50000 };
  const first = await connectClient(address);
  first.link.cut();
  first.client.close();
  clock.advance(100);
  expect(closed).toEqual([]);

  const second = await connectClient(address);

  expect(opened).toEqual([first.connection, second.connection]);
  expect(second.connection).not.toBe(first.connection);
  expect(closed).toEqual([[first.connection, { kind: "closedByClient" }]]);
});

test("stopping the Server from its Tick callback still tells every connected Client", async () => {
  const { clock, server, connectClient } = await setup();
  const { closed: clientClosed } = await connectClient();

  server.on("tick", () => server.stop());
  clock.advance(1000);

  expect(clientClosed).toEqual([{ kind: "closedByServer", code: 0 }]);
});
