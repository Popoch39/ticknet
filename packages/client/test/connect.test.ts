import { expect, test } from "bun:test";
import {
  connect,
  MAX_AUTH_TOKEN_SIZE,
  PROTOCOL_VERSION,
} from "@ticknet/client";
import { ManualClock, SimulatedNetwork } from "@ticknet/core/testing";

const SERVER = { host: "10.0.0.1", port: 4000 };
const CLIENT = { host: "10.0.0.2", port: 50000 };

/**
 * Records how `promise` settles. Asserting on the record, rather than with
 * `expect(promise).rejects`, makes a promise that never settles fail the test
 * instead of blocking it: Bun waits for such a promise synchronously.
 */
function track(promise: Promise<unknown>): { failure?: unknown } {
  const outcome: { failure?: unknown } = {};
  promise.catch((error: unknown) => {
    outcome.failure = error;
  });
  return outcome;
}

/** Lets every pending promise callback run, without moving the Clock. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a Client that gets no answer fails to connect with a timeout reason after the configured delay", async () => {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock });
  const outcome = track(
    connect({
      ...SERVER,
      transport: network.bind(CLIENT),
      clock,
      timeout: 3000,
    }),
  );

  clock.advance(2999);
  await settle();
  expect(outcome.failure).toBeUndefined();

  clock.advance(1);
  await settle();
  expect(outcome.failure).toMatchObject({ reason: { kind: "timeout" } });
});

test("an Auth token too large for the Handshake fails the connect call at once, sending nothing", async () => {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock });
  const received: Uint8Array[] = [];
  network.bind(SERVER).listen({ datagram: (data) => received.push(data) });

  const outcome = track(
    connect({
      ...SERVER,
      transport: network.bind(CLIENT),
      clock,
      authToken: new Uint8Array(MAX_AUTH_TOKEN_SIZE + 1),
    }),
  );
  await settle();

  expect(outcome.failure).toBeInstanceOf(RangeError);
  expect(String(outcome.failure)).toContain(
    `at most ${MAX_AUTH_TOKEN_SIZE} fit in the Handshake`,
  );
  clock.advance(0);
  expect(received).toEqual([]);
});

test("a Client fails to connect with a version mismatch reason to a Server of another protocol version", async () => {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock });
  const otherVersionServer = network.bind(SERVER);
  otherVersionServer.listen({
    datagram: (_data, from) => {
      // Whatever its format, a Server of another version starts every Datagram with its own version byte.
      otherVersionServer.send([
        { to: from, data: Uint8Array.of(PROTOCOL_VERSION + 1, 5, 1) },
      ]);
    },
  });

  const outcome = track(
    connect({ ...SERVER, transport: network.bind(CLIENT), clock }),
  );
  clock.advance(0);
  await settle();

  expect(outcome.failure).toMatchObject({
    reason: { kind: "versionMismatch" },
  });
});

// A simulated Transport frees its address once closed, as a socket frees its port.
test("a connect that fails releases its Transport, whether it timed out or was refused at once", async () => {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock });
  const timedOut = track(
    connect({ ...SERVER, transport: network.bind(CLIENT), clock }),
  );
  clock.advance(10_000);
  await settle();
  const tooLarge = track(
    connect({
      ...SERVER,
      transport: network.bind(CLIENT),
      clock,
      authToken: new Uint8Array(MAX_AUTH_TOKEN_SIZE + 1),
    }),
  );
  await settle();

  expect(timedOut.failure).toMatchObject({ reason: { kind: "timeout" } });
  expect(tooLarge.failure).toBeInstanceOf(RangeError);
  expect(() => network.bind(CLIENT)).not.toThrow();
});
