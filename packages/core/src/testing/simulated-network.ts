import type { Clock } from "../clock";
import {
  addressKey,
  type Address,
  type OutgoingDatagram,
  type Transport,
  type TransportReceiver,
} from "../transport";
import {
  ConditionedLink,
  SeededRandom,
  type EndpointConditions,
  type NetworkConditions,
} from "./network-conditions";

/** A Datagram on its way, with where it comes from and where it goes. */
interface Crossing {
  readonly data: Uint8Array;
  readonly from: Address;
  readonly to: Address;
}

const pathOf = ({ from, to }: Crossing) =>
  `${addressKey(from)}>${addressKey(to)}`;

export interface SimulatedNetworkOptions {
  /** Deliveries happen on this Clock, never synchronously inside a send. */
  readonly clock: Clock;
  /** Conditions on every path of the network; perfect by default. */
  readonly conditions?: NetworkConditions;
  /** Decides which Datagrams the conditions hit; the same seed replays the same run. 1 by default. */
  readonly seed?: number;
}

interface Endpoint {
  readonly transport: SimulatedTransport;
  readonly sendLink: ConditionedLink<Crossing> | undefined;
  readonly receiveLink: ConditionedLink<Crossing> | undefined;
}

/**
 * An in-process network joining any number of Transports, each bound to its
 * own Address. By default conditions are perfect: every Datagram arrives
 * once, in order.
 *
 * A Datagram crosses the sender's own conditions, then the network's, then
 * the receiver's, so their effects add up.
 */
export class SimulatedNetwork {
  readonly #clock: Clock;
  readonly #random: SeededRandom;
  readonly #endpoints = new Map<string, Endpoint>();
  readonly #link: ConditionedLink<Crossing>;

  constructor(options: SimulatedNetworkOptions) {
    this.#clock = options.clock;
    this.#random = new SeededRandom(options.seed ?? 1);
    this.#link = this.#newLink(options.conditions ?? {}, (crossing) =>
      this.#reach(crossing),
    );
  }

  /**
   * Returns a Transport that sends from `address` and receives what is sent
   * to it, with optional conditions of its own on either direction.
   */
  bind(address: Address, conditions: EndpointConditions = {}): Transport {
    const key = addressKey(address);
    if (this.#endpoints.has(key))
      throw new Error(`Address ${key} is already bound on this network`);
    const transport = new SimulatedTransport(
      (datagram) => this.#carry(address, datagram),
      () => this.#endpoints.delete(key),
    );
    this.#endpoints.set(key, {
      transport,
      sendLink:
        conditions.send &&
        this.#newLink(conditions.send, (crossing) =>
          this.#link.pass(pathOf(crossing), crossing),
        ),
      receiveLink:
        conditions.receive &&
        this.#newLink(conditions.receive, (crossing) =>
          this.#deliver(crossing),
        ),
    });
    return transport;
  }

  #newLink(
    conditions: NetworkConditions,
    arrive: (crossing: Crossing) => void,
  ): ConditionedLink<Crossing> {
    return new ConditionedLink(conditions, this.#random, this.#clock, arrive);
  }

  #carry(from: Address, datagram: OutgoingDatagram): void {
    // Copied at send time, as a socket would, so the sender may reuse its buffer.
    const crossing = { data: datagram.data.slice(), from, to: datagram.to };
    const sendLink = this.#endpoints.get(addressKey(from))?.sendLink;
    (sendLink ?? this.#link).pass(pathOf(crossing), crossing);
  }

  /** Hands a Datagram that crossed the network to its receiver's own conditions, if any. */
  #reach(crossing: Crossing): void {
    const receiveLink = this.#endpoints.get(
      addressKey(crossing.to),
    )?.receiveLink;
    if (receiveLink) receiveLink.pass(pathOf(crossing), crossing);
    else this.#deliver(crossing);
  }

  #deliver({ data, from, to }: Crossing): void {
    this.#endpoints.get(addressKey(to))?.transport.deliver(data, from);
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
