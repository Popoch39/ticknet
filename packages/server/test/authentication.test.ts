import { expect, test } from "bun:test";
import { ConnectError, MAX_AUTH_TOKEN_SIZE, connect } from "@ticknet/client";
import { ManualClock, SimulatedNetwork } from "@ticknet/core/testing";
import {
  startServer,
  type Address,
  type Authenticate,
  type AuthenticationDecision,
  type Connection,
} from "@ticknet/server";

const SERVER = { host: "10.0.0.1", port: 4000 };
const CLIENT = { host: "10.0.0.2", port: 50000 };

/**
 * Records how `promise` settles. Asserting on the record, rather than with
 * `expect(promise).rejects`, makes a promise that never settles fail the test
 * instead of blocking it: Bun waits for such a promise synchronously.
 */
function track(promise: Promise<unknown>): {
  connected?: boolean;
  failure?: unknown;
} {
  const outcome: { connected?: boolean; failure?: unknown } = {};
  promise.then(
    () => {
      outcome.connected = true;
    },
    (error: unknown) => {
      outcome.failure = error;
    },
  );
  return outcome;
}

/** Lets every pending promise callback run, without moving the Clock. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function setup<Data>(
  authenticate: Authenticate<Data>,
  options: { maxConnections?: number; timeout?: number } = {},
) {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock });
  const server = await startServer({
    ...options,
    transport: network.bind(SERVER),
    clock,
    authenticate,
  });
  const opened: Connection<Data>[] = [];
  server.on("connectionOpened", (connection) => opened.push(connection));
  const connectFrom = (address: Address, authToken?: Uint8Array) =>
    connect({ ...SERVER, transport: network.bind(address), clock, authToken });
  return { clock, network, server, opened, connectFrom };
}

test("the Client's Auth token reaches the authentication callback unchanged, with the Client's address", async () => {
  const requests: { authToken: Uint8Array; address: Address }[] = [];
  const { clock, connectFrom } = await setup((request) => {
    requests.push(request);
    return { accept: true };
  });
  const authToken = Uint8Array.of(0, 255, 7, 0, 42);

  const connecting = connectFrom(CLIENT, authToken);
  clock.advance(0);
  await connecting;

  expect(requests).toEqual([
    { authToken: Uint8Array.of(0, 255, 7, 0, 42), address: CLIENT },
  ]);
});

test("an Auth token of the largest size that fits in the Handshake reaches the callback whole", async () => {
  const tokens: Uint8Array[] = [];
  const { clock, connectFrom } = await setup(({ authToken }) => {
    tokens.push(authToken);
    return { accept: true };
  });
  const authToken = Uint8Array.from(
    { length: MAX_AUTH_TOKEN_SIZE },
    (_, index) => index % 251,
  );

  const connecting = connectFrom(CLIENT, authToken);
  clock.advance(0);
  await connecting;

  expect(tokens).toEqual([authToken]);
});

test("an accepting callback opens the Connection, which carries the data it returned", async () => {
  const { clock, opened, connectFrom } = await setup(({ authToken }) => ({
    accept: true,
    data: { player: new TextDecoder().decode(authToken) },
  }));

  const connecting = connectFrom(CLIENT, new TextEncoder().encode("ada"));
  clock.advance(0);
  await connecting;

  expect(opened).toHaveLength(1);
  expect(opened[0]?.data).toEqual({ player: "ada" });
  expect(opened[0]?.address).toEqual(CLIENT);
});

test("a denying callback opens no Connection, and the Client fails to connect with a denied reason carrying the developer's code", async () => {
  const { clock, opened, connectFrom } = await setup(() => ({
    accept: false,
    code: 403,
  }));

  const outcome = track(connectFrom(CLIENT));
  clock.advance(0);
  await settle();

  expect(outcome.failure).toBeInstanceOf(ConnectError);
  expect(outcome.failure).toMatchObject({
    reason: { kind: "denied", code: 403 },
  });
  expect(opened).toEqual([]);
});

/** A callback whose decisions the test hands out, one per request, in order. */
function deferredCallback<Data>() {
  const pending: ((decision: AuthenticationDecision<Data>) => void)[] = [];
  const authenticate: Authenticate<Data> = () =>
    new Promise((resolve) => pending.push(resolve));
  const answer = (decision: AuthenticationDecision<Data>) =>
    pending.shift()?.(decision);
  return { authenticate, answer, pending };
}

test("an asynchronous callback connects the Client once it accepts", async () => {
  const callback = deferredCallback<string>();
  const { clock, opened, connectFrom } = await setup(callback.authenticate);

  const outcome = track(connectFrom(CLIENT));
  clock.advance(0);
  await settle();
  expect(callback.pending).toHaveLength(1);
  expect(outcome).toEqual({});
  expect(opened).toEqual([]);

  callback.answer({ accept: true, data: "checked by the backend" });
  await settle();
  clock.advance(0);
  await settle();

  expect(outcome).toEqual({ connected: true });
  expect(opened.map((connection) => connection.data)).toEqual([
    "checked by the backend",
  ]);
});

test("an asynchronous callback denies the Client once it answers", async () => {
  const callback = deferredCallback<undefined>();
  const { clock, opened, connectFrom } = await setup(callback.authenticate);

  const outcome = track(connectFrom(CLIENT));
  clock.advance(0);
  await settle();
  callback.answer({ accept: false, code: 7 });
  await settle();
  clock.advance(0);
  await settle();

  expect(outcome.failure).toMatchObject({
    reason: { kind: "denied", code: 7 },
  });
  expect(opened).toEqual([]);
});

