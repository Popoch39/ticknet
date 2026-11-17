import type {
  Address,
  OutgoingDatagram,
  Transport,
  TransportReceiver,
} from "./transport";

/**
 * The part of an unconnected UDP socket that a SocketTransport drives.
 * `Bun.udpSocket` fits it; core only describes it, so that it stays free of
 * any runtime API.
 */
export interface DatagramSocket {
  /**
   * Sends flat `data, port, address` triples, the address being an IP
   * literal, and returns how many Datagrams were written: a prefix of the
   * batch, cut at the first one the socket had no room for. May throw a
   * system error, with a `code`, writing nothing: Bun's does once a Datagram
   * it sent bounced off a closed port.
   */
  sendMany(datagrams: readonly (Uint8Array | number | string)[]): number;
  close(): void;
}

/**
 * A Transport over a UDP socket. The code that opens the socket forwards its
 * events here: `received` for each Datagram, `drained` when the socket is
 * writable again.
 *
 * Nothing is queued: once the socket could not write a whole batch, the rest
 * of it and everything sent until `drained` is lost, as it could be on the
 * network. Reliable content is resent by the protocol.
 */
export class SocketTransport implements Transport {
  readonly #socket: DatagramSocket;
  #receiver: TransportReceiver | undefined;
  #full = false;

  constructor(socket: DatagramSocket) {
    this.#socket = socket;
  }

  listen(receiver: TransportReceiver): void {
    this.#receiver = receiver;
  }

  send(datagrams: readonly OutgoingDatagram[]): number {
    if (this.#full || datagrams.length === 0) return 0;
    let written: number;
    try {
      written = this.#socket.sendMany(
        datagrams.flatMap(({ to, data }) => [data, to.port, to.host]),
      );
    } catch (error) {
      // The network refused the batch: lost, as it could be on the way, which the protocol copes with.
      if (isSystemError(error)) return 0;
      throw error;
    }
    if (written < datagrams.length) this.#full = true;
    return written;
  }

  received(data: Uint8Array, from: Address): void {
    this.#receiver?.datagram(data, from);
  }

  drained(): void {
    this.#full = false;
  }

  close(): void {
    this.#receiver = undefined;
    this.#socket.close();
  }
}

/** Whether `error` comes from the operating system, which names it by a code such as ECONNREFUSED. */
function isSystemError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && typeof error.code === "string"
  );
}
