import type { Clock } from "../clock";
import {
  addressKey,
  type Address,
  type OutgoingDatagram,
  type Transport,
} from "../transport";
import {
  ConditionedLink,
  SeededRandom,
  type EndpointConditions,
} from "./network-conditions";

export interface ConditionedTransportOptions extends EndpointConditions {
  /** Delays are measured on this Clock: a real one over a real socket. */
  readonly clock: Clock;
  /** Decides which Datagrams the conditions hit; the same seed replays the same run. 1 by default. */
  readonly seed?: number;
}

interface Received {
  readonly data: Uint8Array;
  readonly from: Address;
}

/**
 * Wraps any Transport, a real UDP socket included, so that what it sends and
 * what it receives suffer the given conditions, for example to play a
 * running game over a bad link.
 */
export function withNetworkConditions(
  transport: Transport,
  options: ConditionedTransportOptions,
): Transport {
  const random = new SeededRandom(options.seed ?? 1);
  const sendLink = new ConditionedLink<OutgoingDatagram>(
    options.send ?? {},
    random,
    options.clock,
    (datagram) => transport.send([datagram]),
  );
  const receiveConditions = options.receive ?? {};
  let receiveLink: ConditionedLink<Received> | undefined;
  return {
    listen(receiver) {
      const link = new ConditionedLink<Received>(
        receiveConditions,
        random,
        options.clock,
        ({ data, from }) => receiver.datagram(data, from),
      );
      receiveLink?.stop();
      receiveLink = link;
      transport.listen({
        // Copied now, since the Transport may reuse its buffer once this returns.
        datagram: (data, from) =>
          link.pass(addressKey(from), { data: data.slice(), from }),
      });
    },
    send(datagrams) {
      // Copied now, as a socket would, so the sender may reuse its buffer.
      for (const { to, data } of datagrams)
        sendLink.pass(addressKey(to), { to, data: data.slice() });
      // Whatever the conditions lose was accepted, then lost on the way.
      return datagrams.length;
    },
    close() {
      sendLink.stop();
      receiveLink?.stop();
      transport.close();
    },
  };
}
