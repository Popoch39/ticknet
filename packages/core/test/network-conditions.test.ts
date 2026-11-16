import { expect, test } from "bun:test";
import type { Address, Transport } from "@ticknet/core";
import {
  ManualClock,
  SimulatedNetwork,
  withNetworkConditions,
  type NetworkConditions,
  type ConditionedTransportOptions,
} from "@ticknet/core/testing";

const SENDER: Address = { host: "10.0.0.1", port: 4000 };
const RECEIVER: Address = { host: "10.0.0.2", port: 50000 };

/** A Datagram carrying `value`, from 0 to 65535. */
const bytes = (value: number) => Uint8Array.of(value >> 8, value & 0xff);

/** Records every Datagram `transport` receives, with the time it arrived and the value it carries. */
function deliveries(transport: Transport, clock: ManualClock) {
  const received: { at: number; value: number; from: Address }[] = [];
  transport.listen({
    datagram: (data, from) =>
      received.push({
        at: clock.now(),
        value: ((data[0] ?? 0) << 8) | (data[1] ?? 0),
        from,
      }),
  });
  return received;
}

/**
 * A network with the given conditions on every path, and a sender whose
 * Datagrams the receiver records.
 */
function link(options: { seed?: number; conditions?: NetworkConditions }) {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock, ...options });
  const sender = network.bind(SENDER);
  const received = deliveries(network.bind(RECEIVER), clock);
  /** Sends one Datagram per value, each in its own call, `interval` ms apart. */
  const sendEach = (values: number[], interval = 10) => {
    for (const value of values) {
      sender.send([{ to: RECEIVER, data: bytes(value) }]);
      clock.advance(interval);
    }
  };
  return { clock, network, sender, received, sendEach };
}

const range = (count: number) => Array.from({ length: count }, (_, i) => i);

test("latency delays every Datagram by that many milliseconds of the injected Clock", () => {
  const { clock, sender, received } = link({ conditions: { latency: 80 } });

  sender.send([{ to: RECEIVER, data: bytes(1) }]);
  clock.advance(79);
  expect(received).toEqual([]);

  clock.advance(1);
  expect(received).toEqual([{ at: 80, value: 1, from: SENDER }]);
});

test("jitter adds up to that many milliseconds to each Datagram's latency", () => {
  const { clock, received, sender } = link({
    conditions: { latency: 50, jitter: 20 },
  });

  for (const value of range(200))
    sender.send([{ to: RECEIVER, data: bytes(value) }]);
  clock.advance(1000);

  const delays = received.map(({ at }) => at);
  expect(delays).toHaveLength(200);
  expect(Math.min(...delays)).toBeGreaterThanOrEqual(50);
  expect(Math.max(...delays)).toBeLessThanOrEqual(70);
  expect(new Set(delays).size).toBeGreaterThan(10);
});

test("a loss rate drops about that share of Datagrams; the others arrive once, in order", () => {
  const { received, sendEach } = link({ seed: 1, conditions: { loss: 0.25 } });

  sendEach(range(1000));

  const values = received.map(({ value }) => value);
  expect(values.length).toBeGreaterThan(700);
  expect(values.length).toBeLessThan(800);
  expect(values).toEqual([...values].sort((a, b) => a - b));
  expect(new Set(values).size).toBe(values.length);
});

test("a duplication rate makes about that share of Datagrams arrive twice", () => {
  const { received, sendEach } = link({ conditions: { duplication: 0.2 } });

  sendEach(range(1000));

  const counts = new Map<number, number>();
  for (const { value } of received)
    counts.set(value, (counts.get(value) ?? 0) + 1);
  const twice = [...counts.values()].filter((count) => count === 2).length;
  expect(counts.size).toBe(1000);
  expect([...counts.values()].every((count) => count <= 2)).toBe(true);
  expect(twice).toBeGreaterThan(150);
  expect(twice).toBeLessThan(250);
});

test("a reordering rate makes about that share of Datagrams arrive after the one sent next, and none is lost", () => {
  const { clock, received, sendEach } = link({
    conditions: { reordering: 0.2 },
  });

  sendEach(range(1000));
  clock.advance(1000);

  const values = received.map(({ value }) => value);
  const overtaken = values.filter(
    (value, index) => value > (values[index + 1] ?? Infinity),
  ).length;
  expect([...values].sort((a, b) => a - b)).toEqual(range(1000));
  expect(overtaken).toBeGreaterThan(150);
  expect(overtaken).toBeLessThan(250);
});

test("a Datagram held back for reordering that nothing overtakes still arrives, 100 ms late", () => {
  const { clock, sender, received } = link({
    conditions: { latency: 30, reordering: 1 },
  });

  sender.send([{ to: RECEIVER, data: bytes(1) }]);
  clock.advance(129);
  expect(received).toEqual([]);

  clock.advance(1);
  expect(received).toEqual([{ at: 130, value: 1, from: SENDER }]);
});

const everyCondition: NetworkConditions = {
  loss: 0.1,
  latency: 40,
  jitter: 25,
  reordering: 0.1,
  duplication: 0.1,
};

