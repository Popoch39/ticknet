import { expect, test } from "bun:test";
import {
  ClientEngine,
  MAX_DATAGRAM_SIZE,
  PROTOCOL_VERSION,
  ServerEngine,
  type Address,
} from "@ticknet/core";

const SERVER: Address = { host: "10.0.0.1", port: 4000 };
const CLIENT: Address = { host: "10.0.0.2", port: 50000 };
const SECRET = Uint8Array.from({ length: 16 }, (_, index) => index * 17);

const SERVER_CONFIG = { maxConnections: 64, timeout: 10_000 };

const newServer = () => new ServerEngine({ ...SERVER_CONFIG, secret: SECRET });
const newClient = (now = 0) =>
  new ClientEngine({ server: SERVER, timeout: 5000 }, now);

/** Hands each Datagram the `from` engine queued to the `to` engine, and returns them. */
function carry(
  from: ClientEngine | ServerEngine,
  to: ClientEngine | ServerEngine,
  origin: Address,
  now = 0,
) {
  const datagrams = from.pollDatagrams();
  for (const datagram of datagrams) to.receive(datagram.data, origin, now);
  return datagrams;
}

/** Runs a Handshake up to the point where the Client has queued its echo of the challenge. */
function clientReadyToEcho(server: ServerEngine, now = 0) {
  const client = newClient(now);
  carry(client, server, CLIENT, now);
  carry(server, client, SERVER, now);
  return client;
}

/** Accepts every Client whose authentication `server` requested so far. */
function acceptAll(server: ServerEngine) {
  for (const event of server.pollEvents())
    if (event.type === "authenticationRequested")
      server.accept(event.connection);
}

/** A Server that has just accepted a Client, with its acceptance queued. */
function acceptingServer() {
  const server = newServer();
  carry(clientReadyToEcho(server), server, CLIENT);
  acceptAll(server);
  return server;
}

/** The data of the one Datagram `engine` has queued. */
function onlyDatagram(engine: ClientEngine | ServerEngine): Uint8Array {
  const [datagram, ...others] = engine.pollDatagrams();
  if (!datagram || others.length > 0)
    throw new Error("Expected exactly one queued Datagram");
  return datagram.data;
}

/** Every strict prefix of `data`, from empty to one byte short. */
const truncations = (data: Uint8Array) =>
  Array.from({ length: data.byteLength }, (_, size) => data.slice(0, size));

const oversized = (data: Uint8Array) => Uint8Array.of(...data, 0);

const withVersion = (data: Uint8Array, version: number) =>
  Uint8Array.of(version, ...data.subarray(1));

/**
 * Datagrams of random size and content that carry this version byte and a
 * small kind byte, so that they reach the decoders. Seeded so that a failure replays.
 */
function randomDatagrams(count: number, seed: number): Uint8Array[] {
  let state = seed;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  return Array.from({ length: count }, () => {
    const data = Uint8Array.from(
      { length: next() % (MAX_DATAGRAM_SIZE + 100) },
      () => next() >>> 24,
    );
    data.set([PROTOCOL_VERSION, next() % 8].slice(0, data.byteLength));
    return data;
  });
}

test("a connection request that is never echoed opens no Connection and leaves nothing pending", () => {
  const server = newServer();
  const client = newClient();

  carry(client, server, CLIENT);
  expect(server.pollDatagrams()).toHaveLength(1);

  server.advance(60_000);
  expect(server.pollEvents()).toEqual([]);
  expect(server.pollDatagrams()).toEqual([]);
  expect(server.nextDeadline()).toBeUndefined();
});

test("the challenge carries all the Server needs: an engine that never saw the request accepts its echo", () => {
  const challenger = newServer();
  const client = newClient();
  carry(client, challenger, CLIENT);
  carry(challenger, client, SERVER);

  const sameSecret = newServer();
  carry(client, sameSecret, CLIENT);
  const [request] = sameSecret.pollEvents();
  expect(request).toMatchObject({
    type: "authenticationRequested",
    address: CLIENT,
  });
  if (request) sameSecret.accept(request.connection);
  carry(sameSecret, client, SERVER);

  expect(sameSecret.pollEvents()).toMatchObject([
    { type: "connectionOpened", address: CLIENT },
  ]);
  expect(client.pollEvents()).toEqual([{ type: "connectionOpened" }]);
});

test("a challenge echoed from another address than it was issued to is rejected", () => {
  const server = newServer();
  const client = clientReadyToEcho(server);

  carry(client, server, { host: "10.0.0.66", port: 50000 });

  expect(server.pollEvents()).toEqual([]);
  expect(server.pollDatagrams()).toEqual([]);
});

test("a challenge issued under another secret is rejected", () => {
  const client = clientReadyToEcho(
    new ServerEngine({ ...SERVER_CONFIG, secret: new Uint8Array(16) }),
  );
  const server = newServer();

  carry(client, server, CLIENT);

  expect(server.pollEvents()).toEqual([]);
  expect(server.pollDatagrams()).toEqual([]);
});

test("a challenge echoed long after it was issued is rejected", () => {
  const server = newServer();
  const client = clientReadyToEcho(server);

  carry(client, server, CLIENT, 60_000);

  expect(server.pollEvents()).toEqual([]);
  expect(server.pollDatagrams()).toEqual([]);
});

