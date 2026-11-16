import { expect, test } from "bun:test";
import {
  ClientEngine,
  ServerEngine,
  type Address,
  type DeliveryMode,
  type ServerEvent,
} from "@ticknet/core";

const SERVER: Address = { host: "10.0.0.1", port: 4000 };
const CLIENT: Address = { host: "10.0.0.2", port: 50000 };
const SECRET = Uint8Array.from({ length: 16 }, (_, index) => index * 17);

/** Hands each Datagram the `from` engine queued to the `to` engine. */
function carry(
  from: ClientEngine | ServerEngine,
  to: ClientEngine | ServerEngine,
  origin: Address,
) {
  for (const datagram of from.pollDatagrams())
    to.receive(datagram.data, origin, 0);
}

/** A Server and a Client with an open Connection between them, at time 0. */
function connectedPair() {
  const server = new ServerEngine(
    { secret: SECRET, tickRate: 30, maxConnections: 64, timeout: 10_000 },
    0,
  );
  const client = new ClientEngine(
    { server: SERVER, timeout: 5000, sendRate: 10 },
    0,
  );
  carry(client, server, CLIENT);
  carry(server, client, SERVER);
  carry(client, server, CLIENT);
  for (const event of server.pollEvents())
    if (event.type === "authenticationRequested")
      server.accept(event.connection);
  carry(server, client, SERVER);
  server.pollEvents();
  client.pollEvents();
  return { server, client };
}

const SENT: { id: number; body: Uint8Array }[] = [
  { id: 1, body: Uint8Array.of(10, 11, 12) },
  { id: 2, body: Uint8Array.of(20, 21) },
];

/** The one Datagram a connected Client puts on the network for SENT. */
function clientDatagram(delivery: DeliveryMode = "unreliable"): Uint8Array {
  const { client } = connectedPair();
  for (const { id, body } of SENT) client.send(id, body, delivery);
  client.advance(100);
  const [datagram, ...others] = client.pollDatagrams();
  if (!datagram || others.length > 0)
    throw new Error("Expected exactly one queued Datagram");
  return datagram.data;
}

const messagesIn = (events: ServerEvent[]) =>
  events.flatMap((event) =>
    event.type === "message" ? [{ id: event.id, body: event.body }] : [],
  );

test("the Server delivers each Message of a connected Datagram from its Connection", () => {
  const { server } = connectedPair();

  server.receive(clientDatagram(), CLIENT, 0);

  expect(messagesIn(server.pollEvents())).toEqual(SENT);
});

test("a connected Datagram cut inside a Message is dropped whole, without throwing", () => {
  const data = clientDatagram();
  const { server } = connectedPair();

  // One byte short of the end: the last Message is cut, and the first one goes with it.
  expect(() => server.receive(data.slice(0, -1), CLIENT, 0)).not.toThrow();

  expect(messagesIn(server.pollEvents())).toEqual([]);
});

test("whatever prefix of a connected Datagram arrives, no partial Message is ever delivered", () => {
  const data = clientDatagram();
  const { server } = connectedPair();

  for (let size = 0; size < data.byteLength; size++)
    server.receive(data.slice(0, size), CLIENT, 0);

  for (const message of messagesIn(server.pollEvents()))
    expect(SENT).toContainEqual(message);
});

test("whatever prefix of a connected Datagram of Sequenced Messages arrives, no partial Message is ever delivered", () => {
  const data = clientDatagram("sequenced");
  const whole = connectedPair().server;
  const cut = connectedPair().server;

  whole.receive(data, CLIENT, 0);
  cut.receive(data.slice(0, -1), CLIENT, 0);
  expect(messagesIn(whole.pollEvents())).toEqual(SENT);
  expect(messagesIn(cut.pollEvents())).toEqual([]);

  for (let size = 0; size < data.byteLength; size++)
    cut.receive(data.slice(0, size), CLIENT, 0);
  for (const message of messagesIn(cut.pollEvents()))
    expect(SENT).toContainEqual(message);
});

test("a connected Datagram with a Message claiming more bytes than remain, or of an unknown entry type, is dropped", () => {
  const data = clientDatagram();
  const { server } = connectedPair();
  // The first entry starts after the ten-byte header: a type byte, the id, then the body length.
  const overrunning = data.slice();
  new DataView(overrunning.buffer).setUint16(10 + 3, 0xffff);
  const unknownEntry = data.slice();
  unknownEntry[10] = 0xff;

  server.receive(overrunning, CLIENT, 0);
  server.receive(unknownEntry, CLIENT, 0);

  expect(messagesIn(server.pollEvents())).toEqual([]);
});

test("a connected Datagram from an address without a Connection is dropped", () => {
  const { server } = connectedPair();

  server.receive(clientDatagram(), { host: "10.0.0.66", port: 50000 }, 0);

  expect(server.pollEvents()).toEqual([]);
  expect(server.pollDatagrams()).toEqual([]);
});
