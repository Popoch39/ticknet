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

## A Server and a Client exchanging a Message

Define your Messages once, in a file both sides import. Each has a numeric id and a codec, written however you like:

```ts
// messages.ts
import { defineMessages } from "@ticknet/core";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const messages = defineMessages({
  chat: {
    id: 1,
    encode: (text: string) => encoder.encode(text),
    decode: (data: Uint8Array) => decoder.decode(data),
  },
});
```

The Server listens on a UDP port and answers each chat line:

```ts
// server.ts
import { startServer } from "@ticknet/server";
import { messages } from "./messages";

const server = await startServer({ port: 4000 });

server.on("connectionOpened", (connection) => {
  console.log(`${connection.address.host} joined`);
});
server.onMessage(messages.chat, (connection, text) => {
  connection.send(messages.chat, `You said: ${text}`, "reliable");
});
```

The Client connects, sends one line, and leaves once it has the answer:

```ts
// client.ts
import { connect } from "@ticknet/client";
import { messages } from "./messages";

const client = await connect({ host: "127.0.0.1", port: 4000 });

client.onMessage(messages.chat, (text) => {
  console.log(text);
  client.close();
});
client.send(messages.chat, "hello", "reliable");
```

Run `bun server.ts`, then `bun client.ts` in another terminal: the Client prints `You said: hello`.

Register a Client's handlers right after `await connect(...)`: Messages that arrive before then are held until the first handler or listener is added.

## The Tick

The library runs the Server's loop itself, at a fixed rate (`tickRate`, 30 Ticks per second by default). Each Tick has a number, counted from the start, and runs your Tick listener:

```ts
server.on("tick", (tick) => {
  // Step the game, then tell the Clients about it.
  server.broadcast(messages.chat, `Tick ${tick}`, "unreliable");
});
```

Everything sent during a Tick, from the listener or from Message handlers, leaves together at the end of that Tick, in as few Datagrams as possible. Messages sent between Ticks wait for the end of the next one. The Client sends its queued Messages the same way, at its own `sendRate` (30 per second by default), and exposes `lastServerTick`, the newest Tick number it received. Every Connection may put at most `sendBudget` bytes on the network per Tick: an Unreliable or Sequenced send that does not fit returns `false` and sends nothing.

## The three Delivery modes

Every send names a Delivery mode, chosen per Message rather than per type:

| Delivery mode  | Guarantee                                                                                                    | Suits                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `"unreliable"` | May be lost or arrive out of order; never delivered twice.                                                   | One-off effects, sounds.                |
| `"sequenced"`  | May be lost; one older than the newest delivered of its type is dropped rather than delivered.               | Positions and other state, newest only. |
| `"reliable"`   | Arrives exactly once, in the order sent among the Connection's Reliable Messages, resent until acknowledged. | Chat, game events, initial world state. |

An Unreliable or Sequenced Message must fit in one Datagram (`send` throws otherwise). A Reliable one may be up to `MAX_RELIABLE_MESSAGE_SIZE` bytes and travels as Fragments when it does not fit in one.

## Testing your game

`@ticknet/core/testing` holds a simulated network, a manual Clock and a wrapper that adds loss, latency, jitter, reordering and duplication to any Transport, seeded so that a run replays. Pass `transport` and `clock` to `startServer` and `connect` to run both sides in one test, without sockets or real time; or pass `wrapTransport` to `connect` to play over a degraded real link.

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
