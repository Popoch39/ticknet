import { expect, test } from "bun:test";
import { connect } from "@ticknet/client";
import { SocketTransport, type Clock } from "@ticknet/core";
import { withNetworkConditions } from "@ticknet/core/testing";
import { defineMessages, startServer } from "@ticknet/server";

// Real sockets and real timers: the test waits for events, never for a fixed delay.

const realClock: Clock = {
  now: () => performance.now(),
  schedule(at, callback) {
    const timer = setTimeout(
      callback,
      Math.max(0, Math.ceil(at - performance.now())),
    );
    return () => clearTimeout(timer);
  },
};

/** A UDP socket on loopback as a Transport, opened the way a game would. */
async function loopbackTransport() {
  let transport: SocketTransport | undefined;
  const socket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    binaryType: "uint8array",
    socket: {
      data: (_socket, data, port, host) =>
        transport?.received(data, { host, port }),
      drain: () => transport?.drained(),
      // Bun calls this with the error alone. A Datagram bounced off a closed port is expected at shutdown.
      error: (...args: unknown[]) => {
        const [error] = args;
        if (error instanceof Error && "code" in error)
          if (error.code === "ECONNREFUSED") return;
        throw error;
      },
    },
  });
  transport = new SocketTransport(socket);
  return { transport, port: socket.port };
}

const messages = defineMessages({
  count: {
    id: 1,
    encode: (value: number) => Uint8Array.of(value),
    decode: (data: Uint8Array) => data[0] ?? 0,
  },
});

/** Records values as they arrive; `until(value)` resolves once that value arrived. */
function recorder() {
  const values: number[] = [];
  const waiting = new Map<number, () => void>();
  return {
    values,
    record(value: number) {
      values.push(value);
      waiting.get(value)?.();
    },
    until: (value: number) =>
      new Promise<void>((resolve) => {
        if (values.includes(value)) resolve();
        else waiting.set(value, resolve);
      }),
  };
}

test("network conditions wrapped around a real UDP socket delay and duplicate its Datagrams, and each Message still arrives once", async () => {
  const udp = await loopbackTransport();
  const server = await startServer({
    transport: withNetworkConditions(udp.transport, {
      clock: realClock,
      seed: 1,
      send: { latency: 30, duplication: 1 },
      receive: { latency: 30, duplication: 1 },
    }),
  });
  const atServer = recorder();
  server.onMessage(messages.count, (connection, value) => {
    atServer.record(value);
    connection.send(messages.count, value, "unreliable");
  });
  const client = await connect({ host: "127.0.0.1", port: udp.port });
  const atClient = recorder();
  client.onMessage(messages.count, (value) => atClient.record(value));

  for (const value of [1, 2, 3])
    client.send(messages.count, value, "unreliable");
  await atClient.until(3);
  // Copies arrive with their original, so any duplicate delivery shows up before this round trip ends.
  const start = performance.now();
  client.send(messages.count, 99, "unreliable");
  await atClient.until(99);
  const roundTrip = performance.now() - start;

  expect(atServer.values).toEqual([1, 2, 3, 99]);
  expect(atClient.values).toEqual([1, 2, 3, 99]);
  expect(roundTrip).toBeGreaterThanOrEqual(60);
  client.close();
  server.stop();
});