test("the Server asks for authentication only once the challenge comes back from the address it was issued to", () => {
  const server = newServer();
  const client = newClient();

  carry(client, server, CLIENT);
  expect(server.pollEvents()).toEqual([]);
  carry(server, client, SERVER);
  const echo = onlyDatagram(client);
  server.receive(echo, { host: "10.0.0.66", port: 50000 }, 0);
  expect(server.pollEvents()).toEqual([]);

  server.receive(echo, CLIENT, 0);
  expect(server.pollEvents()).toEqual([
    {
      type: "authenticationRequested",
      connection: expect.any(Number),
      address: CLIENT,
      authToken: new Uint8Array(0),
    },
  ]);
});

test("a replayed echo opens no second Connection", () => {
  const server = newServer();
  const echo = onlyDatagram(clientReadyToEcho(server));
  server.receive(echo, CLIENT, 0);
  acceptAll(server);
  expect(server.pollEvents()).toHaveLength(1);
  server.pollDatagrams();

  server.receive(echo, CLIENT, 0);

  expect(server.pollEvents()).toEqual([]);
  // The acceptance may have been lost, so it is sent again.
  expect(server.pollDatagrams()).toHaveLength(1);
});

test("an echo replayed while the Client is being authenticated asks for authentication only once", () => {
  const server = newServer();
  const echo = onlyDatagram(clientReadyToEcho(server));

  server.receive(echo, CLIENT, 0);
  server.receive(echo, CLIENT, 0);

  expect(server.pollEvents()).toMatchObject([
    { type: "authenticationRequested", address: CLIENT },
  ]);
});

test("no Datagram sent to an unproven address is larger than the Datagram that triggered it", () => {
  const request = onlyDatagram(newClient());
  const echo = onlyDatagram(clientReadyToEcho(newServer()));
  const otherVersionRequest = withVersion(request, PROTOCOL_VERSION + 1);
  const triggers = [
    request,
    ...truncations(request),
    otherVersionRequest,
    ...truncations(otherVersionRequest),
    echo,
    ...truncations(echo),
  ];
  const server = newServer();

  triggers.forEach((trigger, index) => {
    // Each from its own address, so that none of them is proven by an earlier exchange.
    server.receive(trigger, { host: "10.0.0.66", port: index }, 0);
    for (const reply of server.pollDatagrams())
      expect(reply.data.byteLength).toBeLessThanOrEqual(trigger.byteLength);
  });
});

test("the Server drops malformed, truncated and oversized Datagrams without an event and without throwing", () => {
  const server = newServer();
  const request = onlyDatagram(newClient());
  const echo = onlyDatagram(clientReadyToEcho(server));
  const hostile = [
    ...truncations(request),
    oversized(request),
    ...truncations(echo),
    oversized(echo),
    ...randomDatagrams(500, 1),
  ];

  for (const data of hostile)
    expect(() => server.receive(data, CLIENT, 0)).not.toThrow();

  expect(server.pollEvents()).toEqual([]);
});

test("the Server sends nothing back for a truncated or oversized Handshake Datagram", () => {
  const server = newServer();
  const request = onlyDatagram(newClient());
  const echo = onlyDatagram(clientReadyToEcho(server));

  for (const data of [
    ...truncations(request),
    oversized(request),
    ...truncations(echo),
    oversized(echo),
  ]) {
    server.receive(data, CLIENT, 0);
  }

  expect(server.pollDatagrams()).toEqual([]);
});

test("a connecting Client drops malformed, truncated and oversized Datagrams without an event and without throwing", () => {
  const server = newServer();
  const client = clientReadyToEcho(server);
  carry(newClient(), server, CLIENT);
  const challenge = onlyDatagram(server);
  const accepted = onlyDatagram(acceptingServer());
  const hostile = [
    ...truncations(challenge),
    oversized(challenge),
    ...truncations(accepted),
    oversized(accepted),
    ...randomDatagrams(500, 2),
  ];

  for (const data of hostile)
    expect(() => client.receive(data, SERVER, 0)).not.toThrow();

  expect(client.pollEvents()).toEqual([]);
});

test("every Datagram of a Handshake starts with the protocol version byte and none exceeds 1200 bytes", () => {
  const server = newServer();
  const client = newClient();
  const sent = [
    ...carry(client, server, CLIENT),
    ...carry(server, client, SERVER),
  ];
  sent.push(...carry(client, server, CLIENT));
  acceptAll(server);
  sent.push(...carry(server, client, SERVER));

  expect(client.pollEvents()).toEqual([{ type: "connectionOpened" }]);
  expect(sent).toHaveLength(4);
  for (const { data } of sent) {
    expect(data[0]).toBe(PROTOCOL_VERSION);
    expect(data.byteLength).toBeLessThanOrEqual(1200);
  }
});

test("the Server answers a Client of another protocol version with its own version byte, and opens nothing", () => {
  const server = newServer();
  const otherVersionRequest = withVersion(
    onlyDatagram(newClient()),
    PROTOCOL_VERSION + 1,
  );

  server.receive(otherVersionRequest, CLIENT, 0);

  const answer = onlyDatagram(server);
  expect(answer[0]).toBe(PROTOCOL_VERSION);
  expect(answer.byteLength).toBeLessThanOrEqual(otherVersionRequest.byteLength);
  expect(server.pollEvents()).toEqual([]);
});

test("a connecting Client fails with a version mismatch reason when the Server speaks another version", () => {
  const client = newClient();

  client.receive(Uint8Array.of(PROTOCOL_VERSION + 1), SERVER, 0);

  expect(client.pollEvents()).toEqual([
    { type: "connectionClosed", reason: { kind: "versionMismatch" } },
  ]);
});
