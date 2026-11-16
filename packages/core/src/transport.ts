/** Where a Datagram comes from or goes to, as the Transport reports it. */
export interface Address {
  readonly host: string;
  readonly port: number;
}

/** A string that is equal for two Addresses exactly when they name the same endpoint. */
export function addressKey(address: Address): string {
  return `${address.host}:${address.port}`;
}

export interface OutgoingDatagram {
  readonly to: Address;
  readonly data: Uint8Array;
}

/** What a Transport calls when Datagrams reach the endpoint it serves. */
export interface TransportReceiver {
  datagram(data: Uint8Array, from: Address): void;
}

/**
 * The means by which Datagrams leave and reach an endpoint. This is the only
 * thing a new kind of network (a UDP socket, a simulated network, a browser
 * API) has to implement.
 */
export interface Transport {
  /** Starts handing received Datagrams to `receiver`. */
  listen(receiver: TransportReceiver): void;
  /**
   * Sends Datagrams in order and returns how many were accepted; the rest are
   * lost, as they could be on the network.
   */
  send(datagrams: readonly OutgoingDatagram[]): number;
  close(): void;
}
