import { expect, test } from "bun:test";
import { ConnectError, connect, type CloseReason } from "@ticknet/client";
import {
  defineMessages,
  startServer,
  type Connection,
  type Server,
} from "@ticknet/server";

// These tests run on real sockets and real timers: they wait for events, never
// for a fixed delay, and the Server always listens on a port the system picks.

/** The port a Server started without a Transport listens on. */
function portOf(server: Server): number {
  if (server.port === undefined) throw new Error("The Server has no UDP port");
  return server.port;
}

test("with default options, a Client connects to a Server on loopback", async () => {
  const server = await startServer({});
  const opened = new Promise<Connection>((resolve) =>
    server.on("connectionOpened", resolve),
  );

  const client = await connect({ host: "127.0.0.1", port: portOf(server) });
  const connection = await opened;

  expect(connection.address.host).toBe("127.0.0.1");
  client.close();
  server.stop();
});

test("a Client connects to a host name, which it resolves itself", async () => {
  const server = await startServer({});
  const opened = new Promise<Connection>((resolve) =>
    server.on("connectionOpened", resolve),
  );

  const client = await connect({ host: "localhost", port: portOf(server) });

  expect((await opened).address.port).toBeGreaterThan(0);
  client.close();
  server.stop();
});

test("a host name that does not resolve fails the connect with a host not found reason", async () => {
  // The .invalid top-level domain never resolves (RFC 2606).
  const failure = await connect({ host: "ticknet.invalid", port: 4000 }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(ConnectError);
  expect(failure).toMatchObject({
    reason: { kind: "hostNotFound", host: "ticknet.invalid" },
  });
});

test("once the Client is closed and the Server stopped, the process exits on its own", async () => {
  const child = Bun.spawn(
    [
      "bun",
      new URL("fixtures/connect-then-leave.ts", import.meta.url).pathname,
    ],
    // A process kept alive is killed before the test times out, not left behind.
    { stdout: "inherit", stderr: "inherit", timeout: 4000 },
  );

  expect(await child.exited).toBe(0);
});

test("a stopped Server releases its port, which a new Server can listen on", async () => {
  const first = await startServer({});
  const port = portOf(first);
  const client = await connect({ host: "127.0.0.1", port });
  client.close();
  first.stop();

  const second = await startServer({ port });
  const opened = new Promise<Connection>((resolve) =>
    second.on("connectionOpened", resolve),
  );
  const again = await connect({ host: "127.0.0.1", port });

  expect(second.port).toBe(port);
  expect(await opened).toBeDefined();
  again.close();
  second.stop();
});

test("over real sockets, the Server learns at once that a Client disconnected, and a Client that the Server stopped", async () => {
  const server = await startServer({});
  // Only the first opening counts: it is the leaving Client's.
  const leavingOpened = new Promise<Connection>((resolve) =>
    server.on("connectionOpened", resolve),
  );
  const serverClosed = new Promise<[Connection, CloseReason]>((resolve) =>
    server.on("connectionClosed", (connection, reason) =>
      resolve([connection, reason]),
    ),
  );
  const leaving = await connect({ host: "127.0.0.1", port: portOf(server) });
  const staying = await connect({ host: "127.0.0.1", port: portOf(server) });
  const stayingClosed = new Promise<CloseReason>((resolve) =>
    staying.on("connectionClosed", resolve),
  );

  leaving.close();
  const [connection, reason] = await serverClosed;
  expect(connection).toBe(await leavingOpened);
  expect(reason).toEqual({ kind: "closedByClient" });

  server.stop();
  expect(await stayingClosed).toEqual({ kind: "closedByServer", code: 0 });
});

test("an Unreliable Message crosses real sockets in each direction and reaches its typed handler", async () => {
  const messages = defineMessages({
    chat: {
      id: 1,
      encode: (value: string) => new TextEncoder().encode(value),
      decode: (data: Uint8Array) => new TextDecoder().decode(data),
    },
  });
  const server = await startServer({});
  const toServer = new Promise<[Connection, string]>((resolve) =>
    server.onMessage(messages.chat, (connection, value) =>
      resolve([connection, value]),
    ),
  );
  const client = await connect({ host: "127.0.0.1", port: portOf(server) });
  const toClient = new Promise<string>((resolve) =>
    client.onMessage(messages.chat, resolve),
  );

  client.send(messages.chat, "hello Server", "unreliable");
  const [connection, received] = await toServer;
  connection.send(messages.chat, "hello Client", "unreliable");

  expect(received).toBe("hello Server");
  expect(await toClient).toBe("hello Client");
  client.close();
  server.stop();
});

test("a Sequenced Message crosses real sockets in each direction and reaches its typed handler", async () => {
  const messages = defineMessages({
    position: {
      id: 1,
      encode: (value: number) => Uint8Array.of(value),
      decode: (data: Uint8Array) => data[0] ?? 0,
    },
  });
  const server = await startServer({});
  const toServer = new Promise<[Connection, number]>((resolve) =>
    server.onMessage(messages.position, (connection, value) =>
      resolve([connection, value]),
    ),
  );
  const client = await connect({ host: "127.0.0.1", port: portOf(server) });
  const toClient = new Promise<number>((resolve) =>
    client.onMessage(messages.position, resolve),
  );

  client.send(messages.position, 12, "sequenced");
  const [connection, received] = await toServer;
  connection.send(messages.position, 34, "sequenced");

  expect(received).toBe(12);
  expect(await toClient).toBe(34);
  client.close();
  server.stop();
});

test("a Reliable Message crosses real sockets in each direction and reaches its typed handler", async () => {
  const messages = defineMessages({
    chat: {
      id: 1,
      encode: (value: string) => new TextEncoder().encode(value),
      decode: (data: Uint8Array) => new TextDecoder().decode(data),
    },
  });
  const server = await startServer({});
  const toServer = new Promise<[Connection, string]>((resolve) =>
    server.onMessage(messages.chat, (connection, value) =>
      resolve([connection, value]),
    ),
  );
  const client = await connect({ host: "127.0.0.1", port: portOf(server) });
  const toClient = new Promise<string>((resolve) =>
    client.onMessage(messages.chat, resolve),
  );

  client.send(messages.chat, "gg", "reliable");
  const [connection, received] = await toServer;
  connection.send(messages.chat, "wp", "reliable");

  expect(received).toBe("gg");
  expect(await toClient).toBe("wp");
  client.close();
  server.stop();
});
