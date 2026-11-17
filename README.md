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

## Performance

How ticknet compares with the two other ways a Bun game Server commonly reaches its Clients: WebSockets, and WebRTC data channels through [geckos.io](https://github.com/geckosio/geckos.io).

In short: on a link that loses packets, ticknet keeps latency low and steady where the others fall behind. In exchange, its Server uses about twice the CPU of Bun's WebSockets, and everything except what the Tick listener sends waits up to one Tick before it leaves.

### What was measured

Every run plays the [arena](examples/arena)'s game with N bots. Each bot sends its position 30 times per second, lets off a blast about every 5 seconds and says a chat line about every 10 seconds. The Server sends the whole world to every Client on each of its 30 Ticks per second: 1,012 bytes with 200 characters. The Message bodies are the same bytes on every transport. Each one is used the way its own users would use it:

| What                        | ticknet           | WebSocket                                              | geckos.io                                               |
| --------------------------- | ----------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| World snapshot, every Tick  | Sequenced         | TCP, reliable and ordered                              | Unreliable; the game drops any older than the last      |
| Bot position, 30 per second | Sequenced         | TCP                                                    | Unreliable                                              |
| Blast, about every 5 s      | Unreliable        | TCP                                                    | Unreliable                                              |
| Chat line, about every 10 s | Reliable          | TCP                                                    | Its `reliable` event: JSON, sent 10 times, 150 ms apart |
| Server                      | `@ticknet/server` | `Bun.serve` WebSockets (uWebSockets), `server.publish` | geckos.io 3.1.0, on Bun                                 |

The WebSocket and geckos.io Servers send each reply as soon as they handle a Message, and the world on their own 30 Hz loop. Their bots use Bun's `WebSocket`, or the geckos.io client over node-datachannel 0.32.1.

Every process runs on one machine (Intel Core Ultra 7 258V, 8 cores, Linux, Bun 1.4.4), in a network namespace of its own. netem on its loopback degrades every packet, in each direction:

| Profile | Added to each direction | Round trip   | Loss per packet |
| ------- | ----------------------- | ------------ | --------------- |
| clean   | nothing                 | under 1 ms   | 0%              |
| wan     | 30 ms ± 5 ms            | about 60 ms  | 1%              |
| bad     | 60 ms ± 15 ms           | about 120 ms | 5%              |

Latencies are one-way: from the sender's `send` call to the receiver's handler, read on the machine's monotonic clock, which all processes share. Each figure covers a 20-second window, opened 3 seconds after every bot connected. A Message counts as delivered if it arrives within 5 seconds after the window closes.

### Server cost

On the clean profile. CPU is the share of one core the Server process used, all its threads included; with 100 and 200 Clients, the ticknet and WebSocket figures span three runs.

| Clients | ticknet CPU | WebSocket CPU | geckos.io CPU | ticknet memory | WebSocket memory | geckos.io memory |
| ------: | ----------: | ------------: | ------------: | -------------: | ---------------: | ---------------: |
|      50 |          7% |          2.7% |           28% |          57 MB |            46 MB |            74 MB |
|     100 |      10–11% |        4.6–5% |           63% |          61 MB |            46 MB |            97 MB |
|     200 |         16% |            8% |          137% |          69 MB |            48 MB |           136 MB |

All three kept 30 Ticks per second throughout. What crossed the loopback, both directions together, headers included:

| Clients | ticknet                 | WebSocket               | geckos.io                |
| ------: | ----------------------- | ----------------------- | ------------------------ |
|     100 | 1.9 MiB/s, 6,000 pkt/s  | 2.2 MiB/s, 11,500 pkt/s | 5.4 MiB/s, 26,300 pkt/s  |
|     200 | 6.8 MiB/s, 12,200 pkt/s | 7.8 MiB/s, 31,100 pkt/s | 19.2 MiB/s, 85,700 pkt/s |

### Latency

With 100 Clients, in milliseconds.

**World snapshots**, from the Server to each Client: p50 / p99 / max, then the share delivered.

| Profile | ticknet               | WebSocket             | geckos.io                |
| ------- | --------------------- | --------------------- | ------------------------ |
| clean   | 0.6 / 1.9 / 4.7, 100% | 0.3 / 1.4 / 3.1, 100% | 1.1 / 3.3 / 7.9, 100%    |
| wan     | 31 / 42 / 48, 99%     | 31 / 116 / 235, 100%  | 31 / 42 / 57, 99%        |
| bad     | 60 / 91 / 113, 90%    | 88 / 382 / 735, 100%  | 171 / 1,100 / 1,521, 73% |

**Bot positions**, from each Client to the Server: p50 / p99.

| Profile | ticknet  | WebSocket | geckos.io |
| ------- | -------- | --------- | --------- |
| clean   | 18 / 33  | 0.0 / 0.6 | 0.1 / 2.4 |
| wan     | 47 / 69  | 30 / 109  | 30 / 42   |
| bad     | 76 / 114 | 69 / 328  | 60 / 95   |

**Chat lines**, from the speaking bot to every Client through the Server: p50 / p99 / max. Every transport delivered all of them; geckos.io delivered 596 out of order on the wan profile and 2,603 on the bad one.

| Profile | ticknet        | WebSocket       | geckos.io           |
| ------- | -------------- | --------------- | ------------------- |
| clean   | 16 / 34 / 34   | 0.2 / 0.9 / 1.5 | 1.2 / 3.3 / 4.7     |
| wan     | 47 / 140 / 325 | 31 / 118 / 241  | 31 / 174 / 338      |
| bad     | 80 / 337 / 966 | 93 / 393 / 745  | 211 / 1,122 / 1,514 |

### Reading the results

- **Loss is where ticknet earns its keep.** Over TCP, one lost packet holds back everything sent after it until it is resent, so a WebSocket's world snapshots arrive late in bursts: four times ticknet's p99 on the bad profile. geckos.io sends its Unreliable messages over SCTP, whose congestion control most likely still slows them down when packets are lost: on the bad profile a quarter of its snapshots never arrive, and those that do are a second late at p99.
- **Sequenced trades completeness for freshness.** On the bad profile, ticknet delivered 90% of the snapshots: 5% were lost, and about 5% more arrived after a newer one and were dropped. netem's jitter reorders far more packets than a real link does, so expect fewer drops in practice.
- **Batching costs up to one Tick.** A Client's Message waits for its next Send step, and a Server's reply waits for the end of the Tick: about 17 ms on average at 30 per second, 33 ms at most. That is the whole gap with the other two on a clean link, and why ticknet's positions and chat are slower on the wan profile. World snapshots do not pay it, since the Tick listener sends them as the Tick ends. A higher `sendRate` on the Client, or `tickRate` on the Server, shortens the wait at the cost of more Datagrams.
- **Resends also follow the Tick.** A Reliable Message is resent at the first Tick after a round trip plus four times its variation, as TCP would, so a chat line lost twice can take close to a second on the bad profile.
- **The Server's CPU** goes for a third to the system call that sends each Tick's Datagrams (`sendMany`), the rest spread over the protocol: building Datagrams, acknowledgements, resends. Bun's WebSockets do the same work in native code; geckos.io runs a full WebRTC stack, with encryption, for every Client.
- **ticknet is the leanest on the wire**: one Datagram per Tick in each direction for each Client, half the packets of a WebSocket and a quarter of geckos.io's.

### Limits of these figures

- The bots run on the same 8 cores as the Server, and the loopback skips what a real network card costs the kernel.
- Latencies come from one run per cell; only the CPU figures were repeated.
- The geckos.io bots run on node-datachannel, not in a browser.
- geckos.io encrypts its traffic and ticknet v1 does not (see [Limits of v1](#limits-of-v1)), which accounts for part of its CPU.

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
