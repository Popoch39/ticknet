import { expect, test } from "bun:test";
import { connect } from "@ticknet/client";
import {
  SocketTransport,
  type DatagramSocket,
  type OutgoingDatagram,
} from "@ticknet/core";
import { ManualClock, SimulatedNetwork } from "@ticknet/core/testing";
import { defineMessages, startServer } from "@ticknet/server";

// A loopback socket never reports itself full, so these tests give the Server
// the UDP Transport over a fake socket: it stands for the operating system,
// carrying what it writes over a simulated network, and can run out of room.

const SERVER = { host: "10.0.0.1", port: 4000 };

const messages = defineMessages({
  chat: {
    id: 1,
    encode: (value: string) => new TextEncoder().encode(value),
    decode: (data: Uint8Array) => new TextDecoder().decode(data),
  },
});

/** A socket bound to SERVER on `network`, recording each `sendMany` call. */
function fakeSocket(network: SimulatedNetwork) {
  const endpoint = network.bind(SERVER);
  const calls: OutgoingDatagram[][] = [];
  let room = Infinity;
  let refusing = false;
  const socket: DatagramSocket = {
    sendMany(datagrams) {
      if (refusing) {
        refusing = false;
        // As Bun's socket throws once a Datagram it sent bounced off a closed port.
        throw Object.assign(new Error("connection refused, send"), {
          code: "ECONNREFUSED",
        });
      }
      const batch: OutgoingDatagram[] = [];
      for (let index = 0; index < datagrams.length; index += 3) {
        const [data, port, host] = datagrams.slice(index, index + 3);
        if (
          !(data instanceof Uint8Array) ||
          typeof port !== "number" ||
          typeof host !== "string"
        )
          throw new Error("Expected data, port, address triples");
        batch.push({ data, to: { host, port } });
      }
      calls.push(batch);
      const written = Math.min(room, batch.length);
      room -= written;
      endpoint.send(batch.slice(0, written));
      return written;
    },
    close: () => endpoint.close(),
  };
  const transport = new SocketTransport(socket);
  endpoint.listen({ datagram: (data, from) => transport.received(data, from) });
  return {
    transport,
    calls,
    /** Lets the socket write only `datagrams` more, as a full send buffer would. */
    limitRoom(datagrams: number) {
      room = datagrams;
    },
    /** The send buffer emptied, without the socket having said so yet. */
    freeRoom() {
      room = Infinity;
    },
    /** Makes the next `sendMany` call throw, writing nothing, as after a Datagram bounced off a closed port. */
    refuseNext() {
      refusing = true;
    },
  };
}

/** A Server ticking every 100 ms on a fake socket, and three connected Clients recording the chat lines they receive. */
async function setup() {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock });
  const socket = fakeSocket(network);
  const server = await startServer({
    transport: socket.transport,
    clock,
    tickRate: 10,
  });
  const received: string[][] = [];
  for (let index = 0; index < 3; index++) {
    const connecting = connect({
      ...SERVER,
      transport: network.bind({ host: "10.0.0.2", port: 50000 + index }),
      clock,
    });
    clock.advance(0);
    const client = await connecting;
    const lines: string[] = [];
    client.onMessage(messages.chat, (line) => lines.push(line));
    received.push(lines);
  }
  socket.calls.length = 0;
  return { clock, server, socket, received };
}

test("the Server flushes all Connections of a Tick through one sendMany call", async () => {
  const { clock, server, socket, received } = await setup();

  server.broadcast(messages.chat, "round starts", "unreliable");
  clock.advance(100);

  expect(socket.calls.map((batch) => batch.length)).toEqual([3]);
  expect(received).toEqual([
    ["round starts"],
    ["round starts"],
    ["round starts"],
  ]);
});

test("Datagrams a full socket could not write are lost, and sending resumes once the socket is writable again", async () => {
  const { clock, server, socket, received } = await setup();

  socket.limitRoom(1);
  server.broadcast(messages.chat, "one", "unreliable");
  clock.advance(100);
  expect(received.flat()).toEqual(["one"]);

  socket.freeRoom();
  server.broadcast(messages.chat, "two", "unreliable");
  clock.advance(100);
  expect(received.flat()).toEqual(["one"]);

  socket.transport.drained();
  server.broadcast(messages.chat, "three", "unreliable");
  clock.advance(100);
  expect(received).toEqual([["one", "three"], ["three"], ["three"]]);
});

test("a batch the socket refuses to send, as after a Datagram bounced off a closed port, is lost and the Server keeps ticking", async () => {
  const { clock, server, socket, received } = await setup();
  const ticks: number[] = [];
  server.on("tick", (tick) => ticks.push(tick));

  socket.refuseNext();
  server.broadcast(messages.chat, "lost", "unreliable");
  clock.advance(100);
  server.broadcast(messages.chat, "next", "unreliable");
  clock.advance(100);

  expect(ticks).toEqual([1, 2]);
  expect(received).toEqual([["next"], ["next"], ["next"]]);
});
