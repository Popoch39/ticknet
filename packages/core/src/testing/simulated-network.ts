import type { Clock } from "../clock";
import {
  addressKey,
  type Address,
  type OutgoingDatagram,
  type Transport,
  type TransportReceiver,
} from "../transport";

export interface SimulatedNetworkOptions {
  /** Deliveries happen on this Clock, never synchronously inside a send. */
  readonly clock: Clock;
}

/**
 * An in-process network joining any number of Transports, each bound to its
 * own Address. Conditions are perfect: every Datagram arrives once, in order.
 */
export class SimulatedNetwork {
  readonly #clock: Clock;
  readonly #endpoints = new Map<string, SimulatedTransport>();

  constructor(options: SimulatedNetworkOptions) {
    this.#clock = options.clock;
  }

  /** Returns a Transport that sends from `address` and receives what is sent to it. */
  bind(address: Address): Transport {
    const key = addressKey(address);
    if (this.#endpoints.has(key))
      throw new Error(`Address ${key} is already bound on this network`);
    const endpoint = new SimulatedTransport(
      (datagram) => this.#carry(address, datagram),
      () => this.#endpoints.delete(key),
    );
    this.#endpoints.set(key, endpoint);
    return endpoint;
  }

  #carry(from: Address, datagram: OutgoingDatagram): void {
    // Copied at send time, as a socket would, so the sender may reuse its buffer.
    const data = datagram.data.slice();
    this.#clock.schedule(this.#clock.now(), () => {
      this.#endpoints.get(addressKey(datagram.to))?.deliver(data, from);
    });
  }
}

class SimulatedTransport implements Transport {
  readonly #carry: (datagram: OutgoingDatagram) => void;
  readonly #unbind: () => void;
  #receiver: TransportReceiver | undefined;

  constructor(carry: (datagram: OutgoingDatagram) => void, unbind: () => void) {
    this.#carry = carry;
    this.#unbind = unbind;
  }

  listen(receiver: TransportReceiver): void {
    this.#receiver = receiver;
  }

  send(datagrams: readonly OutgoingDatagram[]): number {
    for (const datagram of datagrams) this.#carry(datagram);
    return datagrams.length;
  }

  close(): void {
    this.#receiver = undefined;
    this.#unbind();
  }

  deliver(data: Uint8Array, from: Address): void {
    this.#receiver?.datagram(data, from);
  }
}
