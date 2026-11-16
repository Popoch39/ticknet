// Everything this package takes from Bun, the protocol itself living in core.
// The client package has the same file: they are published separately, and
// the client must not depend on server code.
import { isIP } from "node:net";
import { SocketTransport, type Clock } from "@ticknet/core";

/** Real time, in milliseconds, with real timers. */
export const realClock: Clock = {
  now: () => performance.now(),
  schedule(at, callback) {
    // Rounded up: a timer that fires before `at` would find nothing due.
    const timer = setTimeout(
      callback,
      Math.max(0, Math.ceil(at - performance.now())),
    );
    return () => clearTimeout(timer);
  },
};

/**
 * Resolves a host name, or passes an IP address through, preferring IPv4:
 * `Bun.udpSocket` only sends to IP addresses, and "localhost" must name the
 * same address on both sides.
 */
export async function resolveHost(host: string): Promise<string> {
  // Bun 1.4.4 keeps the process alive for a second after looking up an IPv4 address.
  if (isIP(host)) return host;
  const addresses = await Bun.dns.lookup(host);
  const chosen =
    addresses.find((address) => address.family === 4) ?? addresses[0];
  if (!chosen) throw new Error(`No address found for ${host}`);
  return chosen.address;
}

/**
 * Opens a UDP socket on `hostname` (an IP address) and `port` (0 for one the
 * system picks), and returns a Transport over it with the port it got.
 */
export async function openUdpTransport(
  hostname: string,
  port: number,
): Promise<{ transport: SocketTransport; port: number }> {
  let transport: SocketTransport | undefined;
  const socket = await Bun.udpSocket({
    hostname,
    port,
    binaryType: "uint8array",
    socket: {
      data: (_socket, data, fromPort, fromHost) =>
        transport?.received(data, { host: fromHost, port: fromPort }),
      drain: () => transport?.drained(),
      // Bun 1.4.4 calls this handler with the error as its only argument, not
      // with the socket first as its type declares.
      error: (...args: unknown[]) => {
        const [error] = args;
        // A Datagram bounced off a closed port: the other side is gone, which
        // the protocol learns by itself.
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ECONNREFUSED"
        )
          return;
        // Without a handler, Bun would report it as uncaught; the socket stays usable.
        console.error(error);
      },
    },
  });
  transport = new SocketTransport(socket);
  return { transport, port: socket.port };
}
