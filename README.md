# ticknet

ticknet is a transport library for real-time multiplayer games on [Bun](https://bun.sh). It carries a game's own Messages between one Server and its Clients over UDP, each with the Delivery mode the game picks, and nothing more.

It handles what every networked game would otherwise rebuild: the Handshake, address proof and authentication, acknowledgements, resends, ordering, fragmentation of large Messages, keepalives and timeouts, a per-Connection Send budget, and a fixed-rate Tick loop that batches everything sent during a Tick.

It is **not** a netcode framework. It does not replicate game state, interpolate, predict, or estimate the Server's current Tick on the Client; it ships no schema language, matchmaking, rooms or peer-to-peer. You bring the encoding of your Messages and the game logic; a state-synchronization layer can be built on top.

## Limits of v1

- **Bun only.** The Server and the Client run on Bun and its `Bun.udpSocket`. Node.js is not supported.
- **No browser Client.** Browsers cannot open UDP sockets. The protocol core uses no Bun or Node API so that a later browser Transport (planned over WebTransport) can reuse it, but none ships in v1.
- **Plaintext Datagrams.** Nothing is encrypted or signed, and the Auth token is opaque bytes your game checks itself. Do not send secrets through ticknet v1.

## Install

The game Server and the game Client install their own package; the Client package does not pull any Server code.

```sh
bun add @ticknet/server   # in the game Server
bun add @ticknet/client   # in the game Client
```

Both depend on `@ticknet/core`, the protocol itself, and on nothing else. Add `@ticknet/core` yourself when a file shared by both sides defines the Messages, as below, or to use its testing tools.

## Usage

A small game in three files: players join with a name, move, chat, and every Client sees everyone's position 30 times per second.

### 1. Define the Messages

Define your Messages once, in a file both sides import. Each has an id (0 to 65,535, unique) and a codec that turns its value into bytes and back, written however you like: by hand with a `DataView`, as JSON, or with any serialization library.

```ts
// messages.ts
import { defineMessages } from "@ticknet/core";

export interface Player {
  name: string;
  x: number;
  y: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const messages = defineMessages({
  // Client → Server: where my character is. 8 bytes.
  move: {
    id: 1,
    encode: ({ x, y }: { x: number; y: number }) => {
      const data = new Uint8Array(8);
      const view = new DataView(data.buffer);
      view.setFloat32(0, x);
      view.setFloat32(4, y);
      return data;
    },
    decode: (data: Uint8Array) => {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return { x: view.getFloat32(0), y: view.getFloat32(4) };
    },
  },
  // Server → Clients, every Tick: everyone's position.
  world: {
    id: 2,
    encode: (players: Player[]) => encoder.encode(JSON.stringify(players)),
    decode: (data: Uint8Array): Player[] => JSON.parse(decoder.decode(data)),
  },
  // Both ways: a chat line.
  chat: {
    id: 3,
    encode: (text: string) => encoder.encode(text),
    decode: (data: Uint8Array) => decoder.decode(data),
  },
});
```

Sends and handlers are then type-checked against these definitions on both sides.

### 2. Write the Server

```ts
// server.ts
import { startServer } from "@ticknet/server";
import { messages, type Player } from "./messages";

const BAD_NAME = 1;
const players = new Set<Player>();

const server = await startServer({
  port: 4000,
  maxConnections: 32,
  // Runs once per Client, after the Handshake. `data` is attached to its Connection.
  authenticate: ({ authToken }) => {
    const name = new TextDecoder().decode(authToken).trim();
    if (!name) return { accept: false, code: BAD_NAME };
    return { accept: true, data: { name, x: 0, y: 0 } };
  },
});

server.on("connectionOpened", (connection) => {
  players.add(connection.data);
  server.broadcast(messages.chat, `${connection.data.name} joined`, "reliable");
});

server.on("connectionClosed", (connection, reason) => {
  players.delete(connection.data);
  server.broadcast(
    messages.chat,
    `${connection.data.name} left (${reason.kind})`,
    "reliable",
  );
});

server.onMessage(messages.move, (connection, { x, y }) => {
  connection.data.x = x;
  connection.data.y = y;
});

server.onMessage(messages.chat, (connection, text) => {
  server.broadcast(
    messages.chat,
    `${connection.data.name}: ${text}`,
    "reliable",
  );
});

// 30 times per second: step the game, then send the new state.
server.on("tick", () => {
  server.broadcast(messages.world, [...players], "sequenced");
});

process.on("SIGINT", () => {
  server.stop();
  process.exit(0);
});
```

### 3. Write the Client

```ts
// client.ts
import { ConnectError, connect, type Client } from "@ticknet/client";
import { messages } from "./messages";

let client: Client;
try {
  client = await connect({
    host: "127.0.0.1",
    port: 4000,
    authToken: new TextEncoder().encode("Ada"),
  });
} catch (error) {
  // The Server refused us, was full, or never answered.
  if (error instanceof ConnectError) {
    console.error(`Could not join: ${error.reason.kind}`);
    process.exit(1);
  }
  throw error;
}

client.onMessage(messages.world, (players) => {
  console.log(players.map(({ name, x, y }) => `${name} ${x},${y}`).join(" | "));
});
client.onMessage(messages.chat, (line) => console.log(line));

// Send where we are 30 times per second; only the newest one matters.
let x = 0;
const moving = setInterval(() => {
  x += 1;
  client.send(messages.move, { x, y: 0 }, "sequenced");
}, 1000 / 30);

// Whoever ends the Connection; sending afterwards would throw.
client.on("connectionClosed", (reason) => {
  clearInterval(moving);
  console.log(`Disconnected: ${reason.kind}`);
});

client.send(messages.chat, "hello", "reliable");

// Leave after 2 seconds, telling the Server.
setTimeout(() => client.close(), 2000);
```

Run `bun server.ts`, then `bun client.ts` in another terminal. The Client prints `Ada joined`, `Ada: hello` and the positions as they arrive, then `Disconnected: closedByClient` after 2 seconds. Without a name, `connect` throws a `ConnectError` whose reason is `{ kind: "denied", code: 1 }`.

Register a Client's handlers right after `await connect(...)`: Messages that arrive before then are held until the first handler or listener is added, so none is missed.

## Choosing a Delivery mode

Every send names a Delivery mode, chosen per send rather than per Message type:

| Delivery mode  | Guarantee                                                                                                    | Suits                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `"unreliable"` | May be lost or arrive out of order; never delivered twice.                                                   | One-off effects, sounds.                |
| `"sequenced"`  | May be lost; one older than the newest delivered of its type is dropped rather than delivered.               | Positions and other state, newest only. |
| `"reliable"`   | Arrives exactly once, in the order sent among the Connection's Reliable Messages, resent until acknowledged. | Chat, game events, initial world state. |

An Unreliable or Sequenced Message must fit in one Datagram: at most `MAX_DATAGRAM_MESSAGE_SIZE` (1,173) bytes once encoded, or `send` throws. A Reliable one may be up to `MAX_RELIABLE_MESSAGE_SIZE` (256 KiB) and travels as Fragments when it does not fit in one.

## The Tick

The library runs the Server's loop itself, at `tickRate` Ticks per second (30 by default), and calls your `tick` listener each time with the Tick's number. Everything sent during a Tick, from the listener or from Message handlers, leaves together at the end of that Tick, in as few Datagrams as possible; a Message handled between two Ticks waits for the end of the next one.

The Client sends its queued Messages the same way, at each Send step of its `sendRate` (30 per second by default). A higher rate on either side shortens that wait, at the cost of more Datagrams.

Each Connection may put at most `sendBudget` bytes on the network per Tick (4,800 by default). An Unreliable or Sequenced send that does not fit returns `false` and sends nothing; a Reliable one is never refused and waits for later Ticks.

## Server reference

`startServer(options)` resolves once the Server listens.

| Option           | Default              | What it does                                                                                                                        |
| ---------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `port`           | picked by the system | UDP port to listen on; read it back from `server.port`.                                                                             |
| `host`           | `"0.0.0.0"`          | Address to listen on.                                                                                                               |
| `tickRate`       | `30`                 | Ticks per second.                                                                                                                   |
| `maxConnections` | `64`                 | Further Clients are refused as `serverFull`.                                                                                        |
| `timeout`        | `10000`              | Milliseconds of silence before a Connection closes as `timeout`.                                                                    |
| `sendBudget`     | `4800`               | Bytes each Connection may send per Tick.                                                                                            |
| `authenticate`   | accept everyone      | `({ address, authToken }) => decision`, sync or async. Accept with `{ accept: true, data }`, refuse with `{ accept: false, code }`. |

| On the Server                             | What it does                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `server.on("connectionOpened", fn)`       | A Client was accepted; `fn(connection)`.                                                      |
| `server.on("connectionClosed", fn)`       | A Connection ended, whatever the cause; `fn(connection, reason)`.                             |
| `server.on("tick", fn)`                   | Once per Tick, before what was sent during it leaves; `fn(tick)`.                             |
| `server.on("error", fn)`                  | A Message failed to decode or a listener threw; the Server carries on. Logged when unhandled. |
| `server.onMessage(type, fn)`              | `fn(connection, value)` for each Message of that type.                                        |
| `server.broadcast(type, value, delivery)` | Sends to every Connection; returns those whose Send budget refused it.                        |
| `server.stop(code?)`                      | Closes every Connection with `code`, then releases the socket.                                |
| `connection.send(type, value, delivery)`  | Sends to one Client; `false` if its Send budget refused it.                                   |
| `connection.data`                         | What `authenticate` attached.                                                                 |
| `connection.address`                      | The Client's `{ host, port }`.                                                                |
| `connection.roundTripTime`, `.lossRate`   | Measured link health, in milliseconds and from 0 to 1; `undefined` until measured.            |
| `connection.close(code?)`                 | Ends this Connection; the Client sees `closedByServer` with `code`.                           |

## Client reference

`connect(options)` resolves once the Handshake is complete, or rejects with a `ConnectError` whose `reason` tells why.

| Option          | Default  | What it does                                                                                                  |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `host`, `port`  | required | The Server's address; a host name is resolved first.                                                          |
| `authToken`     | empty    | Bytes handed to the Server's `authenticate`, at most `MAX_AUTH_TOKEN_SIZE` (1,180).                           |
| `timeout`       | `10000`  | Milliseconds to wait for the Server, during the Handshake and then whenever it goes silent.                   |
| `sendRate`      | `30`     | Send steps per second.                                                                                        |
| `sendBudget`    | `4800`   | Bytes the Client may send per Send step.                                                                      |
| `wrapTransport` | none     | Wraps the Client's socket, for example with `withNetworkConditions` to play over a degraded link (see below). |

| On the Client                        | What it does                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `client.onMessage(type, fn)`         | `fn(value)` for each Message of that type.                                        |
| `client.send(type, value, delivery)` | Sends to the Server at the next Send step; `false` if the Send budget refused it. |
| `client.on("connectionClosed", fn)`  | The Connection ended, whatever the cause; `fn(reason)`.                           |
| `client.on("error", fn)`             | A Message failed to decode or its handler threw. Logged when unhandled.           |
| `client.lastServerTick`              | The newest Server Tick number received.                                           |
| `client.roundTripTime`, `.lossRate`  | Measured link health; `undefined` until measured.                                 |
| `client.close()`                     | Leaves, telling the Server, and releases the socket.                              |

## Why a Connection closes

`connectionClosed` listeners and `ConnectError` give a `CloseReason`; switch on its `kind`:

| `kind`                    | When                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `closedByClient`          | The Client called `close()`.                                                                     |
| `closedByServer`          | The Server called `connection.close(code)` or `server.stop(code)`; carries `code`.               |
| `denied`                  | `authenticate` refused the Client; carries its `code`.                                           |
| `serverFull`              | The Server already had `maxConnections`.                                                         |
| `timeout`                 | Nothing arrived from the other side for `timeout` milliseconds.                                  |
| `reliableBacklogOverflow` | More than `MAX_RELIABLE_BACKLOG` (1,024) Reliable Messages or Fragments awaited acknowledgement. |
| `versionMismatch`         | The Client and the Server run different protocol versions.                                       |

Codes are your game's own integers, from 0 to 65,535. Pick one for `server.stop` that no `connection.close` uses, so that Clients can tell a shutdown from a kick.

## Testing your game

`@ticknet/core/testing` holds a simulated network and a manual Clock, so that a test runs both sides in one process, without sockets or real time, over a link as bad as you want. The same seed replays the same run.

```ts
// game.test.ts
import { expect, test } from "bun:test";
import { connect } from "@ticknet/client";
import { ManualClock, SimulatedNetwork } from "@ticknet/core/testing";
import { startServer } from "@ticknet/server";
import { messages } from "./messages";

test("every chat line gets an answer, even over a bad link", async () => {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({
    clock,
    conditions: { loss: 0.2, latency: 50, jitter: 20 },
    seed: 7,
  });
  /** Moves simulated time forward, letting promises settle in between. */
  const pass = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 10) {
      clock.advance(10);
      await Bun.sleep(0);
    }
  };

  const server = await startServer({
    transport: network.bind({ host: "10.0.0.1", port: 4000 }),
    clock,
  });
  server.onMessage(messages.chat, (connection, text) => {
    connection.send(messages.chat, `You said: ${text}`, "reliable");
  });

  const connecting = connect({
    host: "10.0.0.1",
    port: 4000,
    transport: network.bind({ host: "10.0.0.2", port: 5000 }),
    clock,
  });
  await pass(5000);
  const client = await connecting;

  const lines: string[] = [];
  client.onMessage(messages.chat, (line) => lines.push(line));
  for (const text of ["one", "two", "three"])
    client.send(messages.chat, text, "reliable");
  await pass(5000);

  expect(lines).toEqual(["You said: one", "You said: two", "You said: three"]);
  client.close();
  server.stop();
});
```

Conditions take `loss`, `latency`, `jitter`, `duplication` and `reordering`. To play by hand over a degraded real link instead, wrap the Client's socket:

```ts
import { withNetworkConditions } from "@ticknet/core/testing";

const bad = { loss: 0.1, latency: 80, jitter: 20 };
const client = await connect({
  host: "127.0.0.1",
  port: 4000,
  wrapTransport: (transport, clock) =>
    withNetworkConditions(transport, { clock, send: bad, receive: bad }),
});
```

## The demo

[`examples/arena`](examples/arena) is a terminal arena played over real UDP, with bots, built only on the public API: positions are Sequenced, effects Unreliable and chat Reliable, and flags put loss and latency on a Client's link. Its README tells how to run it from a clone of this repository.

## For maintainers: building and releasing

The three packages are released together, at the same version.

```sh
bun run build                         # JavaScript (bun build) and declarations (tsc) into packages/*/dist
(cd packages/core && bun pm pack)     # the tarball one package would publish
NPM_CONFIG_TOKEN=dummy bun publish --dry-run --filter '@ticknet/*'   # every package, without publishing
```

Packing and publishing build first on their own (`prepack`), and copy this README and the licence into each package. `bun test` checks what the build and the tarballs contain.

**Nothing has been published yet.** Before the first real `bun publish`, check on npm that the `@ticknet` scope and the three package names are available to you (or rename the packages everywhere), then set the same version in the three `package.json` files and publish with `bun publish --filter '@ticknet/*'`, which takes core first. It rewrites the `workspace:*` dependencies to that exact version.

## Licence

MIT