for (const [failing, fail] of [
  [
    "throws",
    () => {
      throw new Error("backend unreachable");
    },
  ],
  ["rejects", () => Promise.reject(new Error("backend unreachable"))],
] as const) {
  test(`a callback that ${failing} denies the Client and is reported, and the Server keeps accepting others`, async () => {
    const errors: unknown[] = [];
    const { clock, server, opened, connectFrom } = await setup(
      ({ authToken }) =>
        authToken.byteLength === 0 ? fail() : { accept: true },
    );
    server.on("error", (error) => errors.push(error));

    const failed = track(connectFrom(CLIENT));
    clock.advance(0);
    await settle();
    clock.advance(0);
    await settle();

    expect(failed.failure).toMatchObject({
      reason: { kind: "denied", code: 0 },
    });
    expect(errors).toEqual([new Error("backend unreachable")]);

    const other = connectFrom(
      { host: "10.0.0.3", port: 50000 },
      Uint8Array.of(1),
    );
    clock.advance(0);
    await other;
    expect(opened.map((connection) => connection.address.host)).toEqual([
      "10.0.0.3",
    ]);
  });
}

test("a denial with a code out of range denies the Client with code 0 and is reported", async () => {
  const errors: unknown[] = [];
  const { clock, server, connectFrom } = await setup(() => ({
    accept: false,
    code: 70_000,
  }));
  server.on("error", (error) => errors.push(error));

  const outcome = track(connectFrom(CLIENT));
  clock.advance(0);
  await settle();

  expect(outcome.failure).toMatchObject({
    reason: { kind: "denied", code: 0 },
  });
  expect(errors).toEqual([expect.any(RangeError)]);
});

test("a Client whose authentication never answers times out", async () => {
  const callback = deferredCallback<undefined>();
  const { clock, network, opened } = await setup(callback.authenticate);

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
  expect(outcome).toEqual({});

  clock.advance(1);
  await settle();
  expect(outcome.failure).toMatchObject({ reason: { kind: "timeout" } });
  expect(opened).toEqual([]);
});

test("stopping the Server tells a Client still being authenticated that it was closed by the Server, and a later answer opens nothing", async () => {
  const callback = deferredCallback<undefined>();
  const { clock, server, opened, connectFrom } = await setup(
    callback.authenticate,
  );
  const outcome = track(connectFrom(CLIENT));
  clock.advance(0);
  await settle();

  server.stop(3);
  clock.advance(0);
  await settle();
  expect(outcome.failure).toBeInstanceOf(ConnectError);
  expect(outcome.failure).toMatchObject({
    reason: { kind: "closedByServer", code: 3 },
  });

  callback.answer({ accept: true });
  await settle();
  clock.advance(0);
  await settle();
  expect(opened).toEqual([]);
});

const clientAt = (index: number) => ({ host: `10.0.1.${index}`, port: 50000 });

test("with the maximum number of Connections reached, a further Client fails with a Server full reason until one closes", async () => {
  const authenticated: Address[] = [];
  const { clock, opened, connectFrom } = await setup(
    ({ address }) => {
      authenticated.push(address);
      return { accept: true };
    },
    { maxConnections: 2 },
  );
  const first = [connectFrom(clientAt(1)), connectFrom(clientAt(2))];
  clock.advance(0);
  await Promise.all(first);

  const refused = track(connectFrom(clientAt(3)));
  clock.advance(0);
  await settle();

  expect(refused.failure).toBeInstanceOf(ConnectError);
  expect(refused.failure).toMatchObject({ reason: { kind: "serverFull" } });
  // A full Server refuses before asking the game.
  expect(authenticated).toEqual([clientAt(1), clientAt(2)]);

  opened[0]?.close();
  const later = connectFrom(clientAt(4));
  clock.advance(0);
  await later;
  expect(opened.map((connection) => connection.address)).toEqual([
    clientAt(1),
    clientAt(2),
    clientAt(4),
  ]);
});

test("a Client still being authenticated holds a place under the maximum number of Connections", async () => {
  const callback = deferredCallback<undefined>();
  const { clock, opened, connectFrom } = await setup(callback.authenticate, {
    maxConnections: 1,
  });

  const pending = track(connectFrom(clientAt(1)));
  clock.advance(0);
  await settle();
  const refused = track(connectFrom(clientAt(2)));
  clock.advance(0);
  await settle();
  expect(refused.failure).toMatchObject({ reason: { kind: "serverFull" } });

  callback.answer({ accept: true });
  await settle();
  clock.advance(0);
  await settle();
  expect(pending).toEqual({ connected: true });
  expect(opened).toHaveLength(1);
});

test("the Server stops waiting for an authentication that never answers after its timeout, freeing the place", async () => {
  const callback = deferredCallback<undefined>();
  const { clock, opened, connectFrom } = await setup(callback.authenticate, {
    maxConnections: 1,
    timeout: 5000,
  });
  track(connectFrom(clientAt(1)));
  clock.advance(0);
  await settle();

  clock.advance(4999);
  const tooEarly = track(connectFrom(clientAt(2)));
  clock.advance(0);
  await settle();
  expect(tooEarly.failure).toMatchObject({ reason: { kind: "serverFull" } });

  clock.advance(1);
  const later = track(connectFrom(clientAt(3)));
  clock.advance(0);
  await settle();
  // The first answer arrives too late to count; the second is for the Client that took the place.
  callback.answer({ accept: true });
  callback.answer({ accept: true });
  await settle();
  clock.advance(0);
  await settle();

  expect(later).toEqual({ connected: true });
  expect(opened.map((connection) => connection.address)).toEqual([clientAt(3)]);
});