/** The deliveries of one run of the same scripted traffic under every condition. */
function run(seed: number) {
  const { clock, received, sendEach } = link({
    seed,
    conditions: everyCondition,
  });
  sendEach(range(300), 5);
  clock.advance(1000);
  return received;
}

test("two runs with the same seed deliver the same Datagrams at the same times; another seed does not", () => {
  expect(run(42)).toEqual(run(42));
  expect(run(43)).not.toEqual(run(42));
});

test("conditions out of range are refused when the network is created", () => {
  const clock = new ManualClock();
  for (const conditions of [
    { loss: 1.5 },
    { loss: -0.1 },
    { duplication: 2 },
    { reordering: Number.NaN },
    { latency: -1 },
    { jitter: Infinity },
  ])
    expect(() => new SimulatedNetwork({ clock, conditions })).toThrow(
      RangeError,
    );
});

test("conditions set on what one endpoint sends leave the other direction perfect", () => {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock });
  const lossySender = network.bind(SENDER, { send: { loss: 1 } });
  const receiver = network.bind(RECEIVER);
  const atSender = deliveries(lossySender, clock);
  const atReceiver = deliveries(receiver, clock);

  lossySender.send([{ to: RECEIVER, data: bytes(1) }]);
  receiver.send([{ to: SENDER, data: bytes(2) }]);
  clock.advance(0);

  expect(atReceiver).toEqual([]);
  expect(atSender).toEqual([{ at: 0, value: 2, from: RECEIVER }]);
});

test("conditions set on what one endpoint receives add to the network's own", () => {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({
    clock,
    conditions: { latency: 20 },
  });
  const sender = network.bind(SENDER);
  const slowReceiver = network.bind(RECEIVER, { receive: { latency: 50 } });
  const atSender = deliveries(sender, clock);
  const atReceiver = deliveries(slowReceiver, clock);

  sender.send([{ to: RECEIVER, data: bytes(1) }]);
  slowReceiver.send([{ to: SENDER, data: bytes(2) }]);
  clock.advance(100);

  expect(atReceiver).toEqual([{ at: 70, value: 1, from: SENDER }]);
  expect(atSender).toEqual([{ at: 20, value: 2, from: RECEIVER }]);
});

/**
 * Two endpoints on a perfect network, standing in for any Transport, and
 * the sender's Transport wrapped with conditions.
 */
function wrapped(conditions: Omit<ConditionedTransportOptions, "clock">) {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock });
  const inner = network.bind(SENDER);
  const sender = withNetworkConditions(inner, { clock, ...conditions });
  const other = network.bind(RECEIVER);
  const atSender = deliveries(sender, clock);
  const atOther = deliveries(other, clock);
  return { clock, sender, other, atSender, atOther };
}

test("a wrapped Transport applies its send conditions to what it sends and its receive conditions to what it receives", () => {
  const { clock, sender, other, atSender, atOther } = wrapped({
    send: { latency: 30 },
    receive: { latency: 70 },
  });

  sender.send([{ to: RECEIVER, data: bytes(1) }]);
  other.send([{ to: SENDER, data: bytes(2) }]);
  clock.advance(100);

  expect(atOther).toEqual([{ at: 30, value: 1, from: SENDER }]);
  expect(atSender).toEqual([{ at: 70, value: 2, from: RECEIVER }]);
});

test("a wrapped Transport accepts every Datagram it is given, even those its conditions lose", () => {
  const { clock, sender, atOther } = wrapped({ send: { loss: 1 } });

  const accepted = sender.send([
    { to: RECEIVER, data: bytes(1) },
    { to: RECEIVER, data: bytes(2) },
  ]);
  clock.advance(100);

  expect(accepted).toBe(2);
  expect(atOther).toEqual([]);
});

test("a wrapped Transport replays the same deliveries from the same seed", () => {
  const replay = (seed: number) => {
    const { clock, sender, other, atSender, atOther } = wrapped({
      seed,
      send: everyCondition,
      receive: everyCondition,
    });
    for (const value of range(200)) {
      sender.send([{ to: RECEIVER, data: bytes(value) }]);
      other.send([{ to: SENDER, data: bytes(value) }]);
      clock.advance(5);
    }
    clock.advance(1000);
    return { atSender, atOther };
  };

  expect(replay(7)).toEqual(replay(7));
  expect(replay(8)).not.toEqual(replay(7));
});

test("closing a wrapped Transport closes the one inside and drops what its conditions still hold", () => {
  const { clock, sender, other, atSender, atOther } = wrapped({
    send: { latency: 50 },
    receive: { latency: 50 },
  });

  sender.send([{ to: RECEIVER, data: bytes(1) }]);
  other.send([{ to: SENDER, data: bytes(2) }]);
  clock.advance(10);
  sender.close();
  clock.advance(100);
  other.send([{ to: SENDER, data: bytes(3) }]);
  clock.advance(100);

  expect(atOther).toEqual([]);
  expect(atSender).toEqual([]);
});

test("a loss rate of 1 drops everything, and of 0 nothing", () => {
  const lossy = link({ conditions: { loss: 1 } });
  lossy.sendEach(range(50));
  expect(lossy.received).toEqual([]);

  const perfect = link({ conditions: { loss: 0 } });
  perfect.sendEach(range(50));
  expect(perfect.received).toHaveLength(50);
});
